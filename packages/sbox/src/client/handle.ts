/**
 * Public sandbox handle contract. Disposal never changes sandbox lifecycle.
 */

import type { SandboxIdentity } from "../identity.js";
import type {
  HostCollectedExecOptions,
  HostPtyOptions,
  HostStreamingExecOptions,
  ProcessSession,
  PtySession,
} from "../process/session.js";
import type { HostCopyOptions } from "../transfer/types.js";
import type { OperationOptions, ProcessResult, SandboxInspection } from "../types.js";

export interface SandboxHandle extends AsyncDisposable {
  readonly identity: SandboxIdentity;
  inspect(options?: OperationOptions): Promise<SandboxInspection>;
  start(options?: OperationOptions): Promise<SandboxInspection>;
  stop(options?: OperationOptions): Promise<SandboxInspection>;
  remove(options?: OperationOptions): Promise<void>;

  /** Exact-argv collected execution. Shell interpretation is never applied. */
  exec(argv: readonly string[], options?: HostCollectedExecOptions): Promise<ProcessResult>;
  /** Exact-argv streaming execution. */
  execStream(argv: readonly string[], options?: HostStreamingExecOptions): Promise<ProcessSession>;
  /** Explicit guest-shell collected execution using the configured/default shell. */
  shell(
    script: string,
    options?: HostCollectedExecOptions & { readonly shell?: string },
  ): Promise<ProcessResult>;
  /** Explicit guest-shell streaming execution. */
  shellStream(
    script: string,
    options?: HostStreamingExecOptions & { readonly shell?: string },
  ): Promise<ProcessSession>;
  /** Interactive PTY with arbitrary streams, resize, and merged output. */
  pty(argv: readonly string[], options?: HostPtyOptions): Promise<PtySession>;

  copyToGuest(hostPath: string, guestPath: string, options?: HostCopyOptions): Promise<void>;
  copyFromGuest(guestPath: string, hostPath: string, options?: HostCopyOptions): Promise<void>;
}
