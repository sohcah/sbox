/**
 * Local Microsandbox Host adapter for Phase 1 lifecycle.
 *
 * Thin mapping over the pinned SDK via NativeRuntime. No durable sbox state.
 * Not part of the public package export graph.
 */

import { SboxError, isSboxError, throwIfAborted, wrapUnknownFailure } from "./errors.js";
import type { Host } from "./host.js";
import {
  assertSandboxIdentity,
  nativeSandboxName,
  type NativeSandboxName,
  type SandboxIdentity,
} from "./identity.js";
import { createRedactingLogger, safeLog, silentLogger, type Logger } from "./logging.js";
import { createMicrosandboxRuntime } from "./microsandbox-runtime.js";
import type { NativeLiveHandle, NativeRuntime, NativeSandboxRecord } from "./native-runtime.js";
import { mapNativeStatus } from "./native-runtime.js";
import { buildOwnershipLabels, matchOwnedCreation } from "./ownership-adoption.js";
import { inspectOwnershipLabels, type LabelMap } from "./ownership.js";
import { projectCreateRequest, type ImmutableCreationProjection } from "./immutable-creation.js";
import type {
  HostCopyPaths,
  HostExecArgvRequest,
  HostExecShellRequest,
  HostPtyRequest,
} from "./host.js";
import { startAgentPty } from "./internal/agent-pty.js";
import {
  execArgvCollected,
  execArgvStream,
  execShellCollected,
  execShellStream,
} from "./local-process.js";
import { copyGuestToHost, copyHostToGuest } from "./local-transfer.js";
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
  SandboxSummary,
} from "./types.js";

/** Internal testing seam. Not exported from the package root. */
export interface LocalHostInternalOptions {
  readonly logger?: Logger;
  readonly runtime?: NativeRuntime;
}

/** @internal Used by unit tests to inject a fake native runtime. */
export function createLocalHostInternal(options: LocalHostInternalOptions = {}): Host {
  return new LocalHost(options);
}

class LocalHost implements Host {
  private readonly logger: Logger;
  private readonly runtime: NativeRuntime;
  private readonly liveByName = new Map<string, NativeLiveHandle>();
  private disposed = false;

  constructor(options: LocalHostInternalOptions) {
    this.logger = createRedactingLogger(options.logger ?? silentLogger);
    this.runtime = options.runtime ?? createMicrosandboxRuntime();
  }

  async create(request: HostCreateRequest, options?: OperationOptions): Promise<SandboxInspection> {
    return this.withOperation("create", request.identity, options, async () => {
      const identity = assertSandboxIdentity(request.identity);
      this.validateCreateRequest(request);
      const nativeName = nativeSandboxName(identity.project, identity.instance);
      const projected = projectCreateRequest(request);
      const labels = buildOwnershipLabels(identity, projected);

      const preexisting = await this.tryGet(nativeName);
      if (preexisting !== undefined) {
        throw this.conflictOrAlreadyExists(identity, nativeName, preexisting, projected);
      }

      let published = false;
      try {
        const live = await this.runtime.create({
          name: nativeName,
          image: projected.image,
          labels,
          detached: true,
          cpus: projected.cpus,
          memoryMiB: projected.memoryMiB,
          workdir: projected.workdir,
          user: projected.user,
          shell: projected.shell,
          hostname: projected.hostname,
          maxDurationSecs: projected.maxDurationSecs,
          idleTimeoutSecs: projected.idleTimeoutSecs,
          env: projected.env,
        });
        published = true;
        this.liveByName.set(nativeName, live);
      } catch (error) {
        const mapped = wrapUnknownFailure(error, "Sandbox create failed.");
        if (isDefinitiveCreateFailure(mapped)) {
          const leftover = await this.tryGet(nativeName);
          if (leftover !== undefined) {
            throw this.conflictOrAlreadyExists(identity, nativeName, leftover, projected);
          }
          throw mapped;
        }
        return await this.reinspectUncertainCreate(identity, nativeName, projected, mapped);
      }

      try {
        await this.consumeLive(nativeName);
      } catch (detachError) {
        throw SboxError.internal(
          "Sandbox was created but releasing the local live handle failed.",
          {
            cause: detachError,
            details: { nativeName, cleanup: "detach_failed" },
          },
        );
      }

      try {
        return await this.inspectOwned(identity, nativeName);
      } catch (inspectError) {
        if (published) {
          throw wrapUnknownFailure(
            inspectError,
            "Sandbox was created but post-create inspection failed.",
          );
        }
        throw wrapUnknownFailure(inspectError);
      }
    });
  }

  async get(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.inspect(identity, options);
  }

  async list(options?: HostListOptions): Promise<readonly SandboxSummary[]> {
    return this.withOperation("list", undefined, options, async () => {
      const records = await this.runtime.list();
      const summaries: SandboxSummary[] = [];
      for (const record of records) {
        const ownership = inspectOwnershipLabels(record.labels);
        if (!ownership.ok) {
          continue;
        }
        if (options?.project !== undefined && ownership.identity.project !== options.project) {
          continue;
        }
        summaries.push({
          identity: ownership.identity,
          nativeName: record.name as NativeSandboxName,
          state: mapNativeStatus(record.status),
          image: record.image,
        });
      }
      return summaries;
    });
  }

  async inspect(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.withOperation("inspect", identity, options, async () => {
      const normalized = assertSandboxIdentity(identity);
      const nativeName = nativeSandboxName(normalized.project, normalized.instance);
      return this.inspectOwned(normalized, nativeName);
    });
  }

  async start(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.withOperation("start", identity, options, async () => {
      const normalized = assertSandboxIdentity(identity);
      const nativeName = nativeSandboxName(normalized.project, normalized.instance);
      const current = await this.requireOwned(normalized, nativeName);
      if (current.status === "running") {
        return this.toInspection(normalized, current);
      }
      if (current.status !== "stopped") {
        throw SboxError.nativeState(`Cannot start sandbox in native state ${current.status}.`, {
          details: { state: current.status, nativeName },
        });
      }
      await this.consumeLive(nativeName);
      const live = await this.runtime.start(nativeName);
      this.liveByName.set(nativeName, live);
      try {
        await this.consumeLive(nativeName);
      } catch (detachError) {
        throw SboxError.internal(
          "Sandbox was started but releasing the local live handle failed.",
          {
            cause: detachError,
            details: { nativeName, cleanup: "detach_failed" },
          },
        );
      }
      const fresh = await this.requireOwned(normalized, nativeName);
      return this.toInspection(normalized, fresh);
    });
  }

  async stop(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.withOperation("stop", identity, options, async () => {
      const normalized = assertSandboxIdentity(identity);
      const nativeName = nativeSandboxName(normalized.project, normalized.instance);
      const current = await this.requireOwned(normalized, nativeName);
      if (current.status === "stopped") {
        await this.consumeLive(nativeName);
        return this.toInspection(normalized, current);
      }
      if (current.status !== "running" && current.status !== "draining") {
        throw SboxError.nativeState(`Cannot stop sandbox in native state ${current.status}.`, {
          details: { state: current.status, nativeName },
        });
      }
      const fresh = await this.stopExact(nativeName);
      this.assertOwnedMatch(normalized, nativeName, fresh);
      return this.toInspection(normalized, fresh);
    });
  }

  async remove(identity: SandboxIdentity, options?: OperationOptions): Promise<void> {
    await this.withOperation("remove", identity, options, async () => {
      const normalized = assertSandboxIdentity(identity);
      const nativeName = nativeSandboxName(normalized.project, normalized.instance);
      const current = await this.tryGet(nativeName);
      if (current === undefined) {
        throw SboxError.notFound(
          `Sandbox ${normalized.project}/${normalized.instance} was not found.`,
          {
            details: {
              project: normalized.project,
              instance: normalized.instance,
              nativeName,
            },
          },
        );
      }
      this.assertOwnedMatch(normalized, nativeName, current);
      if (current.status === "running" || current.status === "draining") {
        await this.stopExact(nativeName);
      } else {
        await this.consumeLive(nativeName);
      }
      const fresh = await this.requireOwned(normalized, nativeName);
      if (fresh.status === "running" || fresh.status === "draining") {
        throw SboxError.busy(`Sandbox ${nativeName} is still running after stop.`, {
          details: { nativeName, state: fresh.status },
        });
      }
      await this.runtime.remove(nativeName);
      this.liveByName.delete(nativeName);
    });
  }

  async capabilities(options?: OperationOptions): Promise<HostCapabilities> {
    return this.withOperation("capabilities", undefined, options, async () => {
      const probe = await this.runtime.probe();
      return {
        localMicrosandbox: probe.available,
        notes: probe.notes,
      };
    });
  }

  async execArgv(
    request: HostExecArgvRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    return this.withOperation("execArgv", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      return execArgvCollected(nativeName, request.argv, options);
    });
  }

  async execArgvStream(
    request: HostExecArgvRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    return this.withOperation("execArgvStream", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      return execArgvStream(nativeName, request.argv, options);
    });
  }

  async execShell(
    request: HostExecShellRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    return this.withOperation("execShell", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      return execShellCollected(nativeName, request.script, {
        ...options,
        ...(request.shell !== undefined ? { shell: request.shell } : {}),
      });
    });
  }

  async execShellStream(
    request: HostExecShellRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    return this.withOperation("execShellStream", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      return execShellStream(nativeName, request.script, {
        ...options,
        ...(request.shell !== undefined ? { shell: request.shell } : {}),
      });
    });
  }

  async pty(request: HostPtyRequest, options?: HostPtyOptions): Promise<PtySession> {
    return this.withOperation("pty", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      return startAgentPty({
        nativeName,
        argv: request.argv,
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.user !== undefined ? { user: options.user } : {}),
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.rows !== undefined ? { rows: options.rows } : {}),
        ...(options?.cols !== undefined ? { cols: options.cols } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.input !== undefined ? { input: options.input } : {}),
      });
    });
  }

  async copyHostToGuest(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    return this.withOperation("copyHostToGuest", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      await copyHostToGuest(nativeName, request.hostPath, request.guestPath, options);
    });
  }

  async copyGuestToHost(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    return this.withOperation("copyGuestToHost", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      await copyGuestToHost(nativeName, request.guestPath, request.hostPath, options);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const names = [...this.liveByName.keys()];
    for (const name of names) {
      try {
        await this.consumeLive(name);
      } catch {
        // Retain the live handle for a later dispose retry. Never stop/remove.
      }
    }
    this.disposed = true;
  }

  private async stopExact(nativeName: string): Promise<NativeSandboxRecord> {
    const live = this.liveByName.get(nativeName);
    if (live !== undefined) {
      try {
        await live.stop();
      } catch (stopError) {
        try {
          await live.detach();
          this.liveByName.delete(nativeName);
        } catch {
          // Keep the handle when detach also fails so disposal can retry.
        }
        throw wrapUnknownFailure(stopError, "Sandbox stop failed.");
      }

      try {
        await live.detach();
        this.liveByName.delete(nativeName);
      } catch (detachError) {
        throw SboxError.internal("Sandbox stopped but local live-handle detach failed.", {
          cause: detachError,
          details: { nativeName, cleanup: "detach_failed" },
        });
      }

      return await this.runtime.get(nativeName);
    }

    return await this.runtime.stopLiveThenFreshGet(nativeName);
  }

  /**
   * Detach/consume a live handle without changing sandbox lifecycle.
   * The map entry is removed only after detach succeeds so failures remain retryable.
   */
  private async consumeLive(nativeName: string): Promise<void> {
    const live = this.liveByName.get(nativeName);
    if (live === undefined) {
      return;
    }
    await live.detach();
    this.liveByName.delete(nativeName);
  }

  private async reinspectUncertainCreate(
    identity: SandboxIdentity,
    nativeName: NativeSandboxName,
    projected: ImmutableCreationProjection,
    error: unknown,
  ): Promise<SandboxInspection> {
    if (isSboxError(error) && error.code === "already_exists") {
      const existing = await this.tryGet(nativeName);
      if (existing === undefined) {
        throw error;
      }
      throw this.conflictOrAlreadyExists(identity, nativeName, existing, projected);
    }

    const existing = await this.tryGet(nativeName);
    if (existing === undefined) {
      throw wrapUnknownFailure(error, "Sandbox create failed.");
    }

    const ownership = matchOwnedCreation(existing, identity, projected);
    if (!ownership.ok) {
      throw SboxError.ownershipConflict(
        `Native sandbox ${nativeName} exists but does not match sbox ownership or configuration.`,
        {
          details: {
            nativeName,
            reason: ownership.reason,
          },
          cause: error,
        },
      );
    }

    // Matching owned resource: return it only after local live cleanup succeeds (or is absent).
    try {
      await this.consumeLive(nativeName);
    } catch (detachError) {
      throw SboxError.internal(
        "Matching sandbox exists after uncertain create, but local live-handle detach failed.",
        {
          cause: detachError,
          details: { nativeName, cleanup: "detach_failed" },
        },
      );
    }
    return this.toInspection(identity, existing);
  }

  private conflictOrAlreadyExists(
    identity: SandboxIdentity,
    nativeName: NativeSandboxName,
    existing: NativeSandboxRecord,
    projected: ImmutableCreationProjection,
  ): SboxError {
    const ownership = matchOwnedCreation(existing, identity, projected);
    if (ownership.ok) {
      return SboxError.alreadyExists(
        `Sandbox ${identity.project}/${identity.instance} already exists.`,
        {
          details: {
            project: identity.project,
            instance: identity.instance,
            nativeName,
          },
        },
      );
    }
    return SboxError.ownershipConflict(
      `Native sandbox ${nativeName} exists but does not match sbox ownership or configuration.`,
      {
        details: {
          nativeName,
          reason: ownership.reason,
        },
      },
    );
  }

  private async inspectOwned(
    identity: SandboxIdentity,
    nativeName: NativeSandboxName,
  ): Promise<SandboxInspection> {
    const record = await this.requireOwned(identity, nativeName);
    return this.toInspection(identity, record);
  }

  private async requireRunningNativeName(
    identity: SandboxIdentity,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const normalized = assertSandboxIdentity(identity);
    const nativeName = nativeSandboxName(normalized.project, normalized.instance);
    const record = await this.requireOwned(normalized, nativeName);
    if (record.status !== "running") {
      throw SboxError.nativeState("Sandbox must be running for process or transfer operations.", {
        details: { state: record.status, nativeName },
      });
    }
    return nativeName;
  }

  private async requireOwned(
    identity: SandboxIdentity,
    nativeName: NativeSandboxName,
  ): Promise<NativeSandboxRecord> {
    const record = await this.tryGet(nativeName);
    if (record === undefined) {
      throw SboxError.notFound(`Sandbox ${identity.project}/${identity.instance} was not found.`, {
        details: {
          project: identity.project,
          instance: identity.instance,
          nativeName,
        },
      });
    }
    this.assertOwnedMatch(identity, nativeName, record);
    return record;
  }

  private assertOwnedMatch(
    identity: SandboxIdentity,
    nativeName: NativeSandboxName,
    record: NativeSandboxRecord,
  ): void {
    const ownership = inspectOwnershipLabels(record.labels);
    if (!ownership.ok) {
      throw SboxError.ownershipConflict(`Native sandbox ${nativeName} failed ownership checks.`, {
        details: { nativeName, reason: ownership.reason },
      });
    }
    if (
      ownership.identity.project !== identity.project ||
      ownership.identity.instance !== identity.instance ||
      ownership.identity.profile !== identity.profile
    ) {
      throw SboxError.ownershipConflict(`Native sandbox ${nativeName} failed ownership checks.`, {
        details: { nativeName, reason: "Identity labels do not match." },
      });
    }
  }

  private async tryGet(nativeName: string): Promise<NativeSandboxRecord | undefined> {
    try {
      return await this.runtime.get(nativeName);
    } catch (error) {
      if (isSboxError(error) && error.code === "not_found") {
        return undefined;
      }
      throw wrapUnknownFailure(error);
    }
  }

  private toInspection(identity: SandboxIdentity, record: NativeSandboxRecord): SandboxInspection {
    return {
      identity,
      nativeName: record.name as NativeSandboxName,
      state: mapNativeStatus(record.status),
      creation: creationFromRecord(record),
      labels: freezeLabels(record.labels),
      ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
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
              nativeName: nativeSandboxName(identity.project, identity.instance),
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
              nativeName: nativeSandboxName(identity.project, identity.instance),
            }
          : {}),
        details: wrapped.toSafeJSON().details,
      });
      throw wrapped;
    }
  }

  private ensureOpen(): void {
    if (this.disposed) {
      throw SboxError.internal("LocalHost has been disposed.");
    }
  }
}

function creationFromRecord(record: NativeSandboxRecord): SandboxCreationSettings {
  return {
    image: record.image,
    cpus: record.cpus,
    memoryMiB: record.memoryMiB,
    ...(record.workdir !== null ? { workdir: record.workdir } : {}),
    ...(record.user !== null ? { user: record.user } : {}),
    ...(record.shell !== null ? { shell: record.shell } : {}),
    ...(record.hostname !== null ? { hostname: record.hostname } : {}),
    ...(record.maxDurationSecs !== null ? { maxDurationSecs: record.maxDurationSecs } : {}),
    ...(record.idleTimeoutSecs !== null ? { idleTimeoutSecs: record.idleTimeoutSecs } : {}),
  };
}

function freezeLabels(labels: LabelMap): LabelMap {
  return Object.freeze({ ...labels });
}

function isDefinitiveCreateFailure(error: SboxError): boolean {
  return (
    error.code === "validation" ||
    error.code === "already_exists" ||
    error.code === "capability" ||
    error.code === "ownership_conflict"
  );
}
