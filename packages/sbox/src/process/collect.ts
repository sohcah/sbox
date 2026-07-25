/**
 * Bounded stdout/stderr collection over ProcessEvent streams.
 */

import { SboxError } from "../errors.js";
import type { ProcessEvent, ProcessResult } from "../types.js";
import { concatBytes } from "./decode.js";
import { resolveOutputLimits, type OutputLimits } from "./limits.js";

export interface CollectProcessOptions extends OutputLimits {
  /** Invoked when a stream overflows so the caller can cancel the process. */
  readonly onOverflow?: () => void | Promise<void>;
}

/**
 * Collect a ProcessEvent stream into a ProcessResult, enforcing per-stream
 * byte limits. Overflow cancels via `onOverflow` and throws `output_limit`.
 */
export async function collectProcessEvents(
  events: AsyncIterable<ProcessEvent>,
  options: CollectProcessOptions = {},
): Promise<ProcessResult> {
  const limits = resolveOutputLimits(options);
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exitCode = 0;
  let signal: string | null = null;
  let sawExit = false;

  try {
    for await (const event of events) {
      switch (event.type) {
        case "started":
          break;
        case "stdout": {
          stdoutBytes += event.data.byteLength;
          if (stdoutBytes > limits.stdoutMaxBytes) {
            await options.onOverflow?.();
            throw SboxError.outputLimit("Collected stdout exceeded the configured limit.", {
              details: {
                stream: "stdout",
                limitBytes: limits.stdoutMaxBytes,
                receivedBytes: stdoutBytes,
              },
            });
          }
          stdoutChunks.push(event.data);
          break;
        }
        case "stderr": {
          stderrBytes += event.data.byteLength;
          if (stderrBytes > limits.stderrMaxBytes) {
            await options.onOverflow?.();
            throw SboxError.outputLimit("Collected stderr exceeded the configured limit.", {
              details: {
                stream: "stderr",
                limitBytes: limits.stderrMaxBytes,
                receivedBytes: stderrBytes,
              },
            });
          }
          stderrChunks.push(event.data);
          break;
        }
        case "exited":
          exitCode = event.exitCode;
          signal = event.signal;
          sawExit = true;
          break;
      }
    }
  } catch (error) {
    if (error instanceof SboxError && error.code === "output_limit") {
      throw error;
    }
    throw error;
  }

  if (!sawExit) {
    throw SboxError.internal("Process event stream ended without an exited event.");
  }

  return {
    exitCode,
    signal,
    stdout: concatBytes(stdoutChunks),
    stderr: concatBytes(stderrChunks),
    timedOut: false,
    cancelled: false,
  };
}
