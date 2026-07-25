/**
 * Host-backed sandbox handle implementation.
 * Not part of the public package declaration graph.
 */

import type { Host, HostTerminalAttachOptions } from "../host.js";
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

  async exec(argv: readonly string[], options?: HostCollectedExecOptions): Promise<ProcessResult> {
    this.ensureOpen();
    return this.host.execArgv({ identity: this.identity, argv }, options);
  }

  async execStream(
    argv: readonly string[],
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    this.ensureOpen();
    return this.host.execArgvStream({ identity: this.identity, argv }, options);
  }

  async shell(
    script: string,
    options?: HostCollectedExecOptions & { readonly shell?: string },
  ): Promise<ProcessResult> {
    this.ensureOpen();
    const { shell, ...rest } = options ?? {};
    return this.host.execShell(
      {
        identity: this.identity,
        script,
        ...(shell !== undefined ? { shell } : {}),
      },
      rest,
    );
  }

  async shellStream(
    script: string,
    options?: HostStreamingExecOptions & { readonly shell?: string },
  ): Promise<ProcessSession> {
    this.ensureOpen();
    const { shell, ...rest } = options ?? {};
    return this.host.execShellStream(
      {
        identity: this.identity,
        script,
        ...(shell !== undefined ? { shell } : {}),
      },
      rest,
    );
  }

  async pty(argv: readonly string[], options?: HostPtyOptions): Promise<PtySession> {
    this.ensureOpen();
    return this.host.pty({ identity: this.identity, argv }, options);
  }

  async attachTerminal(
    argv: readonly string[],
    options?: HostTerminalAttachOptions,
  ): Promise<number | undefined> {
    this.ensureOpen();
    return this.host.attachTerminal?.({ identity: this.identity, argv }, options);
  }

  async copyToGuest(hostPath: string, guestPath: string, options?: HostCopyOptions): Promise<void> {
    this.ensureOpen();
    await this.host.copyHostToGuest({ identity: this.identity, hostPath, guestPath }, options);
  }

  async copyFromGuest(
    guestPath: string,
    hostPath: string,
    options?: HostCopyOptions,
  ): Promise<void> {
    this.ensureOpen();
    await this.host.copyGuestToHost({ identity: this.identity, hostPath, guestPath }, options);
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
