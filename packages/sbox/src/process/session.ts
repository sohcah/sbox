/**
 * Public streaming process session contracts.
 *
 * Sessions own the controlled process. Cancellation, timeout, overflow, and
 * stream teardown all clean up the process. No process intentionally survives
 * its controlling session.
 */

import type { ProcessEvent, ProcessResult } from "../types.js";
import type { OutputLimits } from "./limits.js";

/** Backpressured stdin writer for a streaming process. */
export interface ProcessStdin {
  write(data: Uint8Array | string): Promise<void>;
  /** Explicit EOF. Idempotent. */
  end(): Promise<void>;
}

export interface ProcessSession extends AsyncIterable<ProcessEvent>, AsyncDisposable {
  readonly stdin: ProcessStdin;
  /**
   * Wait for process settlement. Does not drain output events — callers must
   * consume this async iterable (or cancel) so a bounded queue cannot stall
   * the native pump indefinitely.
   */
  wait(): Promise<{ readonly exitCode: number; readonly signal: string | null }>;
  /** Cancel the controlled process. Distinct from timeout. */
  cancel(reason?: string): Promise<void>;
}

export interface PtySize {
  readonly rows: number;
  readonly cols: number;
}

export interface PtySession extends AsyncDisposable {
  /**
   * Merged terminal output (PTY master). Pull-driven through a bounded queue;
   * callers must consume or cancel. `wait()` does not drain output.
   */
  readonly output: AsyncIterable<Uint8Array>;
  write(data: Uint8Array | string): Promise<void>;
  resize(size: PtySize): Promise<void>;
  wait(): Promise<{ readonly exitCode: number; readonly signal: string | null }>;
  /** Cancel the controlled process. Distinct from timeout. */
  cancel(reason?: string): Promise<void>;
}

export interface HostExecBaseOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Explicit guest user override (including `"root"`). */
  readonly user?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HostCollectedExecOptions extends HostExecBaseOptions, OutputLimits {
  /** String or byte stdin for collected execution. */
  readonly stdin?: string | Uint8Array;
}

export interface HostStreamingExecOptions extends HostExecBaseOptions {
  /**
   * Optional async byte source for stdin. Chunks are written with backpressure.
   * EOF is sent when the iterable completes.
   */
  readonly stdin?: AsyncIterable<Uint8Array>;
}

export interface HostPtyOptions extends HostExecBaseOptions {
  readonly rows?: number;
  readonly cols?: number;
  /**
   * Optional readable input source. Bytes are forwarded with backpressure.
   * When the source ends, the PTY session remains open until exit/cancel
   * (PTY stdin EOF does not close the session).
   */
  readonly input?: AsyncIterable<Uint8Array>;
}

export type { ProcessResult, ProcessEvent, OutputLimits };
