/**
 * Public image DTOs for Host/client/CLI (application-owned, SDK-free).
 */

import type { OperationOptions } from "../types.js";

/** Content-addressed image digest string (`sha256:` + 64 lowercase hex). */
export type ImageContentDigest = `sha256:${string}`;

export type ImageBuildPhase =
  | "identity"
  | "reuse"
  | "workspace"
  | "context"
  | "docker"
  | "stamp"
  | "export"
  | "load"
  | "verify"
  | "cleanup";

/**
 * Structured build progress. Only fixed phases — never raw subprocess text,
 * paths, argv, build args, or secret material.
 */
export type ImageBuildProgressEvent = {
  readonly type: "phase";
  readonly phase: ImageBuildPhase;
  readonly reference?: string;
};

export interface HostImageSummary {
  readonly reference: string;
  readonly contentIdentity: ImageContentDigest;
  readonly algorithmVersion: number;
  readonly owned: boolean;
}

export interface HostImageInspection extends HostImageSummary {
  readonly labels: Readonly<Record<string, string>>;
  readonly reused: boolean;
  readonly built: boolean;
}

export interface HostEnsureImageRequest {
  /** Absolute build context root. */
  readonly contextRoot: string;
  /** Dockerfile path relative to context (POSIX separators). */
  readonly dockerfile: string;
  readonly platform: string;
  readonly target?: string;
  /** Resolved ordinary build arguments. */
  readonly args: Readonly<Record<string, string>>;
  /**
   * Resolved BuildKit secret values keyed by secret id.
   * Host stages owner-only files; values must never be logged or emitted in progress.
   */
  readonly secrets: Readonly<Record<string, string>>;
  readonly includeGit: boolean;
  readonly force?: boolean;
}

export interface HostEnsureImageOptions extends OperationOptions {
  readonly onProgress?: (event: ImageBuildProgressEvent) => void;
  readonly timeoutMs?: number;
}

export interface HostListImagesOptions extends OperationOptions {
  /** When true, include unowned images that happen to match the sbox-img prefix. Default false. */
  readonly includeUnowned?: boolean;
}

export interface HostRemoveImageOptions extends OperationOptions {
  readonly force?: boolean;
}

export interface StaleImageWorkspace {
  readonly path: string;
  readonly createdAt?: string;
  readonly markerPresent: boolean;
}

export interface HostListStaleImageWorkspacesOptions extends OperationOptions {
  /** Override workspace root (tests). */
  readonly workspaceRoot?: string;
}
