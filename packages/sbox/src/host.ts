/**
 * Phase 1 Host lifecycle seam.
 *
 * Deliberately small: create/get/list/inspect/start/stop/remove and a capability
 * probe. Image/volume/process/transfer methods arrive in later phases on this
 * same Host contract.
 */

import type { SandboxIdentity } from "./identity.js";
import type {
  HostCapabilities,
  HostCreateRequest,
  HostListOptions,
  OperationOptions,
  SandboxInspection,
  SandboxSummary,
} from "./types.js";

export interface Host extends AsyncDisposable {
  create(request: HostCreateRequest, options?: OperationOptions): Promise<SandboxInspection>;
  get(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection>;
  list(options?: HostListOptions): Promise<readonly SandboxSummary[]>;
  inspect(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection>;
  start(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection>;
  stop(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection>;
  remove(identity: SandboxIdentity, options?: OperationOptions): Promise<void>;
  capabilities(options?: OperationOptions): Promise<HostCapabilities>;
}

/**
 * Idempotent local cleanup. Must never stop or remove sandboxes.
 */
export async function disposeHost(host: Host): Promise<void> {
  await host[Symbol.asyncDispose]();
}
