/**
 * Host-backed sandbox handle implementation.
 * Not part of the public package declaration graph.
 */

import type { Host } from "../host.js";
import type { SandboxIdentity } from "../identity.js";
import type { OperationOptions, SandboxInspection } from "../types.js";
import type { SandboxHandle } from "./handle.js";

export class HostSandboxHandle implements SandboxHandle {
  private disposed = false;

  constructor(
    private readonly host: Host,
    readonly identity: SandboxIdentity,
  ) {}

  async inspect(options?: OperationOptions): Promise<SandboxInspection> {
    this.ensureOpen();
    return this.host.inspect(this.identity, options);
  }

  async start(options?: OperationOptions): Promise<SandboxInspection> {
    this.ensureOpen();
    return this.host.start(this.identity, options);
  }

  async stop(options?: OperationOptions): Promise<SandboxInspection> {
    this.ensureOpen();
    return this.host.stop(this.identity, options);
  }

  async remove(options?: OperationOptions): Promise<void> {
    this.ensureOpen();
    await this.host.remove(this.identity, options);
  }

  /**
   * Idempotent local disposal. Never stops or removes the sandbox.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }

  private ensureOpen(): void {
    if (this.disposed) {
      // Disposal releases only local handle bookkeeping.
    }
  }
}
