/**
 * In-memory FakeHost for Phase 1 Host contract tests.
 *
 * Models only the lifecycle contract. It is not a repository, workflow engine,
 * repair system, or second lifecycle authority beyond what contract tests need.
 */

import { SboxError, throwIfAborted, wrapUnknownFailure } from "./errors.js";
import type {
  Host,
  HostCopyPaths,
  HostExecArgvRequest,
  HostExecShellRequest,
  HostPtyRequest,
} from "./host.js";
import {
  assertSandboxIdentity,
  nativeSandboxName,
  type NativeSandboxName,
  type SandboxIdentity,
} from "./identity.js";
import { createRedactingLogger, safeLog, silentLogger, type Logger } from "./logging.js";
import { inspectOwnershipLabels } from "./ownership.js";
import { buildOwnershipLabels } from "./ownership-adoption.js";
import { projectCreateRequest } from "./immutable-creation.js";
import {
  FakeSandboxFilesystem,
  defaultFakeExec,
  fakeCopyGuestToHost,
  fakeCopyHostToGuest,
  fakeExecCollected,
  fakeExecStream,
  fakePty,
} from "./fake-process.js";
import type {
  HostCollectedExecOptions,
  HostPtyOptions,
  HostStreamingExecOptions,
  ProcessSession,
  PtySession,
} from "./process/session.js";
import type { HostCopyOptions } from "./transfer/types.js";
import type {
  HostCapabilities,
  HostCreateRequest,
  HostListOptions,
  OperationOptions,
  ProcessResult,
  SandboxCreationSettings,
  SandboxInspection,
  SandboxLifecycleState,
  SandboxSummary,
} from "./types.js";
import { sandboxIdentityKey } from "./types.js";

export interface FakeHostOptions {
  readonly logger?: Logger;
  /** Optional clock for deterministic timestamps in tests. */
  readonly now?: () => Date;
}

interface StoredSandbox {
  identity: SandboxIdentity;
  nativeName: NativeSandboxName;
  state: SandboxLifecycleState;
  creation: SandboxCreationSettings;
  env: Readonly<Record<string, string>>;
  maxDurationSecs: number | null;
  idleTimeoutSecs: number | null;
  createdAt: string;
  updatedAt: string;
}

export class FakeHost implements Host {
  private readonly byKey = new Map<string, StoredSandbox>();
  private readonly byNativeName = new Map<string, string>();
  private readonly filesystems = new Map<string, FakeSandboxFilesystem>();
  private readonly logger: Logger;
  private readonly now: () => Date;
  private disposed = false;
  /** Test helper: Host method names invoked through the public Host contract. */
  readonly operations: string[] = [];
  /** Optional override for fake exec behavior. */
  execHandler = defaultFakeExec;

  constructor(options: FakeHostOptions = {}) {
    this.logger = createRedactingLogger(options.logger ?? silentLogger);
    this.now = options.now ?? (() => new Date());
  }

  async create(request: HostCreateRequest, options?: OperationOptions): Promise<SandboxInspection> {
    this.operations.push("create");
    return this.withOperation("create", request.identity, options, async () => {
      const identity = assertSandboxIdentity(request.identity);
      this.validateCreateRequest(request);
      const key = sandboxIdentityKey(identity);
      const nativeName = nativeSandboxName(identity.project, identity.instance);

      const existing = this.byKey.get(key);
      if (existing !== undefined) {
        throw SboxError.alreadyExists(
          `Sandbox ${identity.project}/${identity.instance} already exists.`,
          {
            details: {
              project: identity.project,
              instance: identity.instance,
              nativeName: existing.nativeName,
            },
          },
        );
      }

      const nativeOwner = this.byNativeName.get(nativeName);
      if (nativeOwner !== undefined) {
        throw SboxError.ownershipConflict(
          `Native sandbox name ${nativeName} is already occupied by an unrelated resource.`,
          { details: { nativeName } },
        );
      }

      const timestamp = this.now().toISOString();
      const projected = projectCreateRequest(request);
      const creation = creationFromProjection(projected);
      const stored: StoredSandbox = {
        identity,
        nativeName,
        state: "running",
        creation,
        env: projected.env,
        maxDurationSecs: projected.maxDurationSecs,
        idleTimeoutSecs: projected.idleTimeoutSecs,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.byKey.set(key, stored);
      this.byNativeName.set(nativeName, key);
      return this.toInspection(stored);
    });
  }

  async get(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    this.operations.push("get");
    return this.inspect(identity, options);
  }

  async list(options?: HostListOptions): Promise<readonly SandboxSummary[]> {
    this.operations.push("list");
    return this.withOperation("list", undefined, options, async () => {
      const all = [...this.byKey.values()];
      const filtered =
        options?.project === undefined
          ? all
          : all.filter((item) => item.identity.project === options.project);
      return filtered.map((item) => ({
        identity: item.identity,
        nativeName: item.nativeName,
        state: item.state,
        image: item.creation.image,
      }));
    });
  }

  async inspect(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    this.operations.push("inspect");
    return this.withOperation("inspect", identity, options, async () => {
      return this.toInspection(this.require(identity));
    });
  }

  async start(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    this.operations.push("start");
    return this.withOperation("start", identity, options, async () => {
      const stored = this.require(identity);
      if (stored.state === "running") {
        return this.toInspection(stored);
      }
      if (stored.state !== "stopped") {
        throw SboxError.nativeState(`Cannot start sandbox in state ${formatState(stored.state)}.`, {
          details: { state: stored.state },
        });
      }
      stored.state = "running";
      stored.updatedAt = this.now().toISOString();
      return this.toInspection(stored);
    });
  }

  async stop(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    this.operations.push("stop");
    return this.withOperation("stop", identity, options, async () => {
      const stored = this.require(identity);
      if (stored.state === "stopped") {
        return this.toInspection(stored);
      }
      if (stored.state !== "running" && stored.state !== "draining") {
        throw SboxError.nativeState(`Cannot stop sandbox in state ${formatState(stored.state)}.`, {
          details: { state: stored.state },
        });
      }
      stored.state = "stopped";
      stored.updatedAt = this.now().toISOString();
      return this.toInspection(stored);
    });
  }

  async remove(identity: SandboxIdentity, options?: OperationOptions): Promise<void> {
    this.operations.push("remove");
    await this.withOperation("remove", identity, options, async () => {
      const stored = this.require(identity);
      if (stored.state === "running" || stored.state === "draining") {
        stored.state = "stopped";
        stored.updatedAt = this.now().toISOString();
      }
      this.byKey.delete(sandboxIdentityKey(identity));
      this.byNativeName.delete(stored.nativeName);
    });
  }

  async capabilities(options?: OperationOptions): Promise<HostCapabilities> {
    this.operations.push("capabilities");
    return this.withOperation("capabilities", undefined, options, async () => ({
      localMicrosandbox: false,
      notes: ["FakeHost models the Host contract in memory."],
    }));
  }

  async execArgv(
    request: HostExecArgvRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    this.operations.push("execArgv");
    return this.withOperation("execArgv", request.identity, options, async () => {
      this.requireRunning(request.identity);
      return fakeExecCollected(request.argv, options ?? {}, { run: this.execHandler });
    });
  }

  async execArgvStream(
    request: HostExecArgvRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    this.operations.push("execArgvStream");
    return this.withOperation("execArgvStream", request.identity, options, async () => {
      this.requireRunning(request.identity);
      return fakeExecStream(request.argv, options ?? {}, { run: this.execHandler });
    });
  }

  async execShell(
    request: HostExecShellRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    this.operations.push("execShell");
    return this.withOperation("execShell", request.identity, options, async () => {
      this.requireRunning(request.identity);
      const shell = request.shell ?? "/bin/sh";
      return fakeExecCollected([shell, "-c", request.script], options ?? {}, {
        run: this.execHandler,
      });
    });
  }

  async execShellStream(
    request: HostExecShellRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    this.operations.push("execShellStream");
    return this.withOperation("execShellStream", request.identity, options, async () => {
      this.requireRunning(request.identity);
      const shell = request.shell ?? "/bin/sh";
      return fakeExecStream([shell, "-c", request.script], options ?? {}, {
        run: this.execHandler,
      });
    });
  }

  async pty(request: HostPtyRequest, options?: HostPtyOptions): Promise<PtySession> {
    this.operations.push("pty");
    return this.withOperation("pty", request.identity, options, async () => {
      this.requireRunning(request.identity);
      return fakePty(request.argv, options ?? {});
    });
  }

  async copyHostToGuest(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    this.operations.push("copyHostToGuest");
    return this.withOperation("copyHostToGuest", request.identity, options, async () => {
      const stored = this.requireRunning(request.identity);
      const fs = this.fsFor(stored.nativeName);
      await fakeCopyHostToGuest(fs, request.hostPath, request.guestPath, options);
    });
  }

  async copyGuestToHost(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    this.operations.push("copyGuestToHost");
    return this.withOperation("copyGuestToHost", request.identity, options, async () => {
      const stored = this.requireRunning(request.identity);
      const fs = this.fsFor(stored.nativeName);
      await fakeCopyGuestToHost(fs, request.guestPath, request.hostPath, options);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }

  /** Test helper: access the in-memory guest filesystem for a sandbox. */
  filesystemFor(identity: SandboxIdentity): FakeSandboxFilesystem {
    const stored = this.require(identity);
    return this.fsFor(stored.nativeName);
  }

  /** Test helper: seed or replace stored state without going through create. */
  seed(input: {
    readonly identity: SandboxIdentity;
    readonly state?: SandboxLifecycleState;
    readonly creation?: SandboxCreationSettings;
    readonly nativeName?: NativeSandboxName;
  }): SandboxInspection {
    const identity = assertSandboxIdentity(input.identity);
    const key = sandboxIdentityKey(identity);
    const nativeName = input.nativeName ?? nativeSandboxName(identity.project, identity.instance);
    const timestamp = this.now().toISOString();
    const creation = input.creation ?? {
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
    };
    const projected = projectCreateRequest({
      image: creation.image,
      cpus: creation.cpus,
      memoryMiB: creation.memoryMiB,
      ...(creation.workdir !== undefined ? { workdir: creation.workdir } : {}),
      ...(creation.user !== undefined ? { user: creation.user } : {}),
      ...(creation.shell !== undefined ? { shell: creation.shell } : {}),
      ...(creation.hostname !== undefined ? { hostname: creation.hostname } : {}),
      ...(creation.maxDurationSecs !== undefined
        ? { maxDurationSecs: creation.maxDurationSecs }
        : {}),
      ...(creation.idleTimeoutSecs !== undefined
        ? { idleTimeoutSecs: creation.idleTimeoutSecs }
        : {}),
    });
    const stored: StoredSandbox = {
      identity,
      nativeName,
      state: input.state ?? "stopped",
      creation: creationFromProjection(projected),
      env: {},
      maxDurationSecs: projected.maxDurationSecs,
      idleTimeoutSecs: projected.idleTimeoutSecs,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.byKey.set(key, stored);
    this.byNativeName.set(nativeName, key);
    return this.toInspection(stored);
  }

  /** Test helper: place a conflicting native resource that fails ownership checks. */
  seedForeignNative(nativeName: NativeSandboxName, image = "foreign:latest"): void {
    const key = `foreign:${nativeName}`;
    const timestamp = this.now().toISOString();
    const identity = assertSandboxIdentity({
      project: "foreign-project",
      profile: "foreign-profile",
      instance: "foreign-instance",
    });
    // Intentionally do not index under the caller's identity key.
    this.byNativeName.set(nativeName, key);
    this.byKey.set(key, {
      identity,
      nativeName,
      state: "stopped",
      creation: { image, cpus: 1, memoryMiB: 512 },
      env: {},
      maxDurationSecs: null,
      idleTimeoutSecs: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  private require(identity: SandboxIdentity): StoredSandbox {
    const normalized = assertSandboxIdentity(identity);
    const stored = this.byKey.get(sandboxIdentityKey(normalized));
    if (stored === undefined) {
      throw SboxError.notFound(
        `Sandbox ${normalized.project}/${normalized.instance} was not found.`,
        {
          details: {
            project: normalized.project,
            instance: normalized.instance,
            nativeName: nativeSandboxName(normalized.project, normalized.instance),
          },
        },
      );
    }
    const ownership = inspectOwnershipLabels(this.toInspection(stored).labels);
    if (
      !ownership.ok ||
      ownership.identity.project !== normalized.project ||
      ownership.identity.instance !== normalized.instance ||
      ownership.identity.profile !== normalized.profile
    ) {
      throw SboxError.ownershipConflict(
        `Sandbox ${normalized.project}/${normalized.instance} failed ownership checks.`,
        { details: { reason: ownership.ok ? "Identity labels do not match." : ownership.reason } },
      );
    }
    return stored;
  }

  private requireRunning(identity: SandboxIdentity): StoredSandbox {
    const stored = this.require(identity);
    if (stored.state !== "running") {
      throw SboxError.nativeState("Sandbox must be running for process or transfer operations.", {
        details: { state: stored.state, nativeName: stored.nativeName },
      });
    }
    return stored;
  }

  private fsFor(nativeName: string): FakeSandboxFilesystem {
    let fs = this.filesystems.get(nativeName);
    if (fs === undefined) {
      fs = new FakeSandboxFilesystem();
      this.filesystems.set(nativeName, fs);
    }
    return fs;
  }

  private toInspection(stored: StoredSandbox): SandboxInspection {
    const projected = projectCreateRequest({
      image: stored.creation.image,
      cpus: stored.creation.cpus,
      memoryMiB: stored.creation.memoryMiB,
      ...(stored.creation.workdir !== undefined ? { workdir: stored.creation.workdir } : {}),
      ...(stored.creation.user !== undefined ? { user: stored.creation.user } : {}),
      ...(stored.creation.shell !== undefined ? { shell: stored.creation.shell } : {}),
      ...(stored.creation.hostname !== undefined ? { hostname: stored.creation.hostname } : {}),
      maxDurationSecs: stored.maxDurationSecs,
      idleTimeoutSecs: stored.idleTimeoutSecs,
      env: stored.env,
    });
    return {
      identity: stored.identity,
      nativeName: stored.nativeName,
      state: stored.state,
      creation: { ...stored.creation },
      labels: buildOwnershipLabels(stored.identity, projected),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  private validateCreateRequest(request: HostCreateRequest): void {
    if (request.image.trim().length === 0) {
      throw SboxError.validation("Sandbox image is required.", {
        details: { path: "image", message: "Expected a non-empty image reference." },
      });
    }
    if (request.cpus !== undefined && (!Number.isInteger(request.cpus) || request.cpus < 1)) {
      throw SboxError.validation("Sandbox cpus must be a positive integer.", {
        details: { path: "cpus" },
      });
    }
    if (
      request.memoryMiB !== undefined &&
      (!Number.isInteger(request.memoryMiB) || request.memoryMiB < 1)
    ) {
      throw SboxError.validation("Sandbox memoryMiB must be a positive integer.", {
        details: { path: "memoryMiB" },
      });
    }
    if (
      request.maxDurationSecs !== undefined &&
      request.maxDurationSecs !== null &&
      (!Number.isInteger(request.maxDurationSecs) || request.maxDurationSecs < 1)
    ) {
      throw SboxError.validation("Sandbox maxDurationSecs must be a positive integer.", {
        details: { path: "maxDurationSecs" },
      });
    }
    if (
      request.idleTimeoutSecs !== undefined &&
      request.idleTimeoutSecs !== null &&
      (!Number.isInteger(request.idleTimeoutSecs) || request.idleTimeoutSecs < 1)
    ) {
      throw SboxError.validation("Sandbox idleTimeoutSecs must be a positive integer.", {
        details: { path: "idleTimeoutSecs" },
      });
    }
  }

  private async withOperation<T>(
    operation: string,
    identity: SandboxIdentity | undefined,
    options: OperationOptions | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    this.ensureOpen();
    throwIfAborted(options?.signal);
    const started = Date.now();
    try {
      const result = await run();
      throwIfAborted(options?.signal);
      safeLog(this.logger, {
        level: "info",
        message: `${operation} succeeded`,
        operation,
        durationMs: Date.now() - started,
        resultCode: "ok",
        ...(identity !== undefined
          ? {
              project: identity.project,
              profile: identity.profile,
              instance: identity.instance,
            }
          : {}),
      });
      return result;
    } catch (error) {
      const wrapped = wrapUnknownFailure(error);
      safeLog(this.logger, {
        level: "error",
        message: `${operation} failed`,
        operation,
        durationMs: Date.now() - started,
        resultCode: wrapped.code,
        ...(identity !== undefined
          ? {
              project: identity.project,
              profile: identity.profile,
              instance: identity.instance,
            }
          : {}),
        details: wrapped.toSafeJSON().details,
      });
      throw wrapped;
    }
  }

  private ensureOpen(): void {
    if (this.disposed) {
      throw SboxError.internal("FakeHost has been disposed.");
    }
  }
}

function creationFromProjection(
  projected: ReturnType<typeof projectCreateRequest>,
): SandboxCreationSettings {
  return {
    image: projected.image,
    cpus: projected.cpus,
    memoryMiB: projected.memoryMiB,
    ...(projected.workdir !== null ? { workdir: projected.workdir } : {}),
    ...(projected.user !== null ? { user: projected.user } : {}),
    ...(projected.shell !== null ? { shell: projected.shell } : {}),
    ...(projected.hostname !== null ? { hostname: projected.hostname } : {}),
    ...(projected.maxDurationSecs !== null ? { maxDurationSecs: projected.maxDurationSecs } : {}),
    ...(projected.idleTimeoutSecs !== null ? { idleTimeoutSecs: projected.idleTimeoutSecs } : {}),
  };
}

function formatState(state: SandboxLifecycleState): string {
  return typeof state === "string" ? state : `unknown(${state.native})`;
}
