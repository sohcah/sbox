/**
 * Public typed-error contract for `@sohcah/sbox`.
 *
 * Operational failures throw `SboxError`. Guest non-zero exits are process
 * results, never errors. Native SDK exception classes are never exported.
 */

export const SBOX_ERROR_CODES = [
  "validation",
  "capability",
  "not_found",
  "already_exists",
  "busy",
  "ownership_conflict",
  "authentication",
  "protocol",
  "transport",
  "cancellation",
  "timeout",
  "output_limit",
  "native_state",
  "internal",
] as const;

export type SboxErrorCode = (typeof SBOX_ERROR_CODES)[number];

export type SboxErrorDetails = Readonly<Record<string, unknown>>;

export interface SafeSboxError {
  readonly name: "SboxError";
  readonly code: SboxErrorCode;
  readonly message: string;
  readonly details: SboxErrorDetails;
}

export interface SboxErrorOptions {
  readonly details?: SboxErrorDetails;
  readonly cause?: unknown;
}

export class SboxError extends Error {
  readonly code: SboxErrorCode;
  declare readonly details: SboxErrorDetails;

  constructor(code: SboxErrorCode, message: string, options: SboxErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SboxError";
    this.code = code;
    Object.defineProperty(this, "details", {
      value: Object.freeze(options.details === undefined ? {} : { ...options.details }),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  toSafeJSON(): SafeSboxError {
    return {
      name: "SboxError",
      code: this.code,
      message: this.message,
      details: redactDetails(this.details),
    };
  }

  /** Default JSON serialization is always redacted. */
  toJSON(): SafeSboxError {
    return this.toSafeJSON();
  }

  static validation(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("validation", message, options);
  }

  static capability(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("capability", message, options);
  }

  static notFound(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("not_found", message, options);
  }

  static alreadyExists(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("already_exists", message, options);
  }

  static busy(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("busy", message, options);
  }

  static ownershipConflict(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("ownership_conflict", message, options);
  }

  static authentication(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("authentication", message, options);
  }

  static protocol(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("protocol", message, options);
  }

  static transport(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("transport", message, options);
  }

  static cancellation(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("cancellation", message, options);
  }

  static timeout(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("timeout", message, options);
  }

  static outputLimit(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("output_limit", message, options);
  }

  static nativeState(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("native_state", message, options);
  }

  static internal(message: string, options?: SboxErrorOptions): SboxError {
    return new SboxError("internal", message, options);
  }
}

const SECRET_KEY_PATTERN =
  /(secret|password|token|apikey|api[_-]?key|authorization|credential|passwd)/i;

/** Keys that must never appear unredacted in serialized error details. */
export const SECRET_DETAIL_CANARY_KEYS = [
  "secret",
  "password",
  "token",
  "apiKey",
  "api_key",
  "authorization",
  "credential",
] as const;

function redactDetails(details: SboxErrorDetails): SboxErrorDetails {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(value);
  }
  return Object.freeze(out);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(nested);
    }
    return out;
  }
  return value;
}

export function isSboxError(error: unknown): error is SboxError {
  return error instanceof SboxError;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return false;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) {
    return;
  }
  if (!signal.aborted) {
    return;
  }
  throw SboxError.cancellation(
    "Operation was cancelled.",
    signal.reason !== undefined ? { cause: signal.reason } : undefined,
  );
}

export function wrapUnknownFailure(
  error: unknown,
  message = "An internal sbox error occurred.",
): SboxError {
  if (isSboxError(error)) {
    return error;
  }
  if (isAbortError(error)) {
    return SboxError.cancellation("Operation was cancelled.", { cause: error });
  }
  return SboxError.internal(message, { cause: error });
}
