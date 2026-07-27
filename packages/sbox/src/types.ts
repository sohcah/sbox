/**
 * Application-owned public DTOs for lifecycle, capabilities, and processes.
 *
 * Process results and events are transport-safe, serializable where applicable,
 * independent of Microsandbox classes, and free of native handles.
 */

import type {
  InstanceId,
  NativeSandboxName,
  ProfileId,
  ProjectId,
  SandboxIdentity,
} from "./identity.js";
import type { LabelMap } from "./ownership.js";
import type {
  HostNetworkConfig,
  ResolvedRuntimeSecret,
  SafeNetworkConfig,
  SafeRuntimeSecret,
} from "./network/types.js";
import type { HostVolumeAttachment, VolumeAttachmentSpec } from "./volume/types.js";
import type { DirectoryAttachmentSpec, HostDirectoryMount } from "./directory/types.js";

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
  /**
   * Curated network. Omit for default-deny with DNS/loopback only.
   * Secret destinations never imply network allow rules.
   */
  readonly network?: HostNetworkConfig;
  /** Resolved runtime secrets (values present only on the create path). */
  readonly secrets?: readonly ResolvedRuntimeSecret[];
  /**
   * Managed volume attachments. Ordinary creates get disposable child overlays;
   * Host ensures bases and creates children under the per-base lock.
   */
  readonly volumes?: readonly HostVolumeAttachment[];
  /** Host directory mounts (Client/Host paths into the guest). */
  readonly directories?: readonly HostDirectoryMount[];
}

export interface HostListOptions extends OperationOptions {
  /** When set, list only sandboxes owned by this project. Default: all sbox-owned. */
  readonly project?: ProjectId;
}

export interface HostCapabilities {
  readonly localMicrosandbox: boolean;
  /** When true, published ports may omit host / use host 0 for dynamic allocation. */
  readonly dynamicHostPorts: boolean;
  /** When true, host `qemu-img` is available for managed volumes. */
  readonly qemuImg: boolean;
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
  /** Safe network projection (no secret values). */
  readonly network: SafeNetworkConfig;
  /** Safe runtime-secret metadata (no values). */
  readonly secrets: readonly SafeRuntimeSecret[];
  /** Volume attachments (name + guest path only). */
  readonly volumes: readonly VolumeAttachmentSpec[];
  /** Directory mounts (identity paths; never Directory stage paths). */
  readonly directories: readonly DirectoryAttachmentSpec[];
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

/**
 * Collected process result. Non-zero guest exit remains a result (not an error).
 * `timedOut` / `cancelled` stay false for normal completion; those conditions
 * throw distinct `SboxError` codes instead of mutating this shape mid-flight.
 */
export interface ProcessResult {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

/** Byte-oriented public streaming events for local and remote Hosts. */
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
