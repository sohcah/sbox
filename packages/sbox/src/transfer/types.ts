/**
 * Host↔guest copy request contracts.
 */

export type TransferOverwrite = "error" | "replace";

export interface HostCopyOptions {
  readonly signal?: AbortSignal;
  /**
   * When the destination already exists:
   * - `error` (default): fail without modifying the destination
   * - `replace`: replace files atomically where practical; fail on
   *   file/directory kind conflicts
   */
  readonly overwrite?: TransferOverwrite;
}

export interface HostCopyRequest {
  readonly identity: import("../identity.js").SandboxIdentity;
  readonly hostPath: string;
  readonly guestPath: string;
}
