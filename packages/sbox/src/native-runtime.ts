/**
 * Narrow native Microsandbox seam used by LocalHost.
 *
 * Keeps SDK types out of the public package surface while allowing contract
 * tests to inject a fake runtime without Docker/virtualization.
 */

import type { LabelMap } from "./ownership.js";
import type { SandboxLifecycleState } from "./types.js";

export interface NativeSandboxRecord {
  readonly name: string;
  readonly status: string;
  readonly labels: LabelMap;
  readonly image: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly workdir: string | null;
  readonly user: string | null;
  readonly shell: string | null;
  readonly hostname: string | null;
  /** Ordinary environment only; never logged or placed in public inspection. */
  readonly env: Readonly<Record<string, string>>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface NativeCreateRequest {
  readonly name: string;
  readonly image: string;
  readonly labels: LabelMap;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly workdir: string | null;
  readonly user: string | null;
  readonly shell: string | null;
  readonly hostname: string | null;
  readonly env: Readonly<Record<string, string>>;
  /** When true, create as native detached / non-ephemeral. */
  readonly detached: boolean;
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
