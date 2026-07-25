/**
 * Byte encoding helpers for JSON wire payloads (Uint8Array ↔ base64).
 */

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function encodeProcessResult(result: {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}): {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
} {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: bytesToBase64(result.stdout),
    stderr: bytesToBase64(result.stderr),
    timedOut: result.timedOut,
    cancelled: result.cancelled,
  };
}

export function decodeProcessResult(raw: {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}): {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
} {
  return {
    exitCode: raw.exitCode,
    signal: raw.signal,
    stdout: base64ToBytes(raw.stdout),
    stderr: base64ToBytes(raw.stderr),
    timedOut: raw.timedOut,
    cancelled: raw.cancelled,
  };
}
