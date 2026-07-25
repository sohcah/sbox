/**
 * Host deep seam: lifecycle, process/PTY/transfer, images, and managed volumes.
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
import type {
  HostEnsureVolumeRequest,
  HostListVolumesRequest,
  HostRemoveVolumeRequest,
  HostVolumeInspection,
  HostVolumeShellRequest,
  HostVolumeSummary,
} from "./volume/types.js";

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

export interface HostTerminalAttachOptions extends OperationOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly user?: string;
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

  listVolumes(
    request: HostListVolumesRequest,
    options?: OperationOptions,
  ): Promise<readonly HostVolumeSummary[]>;
  ensureVolume(
    request: HostEnsureVolumeRequest,
    options?: OperationOptions,
  ): Promise<HostVolumeInspection>;
  removeVolume(request: HostRemoveVolumeRequest, options?: OperationOptions): Promise<void>;
  /**
   * Exclusive maintenance sandbox mounting the base directly.
   * Refuses while ordinary child descendants exist.
   */
  volumeShell(
    request: HostVolumeShellRequest,
    options?: OperationOptions,
  ): Promise<SandboxInspection>;

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
  /**
   * Attach the current host terminal directly when supported.
   * Returns `undefined` when the host requires stream-based PTY bridging.
   */
  attachTerminal?(
    request: HostPtyRequest,
    options?: HostTerminalAttachOptions,
  ): Promise<number | undefined>;
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
