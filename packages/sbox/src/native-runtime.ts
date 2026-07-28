/**
 * Narrow native Microsandbox seam used by LocalHost.
 *
 * Keeps SDK types out of the public package surface while allowing contract
 * tests to inject a fake runtime without Docker/virtualization.
 */

import type { LabelMap } from "./ownership.js";
import type { SandboxLifecycleState } from "./types.js";
import type {
  HostNetworkConfig,
  ResolvedRuntimeSecret,
  SafeRuntimeSecret,
} from "./network/types.js";

export interface NativeDiskMount {
  readonly guestPath: string;
  readonly hostPath: string;
  /** `qcow2` or `raw`. */
  readonly format: "qcow2" | "raw";
  /** Filesystem type for a virtio-blk disk mount (ordinary volumes use ext4). */
  readonly fstype: "ext4" | null;
}

/** Host file or directory bind. */
export interface NativeBindMount {
  readonly guestPath: string;
  readonly hostPath: string;
  readonly readonly: boolean;
  /** Guest-write quota in MiB; optional when writable (MSB protective default). */
  readonly quotaMiB?: number;
}

export interface NativeSandboxRecord {
  readonly name: string;
  readonly status: string;
  readonly labels: LabelMap;
  readonly image: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  /** Explicit `/tmp` tmpfs size when present in SandboxConfig; otherwise null. */
  readonly tmpMiB: number | null;
  readonly workdir: string | null;
  readonly user: string | null;
  readonly shell: string | null;
  readonly hostname: string | null;
  readonly maxDurationSecs: number | null;
  readonly idleTimeoutSecs: number | null;
  /** Ordinary environment only; never logged or placed in public inspection. */
  readonly env: Readonly<Record<string, string>>;
  readonly network: HostNetworkConfig;
  readonly secrets: readonly SafeRuntimeSecret[];
  readonly mounts: readonly NativeDiskMount[];
  /** Decoded Bind mounts from SandboxConfig (Host directory mounts). */
  readonly bindMounts: readonly NativeBindMount[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface NativeCreateRequest {
  readonly name: string;
  readonly image: string;
  readonly labels: LabelMap;
  readonly cpus: number;
  readonly memoryMiB: number;
  /** When non-null, mounts a sized tmpfs at `/tmp` (overrides MSB default). */
  readonly tmpMiB: number | null;
  readonly workdir: string | null;
  readonly user: string | null;
  readonly shell: string | null;
  readonly hostname: string | null;
  readonly maxDurationSecs: number | null;
  readonly idleTimeoutSecs: number | null;
  readonly env: Readonly<Record<string, string>>;
  readonly network: HostNetworkConfig;
  readonly secrets: readonly ResolvedRuntimeSecret[];
  /** When true, create as native detached / non-ephemeral. */
  readonly detached: boolean;
  /** Managed disk mounts (child overlays or maintenance base). */
  readonly mounts?: readonly NativeDiskMount[];
  /**
   * Bind mounts: product Host directory mounts and internal formatter staging.
   */
  readonly bindMounts?: readonly NativeBindMount[];
}

export interface NativeLiveHandle {
  readonly name: string;
  stop(): Promise<void>;
  /**
   * Consume/detach the live SDK object without changing sandbox lifecycle.
   * Required after stop when disks may be attached.
   */
  detach(): Promise<void>;
}

export type NativeCall =
  | { readonly op: "create"; readonly name: string }
  | { readonly op: "get"; readonly name: string }
  | { readonly op: "list" }
  | { readonly op: "start"; readonly name: string }
  | { readonly op: "connect"; readonly name: string }
  | { readonly op: "liveStop"; readonly name: string }
  | { readonly op: "liveDetach"; readonly name: string }
  | { readonly op: "remove"; readonly name: string }
  | { readonly op: "probe" };

export interface NativeRuntime {
  create(request: NativeCreateRequest): Promise<NativeLiveHandle>;
  get(name: string): Promise<NativeSandboxRecord>;
  list(): Promise<readonly NativeSandboxRecord[]>;
  start(name: string): Promise<NativeLiveHandle>;
  /**
   * Acquire a live SDK object for a running sandbox, stop it, detach/consume
   * that same object, then return a fresh get() record.
   */
  stopLiveThenFreshGet(name: string): Promise<NativeSandboxRecord>;
  remove(name: string): Promise<void>;
  probe(): Promise<{ readonly available: boolean; readonly notes: readonly string[] }>;
}

export function mapNativeStatus(status: string): SandboxLifecycleState {
  switch (status) {
    case "running":
    case "stopped":
    case "crashed":
    case "draining":
      return status;
    default:
      return { kind: "unknown", native: status };
  }
}
