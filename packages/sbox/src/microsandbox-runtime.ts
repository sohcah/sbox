/**
 * Microsandbox 0.6.6 native runtime adapter.
 *
 * SDK classes stay inside this module and are never re-exported.
 */

import { MiB, Sandbox } from "microsandbox";
import {
  InvalidConfigError,
  MicrosandboxError,
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  SandboxStillRunningError,
} from "microsandbox";
import { SboxError } from "./errors.js";
import type {
  NativeCreateRequest,
  NativeLiveHandle,
  NativeRuntime,
  NativeSandboxRecord,
} from "./native-runtime.js";
import { decodeSandboxConfig, peekSandboxConfigLabels } from "./sandbox-config.js";
import { MANAGED_LABEL_VALUE, OWNERSHIP_LABEL_KEYS } from "./ownership.js";
import { applyNetworkToBuilder } from "./network/compile.js";

export function createMicrosandboxRuntime(): NativeRuntime {
  return new MicrosandboxRuntime();
}

class MicrosandboxRuntime implements NativeRuntime {
  async create(request: NativeCreateRequest): Promise<NativeLiveHandle> {
    try {
      let builder = Sandbox.builder(request.name)
        .image(request.image)
        .cpus(request.cpus)
        .memory(MiB(request.memoryMiB))
        .detached(request.detached)
        .ephemeral(false)
        .labels({ ...request.labels });

      if (request.workdir !== null) {
        builder = builder.workdir(request.workdir);
      }
      if (request.user !== null) {
        builder = builder.user(request.user);
      }
      if (request.shell !== null) {
        builder = builder.shell(request.shell);
      }
      if (request.hostname !== null) {
        builder = builder.hostname(request.hostname);
      }
      if (request.maxDurationSecs !== null) {
        builder = builder.maxDuration(request.maxDurationSecs);
      }
      if (request.idleTimeoutSecs !== null) {
        builder = builder.idleTimeout(request.idleTimeoutSecs);
      }
      if (Object.keys(request.env).length > 0) {
        builder = builder.envs({ ...request.env });
      }

      builder = builder.network((network) =>
        applyNetworkToBuilder(network, request.network, request.secrets),
      );

      for (const mount of request.mounts ?? []) {
        builder = builder.volume(mount.guestPath, (m) => {
          let disk = m.disk(mount.hostPath).format(mount.format);
          if (mount.fstype !== null) {
            disk = disk.fstype(mount.fstype);
          }
          return disk;
        });
      }

      for (const mount of request.bindMounts ?? []) {
        builder = builder.volume(mount.guestPath, (m) => {
          let next = m.bind(mount.hostPath);
          if (mount.readonly) {
            next = next.readonly();
          } else if (mount.quotaMiB !== undefined) {
            next = next.quota(mount.quotaMiB);
          }
          return next;
        });
      }

      if (request.tmpMiB !== null) {
        const tmpMiB = request.tmpMiB;
        builder = builder.volume("/tmp", (m) => m.tmpfs().size(tmpMiB));
      }

      const sandbox = await builder.create();
      return wrapLive(sandbox);
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async get(name: string): Promise<NativeSandboxRecord> {
    try {
      const handle = await Sandbox.get(name);
      return recordFromHandle(handle);
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async list(): Promise<readonly NativeSandboxRecord[]> {
    try {
      const handles = await Sandbox.list();
      return collectDecodableRecordsFromHandles(handles);
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async start(name: string): Promise<NativeLiveHandle> {
    try {
      const sandbox = await Sandbox.startDetached(name);
      return wrapLive(sandbox);
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async stopLiveThenFreshGet(name: string): Promise<NativeSandboxRecord> {
    try {
      const handle = await Sandbox.get(name);
      if (handle.status === "stopped") {
        return recordFromHandle(handle);
      }

      // Acquire a live SDK object for the running sandbox, then stop → detach → fresh get.
      const live = await handle.connect();
      try {
        await live.stop();
      } catch (stopError) {
        try {
          await live.detach();
        } catch {
          // Prefer the original stop failure.
        }
        throw stopError;
      }

      try {
        await live.detach();
      } catch (detachError) {
        throw mapNativeError(detachError);
      }

      const fresh = await Sandbox.get(name);
      return recordFromHandle(fresh);
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await Sandbox.remove(name);
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async probe(): Promise<{ readonly available: boolean; readonly notes: readonly string[] }> {
    try {
      await Sandbox.list();
      return {
        available: true,
        notes: ["Microsandbox SDK loaded and list() succeeded."],
      };
    } catch (error) {
      return {
        available: false,
        notes: [
          error instanceof Error
            ? `Microsandbox probe failed: ${error.message}`
            : "Microsandbox probe failed.",
        ],
      };
    }
  }
}

function wrapLive(sandbox: {
  readonly name: string;
  stop(): Promise<void>;
  detach(): Promise<void>;
}): NativeLiveHandle {
  return {
    name: sandbox.name,
    stop: () => sandbox.stop(),
    detach: () => sandbox.detach(),
  };
}

export function recordFromHandle(handle: {
  readonly name: string;
  readonly status: string;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  config(): unknown;
}): NativeSandboxRecord {
  const decoded = decodeSandboxConfig(handle.config());
  return {
    name: handle.name,
    status: handle.status,
    labels: decoded.labels,
    image: decoded.image,
    cpus: decoded.cpus,
    memoryMiB: decoded.memoryMiB,
    tmpMiB: decoded.tmpMiB,
    workdir: decoded.workdir,
    user: decoded.user,
    shell: decoded.shell,
    hostname: decoded.hostname,
    maxDurationSecs: decoded.maxDurationSecs,
    idleTimeoutSecs: decoded.idleTimeoutSecs,
    env: decoded.env,
    network: decoded.network,
    secrets: decoded.secrets,
    mounts: decoded.mounts.map((mount) => ({
      guestPath: mount.guestPath,
      hostPath: mount.hostPath,
      format: mount.format === "raw" ? "raw" : "qcow2",
      fstype: mount.fstype === "ext4" ? "ext4" : null,
    })),
    bindMounts: decoded.bindMounts.map((mount) => ({
      guestPath: mount.guestPath,
      hostPath: mount.hostPath,
      readonly: mount.readonly,
      ...(mount.quotaMiB !== undefined ? { quotaMiB: mount.quotaMiB } : {}),
    })),
    ...(handle.createdAt !== null ? { createdAt: handle.createdAt.toISOString() } : {}),
    ...(handle.updatedAt !== null ? { updatedAt: handle.updatedAt.toISOString() } : {}),
  };
}

/**
 * Decode native handles for listing.
 *
 * Undecodable *foreign* sandboxes are skipped so they cannot abort the list.
 * Undecodable *managed* sandboxes (ownership marker present) are surfaced —
 * hiding them would make a corrupted sbox resource vanish from `list` with no
 * signal. Labels are peeked independently of full config decode.
 */
export function collectDecodableRecordsFromHandles(
  handles: readonly {
    readonly name: string;
    readonly status: string;
    readonly createdAt: Date | null;
    readonly updatedAt: Date | null;
    config(): unknown;
  }[],
): readonly NativeSandboxRecord[] {
  const records: NativeSandboxRecord[] = [];
  for (const handle of handles) {
    try {
      records.push(recordFromHandle(handle));
    } catch (error) {
      let config: unknown;
      try {
        config = handle.config();
      } catch {
        // Cannot even read config; treat as foreign noise.
        continue;
      }
      const labels = peekSandboxConfigLabels(config);
      if (labels?.[OWNERSHIP_LABEL_KEYS.managed] === MANAGED_LABEL_VALUE) {
        throw SboxError.internal(
          `Managed sandbox ${handle.name} has an undecodable native configuration and cannot be listed.`,
          {
            cause: error,
            details: { nativeName: handle.name },
          },
        );
      }
      // Foreign / unmanaged undecodable entry — skip.
    }
  }
  return records;
}

/**
 * Map native SDK exceptions to application-owned public errors.
 * Native messages may contain secrets or request fragments and are never copied
 * into `SboxError.message`. The native exception is retained only as cause.
 */
export function mapNativeError(error: unknown): SboxError {
  if (error instanceof SboxError) {
    return error;
  }
  if (error instanceof SandboxNotFoundError) {
    return SboxError.notFound("Native sandbox was not found.", {
      cause: error,
      details: safeNativeDetails(error),
    });
  }
  if (error instanceof SandboxAlreadyExistsError) {
    return SboxError.alreadyExists("Native sandbox already exists.", {
      cause: error,
      details: safeNativeDetails(error),
    });
  }
  if (error instanceof SandboxStillRunningError) {
    return SboxError.busy("Native sandbox is still running.", {
      cause: error,
      details: safeNativeDetails(error),
    });
  }
  if (error instanceof InvalidConfigError) {
    return SboxError.validation("Native sandbox configuration is invalid.", {
      cause: error,
      details: safeNativeDetails(error),
    });
  }
  if (error instanceof MicrosandboxError) {
    const unavailable = unavailableReasonForNativeCode(error.code);
    if (unavailable !== undefined) {
      return SboxError.capability("Microsandbox prerequisite is unavailable.", {
        cause: error,
        details: { ...safeNativeDetails(error), unavailableReason: unavailable },
      });
    }
    switch (error.code) {
      case "sandboxNotFound":
        return SboxError.notFound("Native sandbox was not found.", {
          cause: error,
          details: safeNativeDetails(error),
        });
      case "sandboxAlreadyExists":
        return SboxError.alreadyExists("Native sandbox already exists.", {
          cause: error,
          details: safeNativeDetails(error),
        });
      case "sandboxStillRunning":
        return SboxError.busy("Native sandbox is still running.", {
          cause: error,
          details: safeNativeDetails(error),
        });
      case "invalidConfig":
        return SboxError.validation("Native sandbox configuration is invalid.", {
          cause: error,
          details: safeNativeDetails(error),
        });
      case "execTimeout":
        return SboxError.timeout("Native sandbox operation timed out.", {
          cause: error,
          details: safeNativeDetails(error),
        });
      default:
        return SboxError.internal("Native sandbox operation failed.", {
          cause: error,
          details: safeNativeDetails(error),
        });
    }
  }
  if (error instanceof Error) {
    return SboxError.internal("Native sandbox operation failed.", {
      cause: error,
      details: { nativeErrorName: error.name },
    });
  }
  return SboxError.internal("Unknown Microsandbox failure.", { cause: error });
}

export type NativeUnavailableReason =
  | "registry_unavailable"
  | "image_unavailable"
  | "missing_runtime"
  | "unsupported_hypervisor";

function unavailableReasonForNativeCode(code: string): NativeUnavailableReason | undefined {
  switch (code) {
    case "http":
    case "cloudHttp":
      return "registry_unavailable";
    case "image":
    case "imageNotFound":
      return "image_unavailable";
    case "libkrunfwNotFound":
      return "missing_runtime";
    case "unsupported":
    case "unsupportedOperation":
      return "unsupported_hypervisor";
    default:
      return undefined;
  }
}

function safeNativeDetails(error: MicrosandboxError): Readonly<Record<string, unknown>> {
  return Object.freeze({
    nativeErrorName: error.name,
    nativeErrorCode: error.code,
  });
}
