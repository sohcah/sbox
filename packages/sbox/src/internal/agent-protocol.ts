/**
 * Pinned Microsandbox 0.6.6 agent-protocol codec (private).
 *
 * Used only for interactive PTY (and FS symlink/mode ops the Node SDK does not
 * expose). Never exported from the package root.
 *
 * Wire envelope: CBOR `{ v, t, p }` where `p` is nested CBOR payload bytes.
 * Protocol generation for 0.6.6 is 6.
 *
 * Replace this adapter when Microsandbox ships a stable high-level API that
 * supports arbitrary Node streams, merged PTY output, and resize without
 * bridging the host terminal.
 */

import { decode, encode } from "cbor-x";
import { SboxError } from "../errors.js";

export const AGENT_PROTOCOL_VERSION = 6 as const;
export const FLAG_TERMINAL = 0b0000_0001;
export const FLAG_SESSION_START = 0b0000_0010;

export const MSG_EXEC_REQUEST = "core.exec.request";
export const MSG_EXEC_STARTED = "core.exec.started";
export const MSG_EXEC_STDIN = "core.exec.stdin";
export const MSG_EXEC_STDIN_ERROR = "core.exec.stdin.error";
export const MSG_EXEC_STDOUT = "core.exec.stdout";
export const MSG_EXEC_STDERR = "core.exec.stderr";
export const MSG_EXEC_EXITED = "core.exec.exited";
export const MSG_EXEC_FAILED = "core.exec.failed";
export const MSG_EXEC_RESIZE = "core.exec.resize";
export const MSG_EXEC_SIGNAL = "core.exec.signal";
export const MSG_FS_REQUEST = "core.fs.request";
export const MSG_FS_RESPONSE = "core.fs.response";

export interface AgentMessageEnvelope {
  readonly v: number;
  readonly t: string;
  readonly p: Uint8Array;
}

export function encodeEnvelope(type: string, payload: unknown): Buffer {
  const payloadBytes = Buffer.from(encode(payload));
  return Buffer.from(encode({ v: AGENT_PROTOCOL_VERSION, t: type, p: payloadBytes }));
}

export function decodeEnvelope(body: Buffer | Uint8Array): AgentMessageEnvelope {
  let decoded: unknown;
  try {
    decoded = decode(body);
  } catch (error) {
    throw SboxError.protocol("Failed to decode agent protocol envelope.", { cause: error });
  }
  if (decoded === null || typeof decoded !== "object") {
    throw SboxError.protocol("Agent protocol envelope is not an object.");
  }
  const record = decoded as Record<string, unknown>;
  if (typeof record["v"] !== "number" || typeof record["t"] !== "string") {
    throw SboxError.protocol("Agent protocol envelope is missing version or type.");
  }
  const payload = record["p"];
  let p: Uint8Array;
  if (payload instanceof Uint8Array) {
    p = payload;
  } else if (Buffer.isBuffer(payload)) {
    p = payload;
  } else {
    throw SboxError.protocol("Agent protocol envelope payload is not bytes.");
  }
  return { v: record["v"], t: record["t"], p };
}

export function decodePayload<T>(envelope: AgentMessageEnvelope): T {
  try {
    return decode(envelope.p) as T;
  } catch (error) {
    throw SboxError.protocol("Failed to decode agent protocol payload.", { cause: error });
  }
}

export interface ExecRequestPayload {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env: readonly string[];
  readonly cwd?: string;
  readonly user?: string;
  readonly tty: boolean;
  readonly rows: number;
  readonly cols: number;
  readonly rlimits?: readonly unknown[];
}

export interface ExecStartedPayload {
  readonly pid: number;
}

export interface ExecBytesPayload {
  readonly data: Uint8Array;
}

export interface ExecExitedPayload {
  readonly code: number;
}

export interface ExecFailedPayload {
  readonly kind: string;
  readonly message: string;
  readonly errno?: number | null;
  readonly errno_name?: string | null;
  readonly stage?: string | null;
}

export interface ExecResizePayload {
  readonly rows: number;
  readonly cols: number;
}

export interface ExecSignalPayload {
  readonly signal: number;
}

export function encodeExecRequest(payload: ExecRequestPayload): Buffer {
  return encodeEnvelope(MSG_EXEC_REQUEST, {
    cmd: payload.cmd,
    args: [...payload.args],
    env: [...payload.env],
    ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
    ...(payload.user !== undefined ? { user: payload.user } : {}),
    tty: payload.tty,
    rows: payload.rows,
    cols: payload.cols,
    rlimits: payload.rlimits === undefined ? [] : [...payload.rlimits],
  });
}

export function encodeExecStdin(data: Uint8Array): Buffer {
  return encodeEnvelope(MSG_EXEC_STDIN, { data: Buffer.from(data) });
}

export function encodeExecResize(rows: number, cols: number): Buffer {
  return encodeEnvelope(MSG_EXEC_RESIZE, { rows, cols });
}

export function encodeExecSignal(signal: number): Buffer {
  return encodeEnvelope(MSG_EXEC_SIGNAL, { signal });
}

export function encodeFsRequest(op: Record<string, unknown>): Buffer {
  return encodeEnvelope(MSG_FS_REQUEST, { op });
}

export interface FsResponsePayload {
  readonly ok: boolean;
  readonly error?: string | null;
  readonly data?: unknown;
}
