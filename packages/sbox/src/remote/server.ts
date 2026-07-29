/**
 * Foreground authenticated HTTP + WebSocket server over an injected Host.
 *
 * Does not load project YAML or interpret CLI profile policy.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Host } from "../host.js";
import { SboxError, isSboxError, isAbortError } from "../errors.js";
import { assertProjectId, assertSandboxIdentity } from "../identity.js";
import { createRedactingLogger, safeLog, silentLogger, type Logger } from "../logging.js";
import { authorizeBearer } from "./auth.js";
import { decodeTransferArchive, encodeTransferArchive } from "./archive-wire.js";
import { bytesToBase64, encodeProcessResult, base64ToBytes } from "./bytes.js";
import {
  collectedExecSchema,
  createRequestSchema,
  ensureImageMetaSchema,
  ensureVolumeRequestSchema,
  listImagesQuerySchema,
  listSandboxesQuerySchema,
  removeImageBodySchema,
  removeVolumeRequestSchema,
  sessionControlSchema,
  sessionStartSchema,
  transferMetaSchema,
  volumeShellRequestSchema,
} from "./dto.js";
import { resolveRemoteLimits, type RemoteLimits } from "./limits.js";
import { createStdinBridge, type StdinBridge } from "./stdin-bridge.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeArchive, packHostPath, removeMaterialized } from "./materialize.js";
import {
  materializeClientMountStages,
  removeDirectoryStageGeneration,
  removeDirectoryStages,
} from "../directory/stages.js";
import { assertBindablePath } from "../directory/assert-directory.js";
import { assertHostMounts } from "../directory/validate.js";
import { expandHomePrefix } from "../directory/home-path.js";
import type { HostMount } from "../directory/types.js";
import { requireDockerPlatform } from "../image/platform.js";
import {
  SBOX_PROTOCOL_VERSION,
  httpStatusForError,
  toErrorResponse,
  type HealthResponse,
  type HandshakeResponse,
} from "./protocol.js";
import type { ProcessSession, PtySession } from "../process/session.js";

export interface SboxServerOptions {
  readonly host: Host;
  readonly bearerToken: string;
  readonly bind?: string;
  readonly port?: number;
  /** Required when bind is not loopback (`127.0.0.1`, `::1`, `localhost`). */
  readonly allowNonLoopback?: boolean;
  readonly limits?: Partial<RemoteLimits>;
  readonly logger?: Logger;
}

export interface SboxServer extends AsyncDisposable {
  readonly url: string;
  readonly port: number;
  readonly bind: string;
  close(): Promise<void>;
}

function isLoopbackBind(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

function clampOutputBytes(requested: number | undefined, serverMax: number): number {
  return Math.min(requested ?? serverMax, serverMax);
}

export async function createSboxServer(options: SboxServerOptions): Promise<SboxServer> {
  const limits = resolveRemoteLimits(options.limits);
  const logger = options.logger ? createRedactingLogger(options.logger) : silentLogger;
  const bind = options.bind ?? "127.0.0.1";
  if (!isLoopbackBind(bind)) {
    if (options.allowNonLoopback !== true) {
      throw SboxError.validation(
        "Non-loopback bind requires explicit allowNonLoopback (or --allow-non-loopback).",
        { details: { bind, path: "bind" } },
      );
    }
    safeLog(logger, {
      level: "warn",
      message: "sbox serve bound to a non-loopback address; HTTP is unencrypted.",
      details: { bind },
    });
  }

  const state = {
    shuttingDown: false,
    processes: 0,
    builds: 0,
    activeCancels: new Set<() => void>(),
  };

  const httpServer: Server = createServer((req, res) => {
    void handleHttp(req, res).catch((error) => {
      writeError(res, error);
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  httpServer.on("upgrade", (req, socket, head) => {
    if (state.shuttingDown) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    try {
      authorizeBearer(req, options.bearerToken);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/session") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      void handleSession(ws).catch((error) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(toErrorResponse(error)));
          ws.close();
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, bind, () => resolve());
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw SboxError.internal("Failed to resolve sbox server listen address.");
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      const body: HealthResponse = { ok: true, protocolVersion: SBOX_PROTOCOL_VERSION };
      writeJson(res, 200, body);
      return;
    }

    if (state.shuttingDown) {
      throw SboxError.busy("Server is shutting down.");
    }

    authorizeBearer(req, options.bearerToken);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), limits.maxDurationMs);
    const cancel = (): void => {
      clearTimeout(timer);
      ac.abort();
    };
    state.activeCancels.add(cancel);
    try {
      await handleAuthenticated(req, res, url, ac.signal);
      safeLog(logger, {
        level: "info",
        message: "request",
        details: { method: req.method ?? "GET", path: url.pathname, status: res.statusCode },
      });
    } catch (error) {
      if (ac.signal.aborted && !state.shuttingDown) {
        throw SboxError.timeout("Operation exceeded the configured maxDurationMs limit.", {
          details: { maxDurationMs: limits.maxDurationMs },
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      state.activeCancels.delete(cancel);
    }
  }

  async function handleAuthenticated(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      req.method === "GET" &&
      (url.pathname === "/v1/handshake" || url.pathname === "/v1/capabilities")
    ) {
      const capabilities = await options.host.capabilities({ signal });
      const body: HandshakeResponse = {
        protocolVersion: SBOX_PROTOCOL_VERSION,
        capabilities,
      };
      writeJson(res, 200, body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/sandboxes") {
      const metaHeader = req.headers["x-sbox-create-request"];
      if (typeof metaHeader !== "string") {
        throw SboxError.validation("Missing x-sbox-create-request header.");
      }
      const body = createRequestSchema.parse(
        JSON.parse(Buffer.from(metaHeader, "base64url").toString("utf8")),
      );
      const archiveBuf = await readBody(req, limits.maxArchiveBytes);
      const archive = decodeTransferArchive(archiveBuf);
      const identity = assertSandboxIdentity(body.identity);
      // bindHostPath is server-only staging metadata; never accepted from the wire.
      const mountsIn: HostMount[] = [];
      for (let i = 0; i < (body.mounts ?? []).length; i += 1) {
        const entry = body.mounts![i]!;
        let kind = entry.kind;
        if (entry.source === "host") {
          const resolved = await assertBindablePath(
            expandHomePrefix(entry.path),
            `mounts.${i}.path`,
          );
          if (kind !== undefined && kind !== resolved) {
            throw SboxError.validation(
              `Host mount kind mismatch (declared ${kind}, found ${resolved}).`,
              { details: { path: `mounts.${i}.kind` } },
            );
          }
          kind = resolved;
        }
        mountsIn.push({
          source: entry.source,
          path: entry.path,
          mount: entry.mount,
          readonly: entry.readonly,
          ...(kind !== undefined ? { kind } : {}),
          ...(entry.quotaMiB !== undefined ? { quotaMiB: entry.quotaMiB } : {}),
          ...(entry.followEscapingSymlinks === true ? { followEscapingSymlinks: true } : {}),
          ...(entry.mode === "copy" ? { mode: "copy" as const } : {}),
        });
      }
      assertHostMounts(mountsIn, body.volumes);
      let staged: readonly HostMount[] = mountsIn;
      let generationRoot: string | undefined;
      if (mountsIn.some((entry) => entry.source === "client")) {
        const materialized = await materializeClientMountStages({
          identity,
          mounts: mountsIn,
          archive,
          signal,
        });
        staged = materialized.mounts;
        generationRoot = materialized.generationRoot;
      }
      const request = {
        identity,
        image: body.image,
        ...(body.cpus !== undefined ? { cpus: body.cpus } : {}),
        ...(body.memoryMiB !== undefined ? { memoryMiB: body.memoryMiB } : {}),
        ...(body.tmpMiB !== undefined ? { tmpMiB: body.tmpMiB } : {}),
        ...(body.rootMiB !== undefined ? { rootMiB: body.rootMiB } : {}),
        ...(body.workdir !== undefined ? { workdir: body.workdir } : {}),
        ...(body.user !== undefined ? { user: body.user } : {}),
        ...(body.shell !== undefined ? { shell: body.shell } : {}),
        ...(body.hostname !== undefined ? { hostname: body.hostname } : {}),
        ...(body.env !== undefined ? { env: body.env } : {}),
        ...(body.maxDurationSecs !== undefined ? { maxDurationSecs: body.maxDurationSecs } : {}),
        ...(body.idleTimeoutSecs !== undefined ? { idleTimeoutSecs: body.idleTimeoutSecs } : {}),
        ...(body.network !== undefined ? { network: body.network } : {}),
        ...(body.secrets !== undefined ? { secrets: body.secrets } : {}),
        ...(body.volumes !== undefined ? { volumes: body.volumes } : {}),
        ...(staged.length > 0 ? { mounts: staged } : {}),
      } as import("../types.js").HostCreateRequest;
      let inspection;
      try {
        inspection = await options.host.create(request, { signal });
      } catch (error) {
        if (generationRoot !== undefined) {
          await removeDirectoryStageGeneration(generationRoot);
        }
        throw error;
      }
      writeJson(res, 200, inspection);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/sandboxes") {
      const query = listSandboxesQuerySchema.parse({
        project: url.searchParams.get("project") ?? undefined,
      });
      const list = await options.host.list(
        query.project !== undefined
          ? { project: assertProjectId(query.project), signal }
          : { signal },
      );
      writeJson(res, 200, { sandboxes: list });
      return;
    }

    const sandboxMatch = /^\/v1\/sandboxes\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(start|stop))?$/.exec(
      url.pathname,
    );
    if (sandboxMatch) {
      const identity = assertSandboxIdentity({
        project: decodeURIComponent(sandboxMatch[1]!),
        profile: decodeURIComponent(sandboxMatch[2]!),
        instance: decodeURIComponent(sandboxMatch[3]!),
      });
      const action = sandboxMatch[4];
      if (req.method === "GET" && action === undefined) {
        writeJson(res, 200, await options.host.inspect(identity, { signal }));
        return;
      }
      if (req.method === "POST" && action === "start") {
        writeJson(res, 200, await options.host.start(identity, { signal }));
        return;
      }
      if (req.method === "POST" && action === "stop") {
        writeJson(res, 200, await options.host.stop(identity, { signal }));
        return;
      }
      if (req.method === "DELETE" && action === undefined) {
        await options.host.remove(identity, { signal });
        await removeDirectoryStages(identity);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/v1/images") {
      const query = listImagesQuerySchema.parse({
        includeUnowned: url.searchParams.get("includeUnowned") ?? undefined,
      });
      const images = await options.host.listImages(
        query.includeUnowned ? { includeUnowned: true, signal } : { signal },
      );
      writeJson(res, 200, { images });
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/v1/images") {
      const body = removeImageBodySchema.parse(await readJson(req, limits.maxRequestBytes));
      await options.host.removeImage(body.reference, {
        ...(body.force !== undefined ? { force: body.force } : {}),
        signal,
      });
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/images/stale-workspaces") {
      const workspaces = await options.host.listStaleImageWorkspaces({ signal });
      writeJson(res, 200, { workspaces });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/images/ensure") {
      if (state.builds >= limits.maxConcurrentBuilds) {
        throw SboxError.busy("Too many concurrent image builds.");
      }
      state.builds += 1;
      const cancel = { aborted: false };
      const onCancel = (): void => {
        cancel.aborted = true;
      };
      state.activeCancels.add(onCancel);
      try {
        const metaHeader = req.headers["x-sbox-image-request"];
        if (typeof metaHeader !== "string") {
          throw SboxError.validation("Missing x-sbox-image-request header.");
        }
        const meta = ensureImageMetaSchema.parse(
          JSON.parse(Buffer.from(metaHeader, "base64url").toString("utf8")),
        );
        const archiveBuf = await readBody(req, limits.maxArchiveBytes);
        const archive = decodeTransferArchive(archiveBuf);
        const contextRoot = await materializeArchive(archive);
        try {
          const wantNdjson = (req.headers.accept ?? "").includes("application/x-ndjson");
          if (wantNdjson) {
            res.writeHead(200, {
              "content-type": "application/x-ndjson",
              "cache-control": "no-store",
            });
          }
          const platform = requireDockerPlatform(await options.host.capabilities({ signal }));
          const inspection = await options.host.ensureImage(
            {
              contextRoot,
              dockerfile: meta.dockerfile,
              // Host-advertised platform wins over Client-supplied meta.platform.
              platform,
              args: meta.args,
              secrets: meta.secrets,
              includeGit: meta.includeGit,
              ...(meta.target !== undefined ? { target: meta.target } : {}),
              ...(meta.force !== undefined ? { force: meta.force } : {}),
            },
            {
              signal,
              ...(wantNdjson
                ? {
                    onProgress: (event: { type: "phase"; phase: string; reference?: string }) => {
                      res.write(`${JSON.stringify(event)}\n`);
                    },
                  }
                : {}),
            },
          );
          if (wantNdjson) {
            res.write(`${JSON.stringify({ type: "result", inspection })}\n`);
            res.end();
          } else {
            writeJson(res, 200, inspection);
          }
        } finally {
          await removeMaterialized(contextRoot);
        }
      } finally {
        state.activeCancels.delete(onCancel);
        state.builds -= 1;
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/volumes") {
      const project = url.searchParams.get("project");
      if (project === null) {
        throw SboxError.validation("project query parameter is required.");
      }
      const volumes = await options.host.listVolumes(
        {
          project: assertProjectId(project),
        },
        { signal },
      );
      writeJson(res, 200, { volumes });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/volumes/ensure") {
      const body = ensureVolumeRequestSchema.parse(await readJson(req, limits.maxRequestBytes));
      writeJson(
        res,
        200,
        await options.host.ensureVolume(
          {
            project: assertProjectId(body.project),
            volume: body.volume,
            sizeBytes: body.sizeBytes,
          },
          { signal },
        ),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/volumes/remove") {
      const body = removeVolumeRequestSchema.parse(await readJson(req, limits.maxRequestBytes));
      await options.host.removeVolume(
        {
          project: assertProjectId(body.project),
          volume: body.volume,
        },
        { signal },
      );
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/volumes/shell") {
      const body = volumeShellRequestSchema.parse(await readJson(req, limits.maxRequestBytes));
      writeJson(
        res,
        200,
        await options.host.volumeShell(
          {
            project: assertProjectId(body.project),
            volume: body.volume,
            sizeBytes: body.sizeBytes,
            profile: body.profile,
            image: body.image,
            path: body.path,
            ...(body.cpus !== undefined ? { cpus: body.cpus } : {}),
            ...(body.memoryMiB !== undefined ? { memoryMiB: body.memoryMiB } : {}),
            ...(body.workdir !== undefined ? { workdir: body.workdir } : {}),
            ...(body.user !== undefined ? { user: body.user } : {}),
            ...(body.shell !== undefined ? { shell: body.shell } : {}),
            ...(body.hostname !== undefined ? { hostname: body.hostname } : {}),
            ...(body.env !== undefined ? { env: body.env } : {}),
            ...(body.maxDurationSecs !== undefined
              ? { maxDurationSecs: body.maxDurationSecs }
              : {}),
            ...(body.idleTimeoutSecs !== undefined
              ? { idleTimeoutSecs: body.idleTimeoutSecs }
              : {}),
          },
          { signal },
        ),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/exec/argv") {
      const body = collectedExecSchema.parse(await readJson(req, limits.maxRequestBytes));
      if (body.argv === undefined) {
        throw SboxError.validation("argv is required.");
      }
      const result = await options.host.execArgv(
        { identity: assertSandboxIdentity(body.identity), argv: body.argv },
        {
          ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
          ...(body.env !== undefined ? { env: body.env } : {}),
          ...(body.user !== undefined ? { user: body.user } : {}),
          ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
          ...(body.stdin !== undefined ? { stdin: base64ToBytes(body.stdin) } : {}),
          stdoutMaxBytes: clampOutputBytes(body.maxStdoutBytes, limits.maxStdoutBytes),
          stderrMaxBytes: clampOutputBytes(body.maxStderrBytes, limits.maxStderrBytes),
          signal,
        },
      );
      writeJson(res, 200, encodeProcessResult(result));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/exec/shell") {
      const body = collectedExecSchema.parse(await readJson(req, limits.maxRequestBytes));
      if (body.script === undefined) {
        throw SboxError.validation("script is required.");
      }
      const result = await options.host.execShell(
        {
          identity: assertSandboxIdentity(body.identity),
          script: body.script,
          ...(body.shell !== undefined ? { shell: body.shell } : {}),
        },
        {
          ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
          ...(body.env !== undefined ? { env: body.env } : {}),
          ...(body.user !== undefined ? { user: body.user } : {}),
          ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
          ...(body.stdin !== undefined ? { stdin: base64ToBytes(body.stdin) } : {}),
          stdoutMaxBytes: clampOutputBytes(body.maxStdoutBytes, limits.maxStdoutBytes),
          stderrMaxBytes: clampOutputBytes(body.maxStderrBytes, limits.maxStderrBytes),
          signal,
        },
      );
      writeJson(res, 200, encodeProcessResult(result));
      return;
    }

    if (req.method === "PUT" && url.pathname === "/v1/transfer/host-to-guest") {
      const metaHeader = req.headers["x-sbox-transfer"];
      if (typeof metaHeader !== "string") {
        throw SboxError.validation("Missing x-sbox-transfer header.");
      }
      const meta = transferMetaSchema.parse(
        JSON.parse(Buffer.from(metaHeader, "base64url").toString("utf8")),
      );
      const archiveBuf = await readBody(req, limits.maxArchiveBytes);
      const archive = decodeTransferArchive(archiveBuf);
      const hostPath = await materializeArchive(archive);
      try {
        await options.host.copyHostToGuest(
          {
            identity: assertSandboxIdentity(meta.identity),
            hostPath,
            guestPath: meta.guestPath,
          },
          {
            ...(meta.overwrite !== undefined ? { overwrite: meta.overwrite } : {}),
            signal,
          },
        );
      } finally {
        await removeMaterialized(hostPath);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/transfer/guest-to-host") {
      const meta = transferMetaSchema.parse(await readJson(req, limits.maxRequestBytes));
      const tmp = await mkdtemp(join(tmpdir(), "sbox-remote-out-"));
      const dest = join(tmp, "payload");
      try {
        await options.host.copyGuestToHost(
          {
            identity: assertSandboxIdentity(meta.identity),
            hostPath: dest,
            guestPath: meta.guestPath,
          },
          { overwrite: "replace", signal },
        );
        const archive = await packHostPath(dest);
        const buf = encodeTransferArchive(archive);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": buf.byteLength,
        });
        res.end(buf);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
      return;
    }

    throw SboxError.notFound("Route was not found.");
  }

  async function handleSession(ws: WebSocket): Promise<void> {
    if (state.processes >= limits.maxConcurrentProcesses) {
      throw SboxError.busy("Too many concurrent processes.");
    }
    state.processes += 1;
    const ac = new AbortController();
    const durationTimer = setTimeout(() => ac.abort(), limits.maxDurationMs);
    const cancel = (): void => {
      clearTimeout(durationTimer);
      ac.abort();
    };
    state.activeCancels.add(cancel);
    let session: ProcessSession | PtySession | undefined;
    let mode: "process" | "pty" | undefined;
    let sessionReady = false;
    let cleaned = false;
    let stdinBridge: StdinBridge | undefined;

    type Frame = { readonly data: RawData; readonly isBinary: boolean };
    const pendingFrames: Frame[] = [];
    let startFrame: Frame | undefined;
    let startNotify: (() => void) | undefined;

    const cleanup = async (): Promise<void> => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      clearTimeout(durationTimer);
      state.activeCancels.delete(cancel);
      state.processes -= 1;
      stdinBridge?.end();
      if (session !== undefined) {
        try {
          await session.cancel("disconnect");
        } catch {
          // ignore
        }
        try {
          await session[Symbol.asyncDispose]();
        } catch {
          // ignore
        }
      }
    };

    ws.on("close", () => {
      void cleanup();
    });

    const handleClientFrame = async (data: RawData, isBinary: boolean): Promise<void> => {
      if (session === undefined) {
        return;
      }
      if (isBinary) {
        const bytes = rawToBuffer(data);
        if (mode === "pty") {
          await (session as PtySession).write(bytes);
        } else if (stdinBridge !== undefined) {
          await stdinBridge.push(new Uint8Array(bytes));
        } else {
          await (session as ProcessSession).stdin.write(bytes);
        }
        return;
      }
      const control = sessionControlSchema.parse(JSON.parse(String(rawToBuffer(data))));
      if (control.type === "stdin_end") {
        if (mode === "process") {
          if (stdinBridge !== undefined) {
            stdinBridge.end();
          } else {
            await (session as ProcessSession).stdin.end();
          }
        }
        return;
      }
      if (control.type === "cancel") {
        await session.cancel(control.reason);
        return;
      }
      if (control.type === "complete") {
        const completable = session as PtySession & { complete?: () => Promise<void> };
        if (typeof completable.complete === "function") {
          await completable.complete();
        }
        return;
      }
      if (control.type === "resize" && mode === "pty") {
        await (session as PtySession).resize({ rows: control.rows, cols: control.cols });
      }
    };

    // Attach before awaiting host.pty / stream so early client frames are queued
    // rather than dropped (ws does not buffer without a listener).
    ws.on("message", (data, isBinary) => {
      if (startFrame === undefined) {
        startFrame = { data, isBinary };
        startNotify?.();
        return;
      }
      if (!sessionReady) {
        pendingFrames.push({ data, isBinary });
        return;
      }
      void handleClientFrame(data, isBinary).catch((error) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(toErrorResponse(error)));
        }
      });
    });

    try {
      const startRaw = await waitQueuedStartFrame(
        () => startFrame,
        (notify) => {
          startNotify = notify;
        },
        limits.sessionStartTimeoutMs,
        ws,
      );
      if (startRaw.isBinary) {
        throw SboxError.validation("Session start frame must be JSON text.");
      }
      const start = sessionStartSchema.parse(JSON.parse(String(rawToBuffer(startRaw.data))));
      const identity = assertSandboxIdentity(start.identity);
      safeLog(logger, {
        level: "info",
        message: "session.start",
        details: { kind: start.kind },
      });

      if (start.kind === "pty") {
        mode = "pty";
        session = await options.host.pty(
          { identity, argv: start.argv },
          {
            ...(start.cwd !== undefined ? { cwd: start.cwd } : {}),
            ...(start.env !== undefined ? { env: start.env } : {}),
            ...(start.user !== undefined ? { user: start.user } : {}),
            ...(start.timeoutMs !== undefined ? { timeoutMs: start.timeoutMs } : {}),
            ...(start.rows !== undefined ? { rows: start.rows } : {}),
            ...(start.cols !== undefined ? { cols: start.cols } : {}),
            signal: ac.signal,
          },
        );
        sessionReady = true;
        for (const frame of pendingFrames.splice(0)) {
          await handleClientFrame(frame.data, frame.isBinary);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ready" }));
        }
        const pty = session;
        void (async () => {
          const pump = (async () => {
            for await (const chunk of pty.output) {
              await sendBinaryBounded(ws, Buffer.from(chunk), limits.wsSendBufferBound);
            }
          })();
          // Sink rejections immediately — cancel can close the output queue before
          // wait() settles, and an unhandled pump rejection kills the process.
          const pumpSettled = pump.catch(() => undefined);
          try {
            const settled = await pty.wait();
            await Promise.race([pumpSettled, delay(limits.outputFlushMs)]);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "exited",
                  exitCode: settled.exitCode,
                  signal: settled.signal,
                }),
              );
              ws.close();
            }
          } catch (error) {
            await Promise.race([pumpSettled, delay(limits.outputFlushMs)]);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(toErrorResponse(error)));
              ws.close();
            }
          }
        })();
      } else {
        mode = "process";
        stdinBridge = createStdinBridge();
        const streamOptions = {
          ...(start.cwd !== undefined ? { cwd: start.cwd } : {}),
          ...(start.env !== undefined ? { env: start.env } : {}),
          ...(start.user !== undefined ? { user: start.user } : {}),
          ...(start.timeoutMs !== undefined ? { timeoutMs: start.timeoutMs } : {}),
          signal: ac.signal,
          stdin: stdinBridge.iterable,
        };
        session =
          start.kind === "argv"
            ? await options.host.execArgvStream({ identity, argv: start.argv }, streamOptions)
            : await options.host.execShellStream(
                {
                  identity,
                  script: start.script,
                  ...(start.shell !== undefined ? { shell: start.shell } : {}),
                },
                streamOptions,
              );
        sessionReady = true;
        for (const frame of pendingFrames.splice(0)) {
          await handleClientFrame(frame.data, frame.isBinary);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ready" }));
        }
        const proc = session;
        void (async () => {
          const pump = (async () => {
            for await (const event of proc) {
              if (event.type === "stdout" || event.type === "stderr") {
                await sendJsonBounded(
                  ws,
                  {
                    type: event.type,
                    data: bytesToBase64(event.data),
                  },
                  limits.wsSendBufferBound,
                );
              } else {
                await sendJsonBounded(ws, event, limits.wsSendBufferBound);
              }
            }
          })();
          const pumpSettled = pump.catch(() => undefined);
          try {
            const settled = await proc.wait();
            await Promise.race([pumpSettled, delay(limits.outputFlushMs)]);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "exited",
                  exitCode: settled.exitCode,
                  signal: settled.signal,
                }),
              );
              ws.close();
            }
          } catch (error) {
            await Promise.race([pumpSettled, delay(limits.outputFlushMs)]);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(toErrorResponse(error)));
              ws.close();
            }
          }
        })();
      }
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async function close(): Promise<void> {
    state.shuttingDown = true;
    for (const cancel of state.activeCancels) {
      cancel();
    }
    const deadline = Date.now() + limits.shutdownWaitMs;
    while (sockets.size > 0 && Date.now() < deadline) {
      await delay(25);
    }
    for (const ws of sockets) {
      ws.terminate();
    }
    sockets.clear();
    await Promise.race([
      new Promise<void>((resolve) => {
        wss.close(() => resolve());
      }),
      delay(Math.max(0, deadline - Date.now())),
    ]);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return {
    url: `http://${bind === "::" ? "[::]" : bind}:${address.port}`,
    port: address.port,
    bind,
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.byteLength,
  });
  res.end(payload);
}

function writeError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const sbox = isSboxError(error)
    ? error
    : isAbortError(error)
      ? SboxError.cancellation("Request was cancelled.")
      : SboxError.internal("An internal sbox error occurred.", { cause: error });
  writeJson(res, httpStatusForError(sbox), toErrorResponse(sbox));
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const buf = await readBody(req, maxBytes);
  if (buf.byteLength === 0) {
    return {};
  }
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (error) {
    throw SboxError.validation("Request JSON was malformed.", { cause: error });
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw SboxError.outputLimit("Request body exceeds the configured limit.", {
        details: { maxBytes },
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

async function waitQueuedStartFrame(
  getStart: () => { readonly data: RawData; readonly isBinary: boolean } | undefined,
  setNotify: (notify: (() => void) | undefined) => void,
  timeoutMs: number,
  ws: WebSocket,
): Promise<{ readonly data: RawData; readonly isBinary: boolean }> {
  const existing = getStart();
  if (existing !== undefined) {
    return existing;
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        SboxError.timeout("Timed out waiting for WebSocket session start.", {
          details: { timeoutMs },
        }),
      );
    }, timeoutMs);
    const onClose = (): void => {
      cleanup();
      reject(SboxError.transport("WebSocket closed before session start."));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(SboxError.transport("WebSocket error before session start.", { cause: error }));
    };
    const onReady = (): void => {
      const frame = getStart();
      if (frame === undefined) {
        return;
      }
      cleanup();
      resolve(frame);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      setNotify(undefined);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    setNotify(onReady);
    ws.once("close", onClose);
    ws.once("error", onError);
    const raced = getStart();
    if (raced !== undefined) {
      cleanup();
      resolve(raced);
    }
  });
}

async function sendBinaryBounded(ws: WebSocket, payload: Buffer, bound: number): Promise<void> {
  while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > bound) {
    await delay(1);
  }
  if (ws.readyState !== WebSocket.OPEN) {
    throw SboxError.transport("WebSocket closed before send.");
  }
  ws.send(payload, { binary: true });
}

async function sendJsonBounded(ws: WebSocket, payload: unknown, bound: number): Promise<void> {
  while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > bound) {
    await delay(1);
  }
  if (ws.readyState !== WebSocket.OPEN) {
    throw SboxError.transport("WebSocket closed before send.");
  }
  ws.send(JSON.stringify(payload));
}
