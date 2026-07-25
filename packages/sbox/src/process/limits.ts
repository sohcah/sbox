/**
 * Collected stdout/stderr limits. Overflow terminates the controlled process
 * and throws `output_limit`.
 */

import { SboxError } from "../errors.js";

/** Default per-stream collection bound (10 MiB). */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;

export interface OutputLimits {
  readonly stdoutMaxBytes?: number;
  readonly stderrMaxBytes?: number;
}

/**
 * Resolve collection bounds. Explicit values must be finite nonnegative safe
 * integers; otherwise validation fails (including `NaN`, which would otherwise
 * disable overflow checks).
 */
export function resolveOutputLimits(limits?: OutputLimits): {
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
} {
  return {
    stdoutMaxBytes: resolveBound(limits?.stdoutMaxBytes, "stdoutMaxBytes"),
    stderrMaxBytes: resolveBound(limits?.stderrMaxBytes, "stderrMaxBytes"),
  };
}

function resolveBound(value: number | undefined, path: string): number {
  if (value === undefined) {
    return DEFAULT_OUTPUT_LIMIT_BYTES;
  }
  return assertNonNegativeSafeInteger(value, path);
}

/** Finite nonnegative safe integer (0 allowed). */
export function assertNonNegativeSafeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw SboxError.validation(`${path} must be a finite nonnegative safe integer.`, {
      details: { path },
    });
  }
  return value;
}

/** Finite positive safe integer (1..). */
export function assertPositiveSafeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw SboxError.validation(`${path} must be a finite positive safe integer.`, {
      details: { path },
    });
  }
  return value;
}

/**
 * Optional timeout. When provided, must be a finite positive safe integer.
 */
export function assertTimeoutMs(value: number | undefined, path = "timeoutMs"): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertPositiveSafeInteger(value, path);
}

/** PTY rows/cols: integers in 1..65535. */
export function assertPtyDimension(value: number, path: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw SboxError.validation(`${path} must be an integer in 1..65535.`, {
      details: { path },
    });
  }
  return value;
}
