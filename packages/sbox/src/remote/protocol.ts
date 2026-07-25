/**
 * Shared remote protocol constants and error wire mapping.
 */

import {
  SboxError,
  type SafeSboxError,
  type SboxErrorCode,
  isAbortError,
  isSboxError,
} from "../errors.js";
import type { HostCapabilities } from "../types.js";

/** Integer protocol version. Pre-1 releases do not carry parallel protocols. */
export const SBOX_PROTOCOL_VERSION = 1 as const;

export interface HealthResponse {
  readonly ok: true;
  readonly protocolVersion: typeof SBOX_PROTOCOL_VERSION;
}

export interface HandshakeResponse {
  readonly protocolVersion: typeof SBOX_PROTOCOL_VERSION;
  readonly capabilities: HostCapabilities;
}

export interface ErrorResponse {
  readonly error: SafeSboxError;
}

export function httpStatusForError(error: SboxError): number {
  switch (error.code) {
    case "validation":
      return 400;
    case "authentication":
      return 401;
    case "capability":
    case "protocol":
      return 403;
    case "not_found":
      return 404;
    case "already_exists":
    case "busy":
    case "ownership_conflict":
      return 409;
    case "timeout":
      return 408;
    case "output_limit":
      return 413;
    case "cancellation":
      // nginx-style client-closed status; clients treat any non-2xx + error body.
      return 499;
    case "transport":
      return 502;
    case "native_state":
    case "internal":
      return 500;
    default:
      return 500;
  }
}

export function errorFromWire(payload: unknown): SboxError {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("error" in payload) ||
    typeof (payload as { error: unknown }).error !== "object" ||
    (payload as { error: unknown }).error === null
  ) {
    return SboxError.protocol("Remote error payload was malformed.");
  }
  const err = (payload as { error: SafeSboxError }).error;
  if (typeof err.code !== "string" || typeof err.message !== "string") {
    return SboxError.protocol("Remote error payload was malformed.");
  }
  return new SboxError(err.code as SboxErrorCode, err.message, {
    details: typeof err.details === "object" && err.details !== null ? err.details : {},
  });
}

export function toErrorResponse(error: unknown): ErrorResponse {
  if (isSboxError(error)) {
    return { error: error.toSafeJSON() };
  }
  if (isAbortError(error)) {
    return { error: SboxError.cancellation("Request was cancelled.").toSafeJSON() };
  }
  return {
    error: SboxError.internal("An internal sbox error occurred.", { cause: error }).toSafeJSON(),
  };
}

export function assertProtocolVersion(
  version: unknown,
): asserts version is typeof SBOX_PROTOCOL_VERSION {
  if (version !== SBOX_PROTOCOL_VERSION) {
    throw SboxError.protocol(
      `Incompatible sbox protocol version (got ${String(version)}, need ${SBOX_PROTOCOL_VERSION}).`,
      { details: { got: version, expected: SBOX_PROTOCOL_VERSION } },
    );
  }
}
