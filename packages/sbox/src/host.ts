/**
 * Host deep seam: lifecycle, process/PTY/transfer, and generated images.
 *
 * Volume methods arrive in later phases on this same contract.
 */

import type { SandboxIdentity } from "./identity.js";
import type {
  HostEnsureImageOptions,
  HostEnsureImageRequest,
  HostImageInspection,
  HostImageSummary,
  HostListImagesOptions,
  HostListStaleImageWorkspacesOptions,
  HostRemoveImageOptions,
  StaleImageWorkspace,
} from "./image/types.js";
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
  SandboxInspection,
  SandboxSummary,
} from "./types.js";

export interface HostExecArgvRequest {
  readonly identity: SandboxIdentity;
  readonly argv: readonly string[];
}

export interface HostExecShellRequest {
  readonly identity: SandboxIdentity;
  readonly script: string;
  /** Guest shell path. Defaults to `/bin/sh` when omitted. */
  readonly shell?: string;
}

export interface HostPtyRequest {
  readonly identity: SandboxIdentity;
  readonly argv: readonly string[];
}

export interface HostCopyPaths {
  readonly identity: SandboxIdentity;
  readonly hostPath: string;
  readonly guestPath: string;
}

export interface Host extends AsyncDisposable {
  create(request: HostCreateRequest, options?: OperationOptions): Promise<SandboxInspection>;
  get(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection>;
  list(options?: HostListOptions): Promise<readonly SandboxSummary[]>;
  inspect(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection>;
  start(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection>;
  stop(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection>;
  remove(identity: SandboxIdentity, options?: OperationOptions): Promise<void>;
  capabilities(options?: OperationOptions): Promise<HostCapabilities>;

  ensureImage(
    request: HostEnsureImageRequest,
    options?: HostEnsureImageOptions,
  ): Promise<HostImageInspection>;
  listImages(options?: HostListImagesOptions): Promise<readonly HostImageSummary[]>;
  removeImage(reference: string, options?: HostRemoveImageOptions): Promise<void>;
  listStaleImageWorkspaces(
    options?: HostListStaleImageWorkspacesOptions,
  ): Promise<readonly StaleImageWorkspace[]>;

  execArgv(
    request: HostExecArgvRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult>;
  execArgvStream(
    request: HostExecArgvRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession>;
  execShell(
    request: HostExecShellRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult>;
  execShellStream(
    request: HostExecShellRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession>;
  pty(request: HostPtyRequest, options?: HostPtyOptions): Promise<PtySession>;

  copyHostToGuest(request: HostCopyPaths, options?: HostCopyOptions): Promise<void>;
  copyGuestToHost(request: HostCopyPaths, options?: HostCopyOptions): Promise<void>;
}

/**
 * Idempotent local cleanup. Must never stop or remove sandboxes.
 */
export async function disposeHost(host: Host): Promise<void> {
  await host[Symbol.asyncDispose]();
}
