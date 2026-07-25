/**
 * Host-facing managed volume DTOs and create attachments.
 */

import type { ProjectId } from "../identity.js";

/** Safe attachment recorded on immutable creation / inspection. */
export interface VolumeAttachmentSpec {
  readonly volume: string;
  readonly path: string;
}

/** Create-time attachment with resolved logical size in bytes. */
export interface HostVolumeAttachment {
  readonly volume: string;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface HostVolumeSummary {
  readonly project: ProjectId;
  readonly volume: string;
  readonly basePath: string;
  readonly sizeBytes: number;
  readonly descendantCount: number;
}

export interface HostVolumeInspection {
  readonly project: ProjectId;
  readonly volume: string;
  readonly basePath: string;
  readonly sizeBytes: number;
  readonly format: "qcow2";
  readonly descendantCount: number;
}

export interface HostListVolumesRequest {
  readonly project: ProjectId;
}

export interface HostEnsureVolumeRequest {
  readonly project: ProjectId;
  readonly volume: string;
  readonly sizeBytes: number;
}

export interface HostRemoveVolumeRequest {
  readonly project: ProjectId;
  readonly volume: string;
}

export interface HostVolumeShellRequest {
  readonly project: ProjectId;
  readonly volume: string;
  readonly sizeBytes: number;
  /** Profile used for image/resources/environment of the maintenance sandbox. */
  readonly profile: string;
  readonly image: string;
  readonly cpus?: number;
  readonly memoryMiB?: number;
  readonly workdir?: string;
  readonly user?: string;
  readonly shell?: string;
  readonly hostname?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxDurationSecs?: number | null;
  readonly idleTimeoutSecs?: number | null;
  /** Guest mount path for the base (from profile attachment). */
  readonly path: string;
}
