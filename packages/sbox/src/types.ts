/**
 * Application-owned public DTOs for lifecycle, capabilities, and processes.
 *
 * These types establish package boundaries. Process execution is not implemented
 * in Phase 1; the result/event shapes are exported for a stable public contract.
 */

import type {
  InstanceId,
  NativeSandboxName,
  ProfileId,
  ProjectId,
  SandboxIdentity,
} from "./identity.js";
import type { LabelMap } from "./ownership.js";

export type KnownSandboxLifecycleState = "running" | "stopped" | "crashed" | "draining";

/**
 * Lifecycle state projected from Microsandbox. Unknown/future native values are
 * preserved rather than coerced into a known enum member.
 */
export type SandboxLifecycleState =
  | KnownSandboxLifecycleState
  | { readonly kind: "unknown"; readonly native: string };

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export interface HostCreateRequest {
  readonly identity: SandboxIdentity;
  /** Existing OCI/native image reference delegated to Microsandbox. */
  readonly image: string;
  readonly cpus?: number;
  /** Memory in mebibytes. */
  readonly memoryMiB?: number;
  readonly workdir?: string;
  readonly user?: string;
  readonly shell?: string;
  readonly hostname?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Native maximum lifetime in seconds. Null/omit means unset. */
  readonly maxDurationSecs?: number | null;
  /** Native idle timeout in seconds. Null/omit means unset. */
  readonly idleTimeoutSecs?: number | null;
}

export interface HostListOptions extends OperationOptions {
  /** When set, list only sandboxes owned by this project. Default: all sbox-owned. */
  readonly project?: ProjectId;
}

export interface HostCapabilities {
  readonly localMicrosandbox: boolean;
  readonly notes: readonly string[];
}

export interface SandboxCreationSettings {
  readonly image: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly workdir?: string;
  readonly user?: string;
  readonly shell?: string;
  readonly hostname?: string;
  /** Native maximum lifetime in seconds when set. */
  readonly maxDurationSecs?: number;
  /** Native idle timeout in seconds when set. */
  readonly idleTimeoutSecs?: number;
}

export interface SandboxInspection {
  readonly identity: SandboxIdentity;
  readonly nativeName: NativeSandboxName;
  readonly state: SandboxLifecycleState;
  readonly creation: SandboxCreationSettings;
  readonly labels: LabelMap;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface SandboxSummary {
  readonly identity: SandboxIdentity;
  readonly nativeName: NativeSandboxName;
  readonly state: SandboxLifecycleState;
  readonly image: string;
}

/** Collected process result boundary (execution arrives in a later phase). */
export interface ProcessResult {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export type ProcessEvent =
  | { readonly type: "started"; readonly pid?: number }
  | { readonly type: "stdout"; readonly data: Uint8Array }
  | { readonly type: "stderr"; readonly data: Uint8Array }
  | {
      readonly type: "exited";
      readonly exitCode: number;
      readonly signal: string | null;
    };

export function mapNativeLifecycleState(native: string): SandboxLifecycleState {
  switch (native) {
    case "running":
    case "stopped":
    case "crashed":
    case "draining":
      return native;
    default:
      return { kind: "unknown", native };
  }
}

export function sandboxIdentityKey(identity: SandboxIdentity): string {
  return `${identity.project}\0${identity.instance}`;
}

export type { ProjectId, ProfileId, InstanceId, SandboxIdentity, NativeSandboxName };
