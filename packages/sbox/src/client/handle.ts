/**
 * Public sandbox handle contract. Disposal never changes sandbox lifecycle.
 */

import type { SandboxIdentity } from "../identity.js";
import type { OperationOptions, SandboxInspection } from "../types.js";

export interface SandboxHandle extends AsyncDisposable {
  readonly identity: SandboxIdentity;
  inspect(options?: OperationOptions): Promise<SandboxInspection>;
  start(options?: OperationOptions): Promise<SandboxInspection>;
  stop(options?: OperationOptions): Promise<SandboxInspection>;
  remove(options?: OperationOptions): Promise<void>;
}
