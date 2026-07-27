/**
 * RemoteHost: Host contract over authenticated HTTP + WebSocket.
 */

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import type {
  Host,
  HostCopyPaths,
  HostExecArgvRequest,
  HostExecShellRequest,
  HostPtyRequest,
} from "../host.js";
import { SboxError, isAbortError, throwIfAborted } from "../errors.js";
import type {
  HostEnsureImageOptions,
  HostEnsureImageRequest,
  HostImageInspection,
  HostImageSummary,
  HostListImagesOptions,
  HostListStaleImageWorkspacesOptions,
  HostRemoveImageOptions,
  StaleImageWorkspace,
} from "../image/types.js";
import { createRedactingLogger, safeLog, silentLogger, type Logger } from "../logging.js";
import type {
  HostCollectedExecOptions,
  HostPtyOptions,
  HostStreamingExecOptions,
  ProcessSession,
  ProcessStdin,
  PtySession,
  PtySize,
} from "../process/session.js";
import type { HostCopyOptions } from "../transfer/types.js";
import type {
  HostCapabilities,
  HostCreateRequest,
  HostListOptions,
  OperationOptions,
  ProcessEvent,
  ProcessResult,
  SandboxInspection,
  SandboxSummary,
} from "../types.js";
import type {
  HostEnsureVolumeRequest,
  HostListVolumesRequest,
  HostRemoveVolumeRequest,
  HostVolumeInspection,
  HostVolumeShellRequest,
  HostVolumeSummary,
} from "../volume/types.js";
import { BoundedAsyncQueue, DEFAULT_STREAM_QUEUE_CAPACITY } from "../process/bounded-queue.js";
import { packClientMountArchive } from "../directory/stages.js";
import { assertHostMounts } from "../directory/validate.js";
import { decodeTransferArchive, encodeTransferArchive } from "./archive-wire.js";
import { bytesToBase64, decodeProcessResult, encodeProcessResult, base64ToBytes } from "./bytes.js";
import { resolveRemoteLimits, type RemoteLimits } from "./limits.js";
import { materializeArchive, packHostPath, removeMaterialized } from "./materialize.js";
import { assertProtocolVersion, errorFromWire, type HandshakeResponse } from "./protocol.js";

export interface RemoteHostOptions {
  readonly url: string;
  readonly bearerToken: string;
  readonly logger?: Logger;
  readonly limits?: Partial<RemoteLimits>;
}

export function createRemoteHost(options: RemoteHostOptions): Host {
  return new RemoteHostImpl(options);
}

type SessionSettlement =
  | { readonly kind: "exited"; readonly exitCode: number; readonly signal: string | null }
  | { readonly kind: "error"; readonly error: SboxError };

class RemoteHostImpl implements Host {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly limits: RemoteLimits;
  private readonly logger: Logger;
  private readonly openSockets = new Set<WebSocket>();
  private handshake: HandshakeResponse | undefined;
  private disposed = false;

  constructor(options: RemoteHostOptions) {
    this.baseUrl = options.url.replace(/\/$/, "");
    this.bearerToken = options.bearerToken;
    this.limits = resolveRemoteLimits(options.limits);
    this.logger = options.logger ? createRedactingLogger(options.logger) : silentLogger;
  }

  async create(request: HostCreateRequest, options?: OperationOptions): Promise<SandboxInspection> {
    throwIfAborted(options?.signal);
    assertHostMounts(request.mounts, request.volumes);
    const wireRequest = stripBindHostPaths(request);
    const packed = await packClientMountArchive(
      wireRequest.mounts ?? [],
      options?.signal !== undefined ? { signal: options.signal } : {},
    );
    const createRequest =
      packed.mounts.length > 0 ? { ...wireRequest, mounts: packed.mounts } : wireRequest;
    const body = encodeTransferArchive(packed.archive);
    const response = await this.fetchRaw(
      "POST",
      "/v1/sandboxes",
      body,
      {
        "content-type": "application/octet-stream",
        "x-sbox-create-request": Buffer.from(JSON.stringify(createRequest), "utf8").toString(
          "base64url",
        ),
      },
      options?.signal,
    );
    return (await response.json()) as SandboxInspection;
  }

  async get(
    identity: HostCreateRequest["identity"],
    options?: OperationOptions,
  ): Promise<SandboxInspection> {
    return this.inspect(identity, options);
  }

  async list(options?: HostListOptions): Promise<readonly SandboxSummary[]> {
    const q =
      options?.project !== undefined ? `?project=${encodeURIComponent(options.project)}` : "";
    const body = await this.json<{ sandboxes: SandboxSummary[] }>(
      "GET",
      `/v1/sandboxes${q}`,
      undefined,
      options?.signal,
    );
    return body.sandboxes;
  }

  async inspect(
    identity: HostCreateRequest["identity"],
    options?: OperationOptions,
  ): Promise<SandboxInspection> {
    return this.json(
      "GET",
      `/v1/sandboxes/${enc(identity.project)}/${enc(identity.profile)}/${enc(identity.instance)}`,
      undefined,
      options?.signal,
    );
  }

  async start(
    identity: HostCreateRequest["identity"],
    options?: OperationOptions,
  ): Promise<SandboxInspection> {
    return this.json(
      "POST",
      `/v1/sandboxes/${enc(identity.project)}/${enc(identity.profile)}/${enc(identity.instance)}/start`,
      {},
      options?.signal,
    );
  }

  async stop(
    identity: HostCreateRequest["identity"],
    options?: OperationOptions,
  ): Promise<SandboxInspection> {
    return this.json(
      "POST",
      `/v1/sandboxes/${enc(identity.project)}/${enc(identity.profile)}/${enc(identity.instance)}/stop`,
      {},
      options?.signal,
    );
  }

  async remove(identity: HostCreateRequest["identity"], options?: OperationOptions): Promise<void> {
    await this.json(
      "DELETE",
      `/v1/sandboxes/${enc(identity.project)}/${enc(identity.profile)}/${enc(identity.instance)}`,
      undefined,
      options?.signal,
    );
  }

  async capabilities(options?: OperationOptions): Promise<HostCapabilities> {
    const hs = await this.ensureHandshake(options?.signal);
    return hs.capabilities;
  }

  async ensureImage(
    request: HostEnsureImageRequest,
    options?: HostEnsureImageOptions,
  ): Promise<HostImageInspection> {
    throwIfAborted(options?.signal);
    const archive = await packHostPath(
      request.contextRoot,
      options?.signal !== undefined ? { signal: options.signal } : {},
    );
    const meta = {
      dockerfile: request.dockerfile,
      platform: request.platform,
      args: request.args,
      secrets: request.secrets,
      includeGit: request.includeGit,
      ...(request.target !== undefined ? { target: request.target } : {}),
      ...(request.force !== undefined ? { force: request.force } : {}),
    };
    const body = encodeTransferArchive(archive);
    const acceptNdjson = options?.onProgress !== undefined;
    const response = await this.fetchRaw(
      "POST",
      "/v1/images/ensure",
      body,
      {
        "content-type": "application/octet-stream",
        "x-sbox-image-request": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url"),
        ...(acceptNdjson ? { accept: "application/x-ndjson" } : {}),
      },
      options?.signal,
    );

    if (!acceptNdjson) {
      return (await response.json()) as HostImageInspection;
    }
    if (response.body === null) {
      throw SboxError.protocol("Remote ensureImage stream returned an empty body.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: HostImageInspection | undefined;
    const consumeLine = (line: string): void => {
      if (line.trim() === "") {
        return;
      }
      const event = JSON.parse(line) as
        | { type: "phase"; phase: string; reference?: string }
        | { type: "result"; inspection: HostImageInspection };
      if (event.type === "result") {
        result = event.inspection;
        return;
      }
      options?.onProgress?.({
        type: "phase",
        phase: event.phase as never,
        ...(event.reference !== undefined ? { reference: event.reference } : {}),
      });
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      consumeLine(buffer);
    }
    if (result === undefined) {
      throw SboxError.protocol("Remote ensureImage stream ended without a result.");
    }
    return result;
  }

  async listImages(options?: HostListImagesOptions): Promise<readonly HostImageSummary[]> {
    const q = options?.includeUnowned === true ? "?includeUnowned=true" : "";
    const body = await this.json<{ images: HostImageSummary[] }>(
      "GET",
      `/v1/images${q}`,
      undefined,
      options?.signal,
    );
    return body.images;
  }

  async removeImage(reference: string, options?: HostRemoveImageOptions): Promise<void> {
    await this.json(
      "DELETE",
      "/v1/images",
      { reference, ...(options?.force !== undefined ? { force: options.force } : {}) },
      options?.signal,
    );
  }

  async listStaleImageWorkspaces(
    options?: HostListStaleImageWorkspacesOptions,
  ): Promise<readonly StaleImageWorkspace[]> {
    const body = await this.json<{ workspaces: StaleImageWorkspace[] }>(
      "GET",
      "/v1/images/stale-workspaces",
      undefined,
      options?.signal,
    );
    return body.workspaces;
  }

  async listVolumes(
    request: HostListVolumesRequest,
    options?: OperationOptions,
  ): Promise<readonly HostVolumeSummary[]> {
    const body = await this.json<{ volumes: HostVolumeSummary[] }>(
      "GET",
      `/v1/volumes?project=${encodeURIComponent(request.project)}`,
      undefined,
      options?.signal,
    );
    return body.volumes;
  }

  async ensureVolume(
    request: HostEnsureVolumeRequest,
    options?: OperationOptions,
  ): Promise<HostVolumeInspection> {
    return this.json("POST", "/v1/volumes/ensure", request, options?.signal);
  }

  async removeVolume(request: HostRemoveVolumeRequest, options?: OperationOptions): Promise<void> {
    await this.json("POST", "/v1/volumes/remove", request, options?.signal);
  }

  async volumeShell(
    request: HostVolumeShellRequest,
    options?: OperationOptions,
  ): Promise<SandboxInspection> {
    return this.json("POST", "/v1/volumes/shell", request, options?.signal);
  }

  async execArgv(
    request: HostExecArgvRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    const raw = await this.json<ReturnType<typeof encodeProcessResult>>(
      "POST",
      "/v1/exec/argv",
      {
        identity: request.identity,
        argv: request.argv,
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.user !== undefined ? { user: options.user } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.stdin !== undefined
          ? {
              stdin:
                typeof options.stdin === "string"
                  ? bytesToBase64(new TextEncoder().encode(options.stdin))
                  : bytesToBase64(options.stdin),
            }
          : {}),
        ...(options?.stdoutMaxBytes !== undefined
          ? { maxStdoutBytes: options.stdoutMaxBytes }
          : {}),
        ...(options?.stderrMaxBytes !== undefined
          ? { maxStderrBytes: options.stderrMaxBytes }
          : {}),
      },
      options?.signal,
    );
    return decodeProcessResult(raw);
  }

  async execShell(
    request: HostExecShellRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    const raw = await this.json<ReturnType<typeof encodeProcessResult>>(
      "POST",
      "/v1/exec/shell",
      {
        identity: request.identity,
        script: request.script,
        ...(request.shell !== undefined ? { shell: request.shell } : {}),
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.user !== undefined ? { user: options.user } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.stdin !== undefined
          ? {
              stdin:
                typeof options.stdin === "string"
                  ? bytesToBase64(new TextEncoder().encode(options.stdin))
                  : bytesToBase64(options.stdin),
            }
          : {}),
        ...(options?.stdoutMaxBytes !== undefined
          ? { maxStdoutBytes: options.stdoutMaxBytes }
          : {}),
        ...(options?.stderrMaxBytes !== undefined
          ? { maxStderrBytes: options.stderrMaxBytes }
          : {}),
      },
      options?.signal,
    );
    return decodeProcessResult(raw);
  }

  async execArgvStream(
    request: HostExecArgvRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    return this.openProcessSession(
      {
        type: "start",
        kind: "argv",
        identity: request.identity,
        argv: [...request.argv],
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.user !== undefined ? { user: options.user } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      },
      options,
    );
  }

  async execShellStream(
    request: HostExecShellRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    return this.openProcessSession(
      {
        type: "start",
        kind: "shell",
        identity: request.identity,
        script: request.script,
        ...(request.shell !== undefined ? { shell: request.shell } : {}),
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.user !== undefined ? { user: options.user } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      },
      options,
    );
  }

  async pty(request: HostPtyRequest, options?: HostPtyOptions): Promise<PtySession> {
    const ws = await this.openSocket(options?.signal);
    const outputQueue = new BoundedAsyncQueue<Uint8Array>(DEFAULT_STREAM_QUEUE_CAPACITY);
    let settlement: SessionSettlement | undefined;
    const settleWaiters: Array<() => void> = [];
    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: Error) => void) | undefined;
    let readySettled = false;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const markSettled = (next: SessionSettlement): void => {
      if (settlement !== undefined) {
        return;
      }
      settlement = next;
      if (!readySettled) {
        readySettled = true;
        if (next.kind === "error") {
          readyReject?.(next.error);
        } else {
          readyResolve?.();
        }
      }
      outputQueue.close(next.kind === "error" ? next.error : undefined);
      for (const wake of settleWaiters.splice(0)) {
        wake();
      }
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        void outputQueue.push(new Uint8Array(buf));
        return;
      }
      const msg = JSON.parse(String(data)) as
        | { type: "ready" }
        | { type: "exited"; exitCode: number; signal: string | null }
        | { error: unknown };
      if ("error" in msg) {
        markSettled({ kind: "error", error: errorFromWire(msg) });
        return;
      }
      if (msg.type === "ready") {
        if (!readySettled) {
          readySettled = true;
          readyResolve?.();
        }
        return;
      }
      if (msg.type === "exited") {
        markSettled({ kind: "exited", exitCode: msg.exitCode, signal: msg.signal });
      }
    });
    ws.on("close", () => {
      markSettled({
        kind: "error",
        error: SboxError.transport("WebSocket closed before PTY exit."),
      });
    });

    ws.send(
      JSON.stringify({
        type: "start",
        kind: "pty",
        identity: request.identity,
        argv: [...request.argv],
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.user !== undefined ? { user: options.user } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.rows !== undefined ? { rows: options.rows } : {}),
        ...(options?.cols !== undefined ? { cols: options.cols } : {}),
      }),
    );

    await ready;

    if (options?.input !== undefined) {
      void (async () => {
        for await (const chunk of options.input!) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(Buffer.from(chunk), { binary: true });
          }
        }
      })();
    }

    return {
      output: {
        [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => ({
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            const result = await outputQueue.shift();
            if (result.kind === "value") {
              return { done: false, value: result.value };
            }
            if (result.error !== null) {
              throw result.error;
            }
            return { done: true, value: undefined };
          },
        }),
      },
      async write(data: Uint8Array | string): Promise<void> {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        ws.send(Buffer.from(bytes), { binary: true });
      },
      async resize(size: PtySize): Promise<void> {
        ws.send(JSON.stringify({ type: "resize", rows: size.rows, cols: size.cols }));
      },
      async wait() {
        if (settlement === undefined) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "complete" }));
          }
          await new Promise<void>((resolve) => settleWaiters.push(resolve));
        }
        const settled = settlement!;
        if (settled.kind === "error") {
          throw settled.error;
        }
        return { exitCode: settled.exitCode, signal: settled.signal };
      },
      async cancel(reason?: string): Promise<void> {
        ws.send(JSON.stringify({ type: "cancel", ...(reason !== undefined ? { reason } : {}) }));
      },
      async [Symbol.asyncDispose]() {
        try {
          ws.close();
        } catch {
          // ignore
        }
      },
    };
  }

  async copyHostToGuest(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    const archive = await packHostPath(
      request.hostPath,
      options?.signal !== undefined ? { signal: options.signal } : {},
    );
    const meta = {
      identity: request.identity,
      guestPath: request.guestPath,
      ...(options?.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
    };
    await this.fetchRaw(
      "PUT",
      "/v1/transfer/host-to-guest",
      encodeTransferArchive(archive),
      {
        "content-type": "application/octet-stream",
        "x-sbox-transfer": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url"),
      },
      options?.signal,
    );
  }

  async copyGuestToHost(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    const response = await this.fetchRaw(
      "POST",
      "/v1/transfer/guest-to-host",
      Buffer.from(
        JSON.stringify({
          identity: request.identity,
          guestPath: request.guestPath,
          ...(options?.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
        }),
        "utf8",
      ),
      { "content-type": "application/json" },
      options?.signal,
    );
    const buf = Buffer.from(await response.arrayBuffer());
    const archive = decodeTransferArchive(buf);
    const materialized = await materializeArchive(
      archive,
      options?.signal !== undefined ? { signal: options.signal } : {},
    );
    try {
      const { rename, cp, lstat, mkdir: mkdirFs } = await import("node:fs/promises");
      await mkdirFs(dirname(request.hostPath), { recursive: true });
      let dest = request.hostPath;
      const destStat = await lstat(request.hostPath).catch(() => undefined);
      const srcStat = await lstat(materialized);
      if (destStat?.isDirectory() && srcStat.isFile()) {
        const base = request.guestPath.split("/").filter(Boolean).at(-1) ?? "payload";
        dest = join(request.hostPath, base);
      }
      if (options?.overwrite === "replace") {
        await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      }
      try {
        await rename(materialized, dest);
      } catch {
        await cp(materialized, dest, { recursive: srcStat.isDirectory() });
        await removeMaterialized(materialized);
      }
    } catch (error) {
      await removeMaterialized(materialized);
      throw error;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
    for (const ws of this.openSockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.openSockets.clear();
  }

  private async openProcessSession(
    start: Record<string, unknown>,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    const ws = await this.openSocket(options?.signal);
    const events = new BoundedAsyncQueue<ProcessEvent>(DEFAULT_STREAM_QUEUE_CAPACITY);
    let settlement: SessionSettlement | undefined;
    const settleWaiters: Array<() => void> = [];
    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: Error) => void) | undefined;
    let readySettled = false;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const markSettled = (next: SessionSettlement): void => {
      if (settlement !== undefined) {
        return;
      }
      settlement = next;
      if (!readySettled) {
        readySettled = true;
        if (next.kind === "error") {
          readyReject?.(next.error);
        } else {
          readyResolve?.();
        }
      }
      events.close(next.kind === "error" ? next.error : undefined);
      for (const wake of settleWaiters.splice(0)) {
        wake();
      }
    };

    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as
        | ProcessEvent
        | { type: "ready" }
        | { type: "stdout" | "stderr"; data: string }
        | { type: "exited"; exitCode: number; signal: string | null }
        | { error: unknown };
      if ("error" in msg) {
        markSettled({ kind: "error", error: errorFromWire(msg) });
        return;
      }
      if (msg.type === "ready") {
        if (!readySettled) {
          readySettled = true;
          readyResolve?.();
        }
        return;
      }
      if (msg.type === "stdout" || msg.type === "stderr") {
        void events.push({
          type: msg.type,
          data: typeof msg.data === "string" ? base64ToBytes(msg.data) : msg.data,
        });
        return;
      }
      if (msg.type === "exited") {
        void events.push({
          type: "exited",
          exitCode: msg.exitCode,
          signal: msg.signal,
        });
        markSettled({ kind: "exited", exitCode: msg.exitCode, signal: msg.signal });
        return;
      }
      if (msg.type === "started") {
        void events.push(msg);
      }
    });
    ws.on("close", () => {
      markSettled({
        kind: "error",
        error: SboxError.transport("WebSocket closed before process exit."),
      });
    });

    ws.send(JSON.stringify(start));
    await ready;

    const stdin: ProcessStdin = {
      async write(data: Uint8Array | string): Promise<void> {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        ws.send(Buffer.from(bytes), { binary: true });
      },
      async end(): Promise<void> {
        ws.send(JSON.stringify({ type: "stdin_end" }));
      },
    };

    if (options?.stdin !== undefined) {
      void (async () => {
        for await (const chunk of options.stdin!) {
          await stdin.write(chunk);
        }
        await stdin.end();
      })();
    }

    return {
      stdin,
      [Symbol.asyncIterator](): AsyncIterator<ProcessEvent> {
        return {
          next: async (): Promise<IteratorResult<ProcessEvent>> => {
            const result = await events.shift();
            if (result.kind === "value") {
              return { done: false, value: result.value };
            }
            if (result.error !== null) {
              throw result.error;
            }
            return { done: true, value: undefined };
          },
        };
      },
      async wait() {
        if (settlement === undefined) {
          await new Promise<void>((resolve) => settleWaiters.push(resolve));
        }
        const settled = settlement!;
        if (settled.kind === "error") {
          throw settled.error;
        }
        return { exitCode: settled.exitCode, signal: settled.signal };
      },
      async cancel(reason?: string): Promise<void> {
        ws.send(JSON.stringify({ type: "cancel", ...(reason !== undefined ? { reason } : {}) }));
      },
      async [Symbol.asyncDispose]() {
        try {
          ws.close();
        } catch {
          // ignore
        }
      },
    };
  }

  private async openSocket(signal?: AbortSignal): Promise<WebSocket> {
    throwIfAborted(signal);
    if (this.disposed) {
      throw SboxError.transport("RemoteHost has been disposed.");
    }
    await this.ensureHandshake(signal);
    const url = this.baseUrl.replace(/^http/, "ws") + "/v1/session";
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.bearerToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        ws.close();
        reject(SboxError.cancellation("Operation was cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      ws.once("open", () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      ws.once("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(SboxError.transport("WebSocket connection failed.", { cause: error }));
      });
    });
    this.openSockets.add(ws);
    ws.on("close", () => this.openSockets.delete(ws));
    return ws;
  }

  private async ensureHandshake(signal?: AbortSignal): Promise<HandshakeResponse> {
    if (this.handshake !== undefined) {
      return this.handshake;
    }
    const body = await this.json<HandshakeResponse>("GET", "/v1/handshake", undefined, signal);
    assertProtocolVersion(body.protocolVersion);
    this.handshake = body;
    return body;
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed) {
      throw SboxError.transport("RemoteHost has been disposed.");
    }
    throwIfAborted(signal);
    const response = await this.fetchRaw(
      method,
      path,
      body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8"),
      body === undefined ? {} : { "content-type": "application/json" },
      signal,
    );
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async fetchRaw(
    method: string,
    path: string,
    body: Buffer | undefined,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          ...headers,
        },
        ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw SboxError.cancellation("Operation was cancelled.", { cause: error });
      }
      safeLog(this.logger, {
        level: "warn",
        message: "Remote request transport failure.",
        details: { method, path },
      });
      throw SboxError.transport("Remote request failed.", { cause: error });
    }
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw SboxError.transport(`Remote request failed with HTTP ${response.status}.`);
      }
      throw errorFromWire(payload);
    }
    return response;
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** `bindHostPath` is server-only; never send it on the wire. */
function stripBindHostPaths(request: HostCreateRequest): HostCreateRequest {
  const mounts = request.mounts;
  if (mounts === undefined || mounts.length === 0) {
    return request;
  }
  return {
    ...request,
    mounts: mounts.map((entry) => ({
      source: entry.source,
      path: entry.path,
      mount: entry.mount,
      readonly: entry.readonly,
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
      ...(entry.quotaMiB !== undefined ? { quotaMiB: entry.quotaMiB } : {}),
    })),
  };
}
