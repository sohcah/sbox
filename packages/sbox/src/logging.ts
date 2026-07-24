/**
 * Structured logging. Libraries are silent unless a logger is provided.
 * Values that look like secrets are redacted.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEvent {
  readonly level: LogLevel;
  readonly message: string;
  readonly operation?: string;
  readonly durationMs?: number;
  readonly resultCode?: string;
  readonly project?: string;
  readonly profile?: string;
  readonly instance?: string;
  readonly nativeName?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Logger {
  log(event: LogEvent): void;
}

const SECRET_KEY_PATTERN =
  /(secret|password|token|apikey|api[_-]?key|authorization|credential|passwd)/i;

export const SECRET_LOG_CANARY_KEYS = [
  "secret",
  "password",
  "token",
  "apiKey",
  "api_key",
  "authorization",
  "credential",
] as const;

/** No-op logger used when callers do not supply one. */
export const silentLogger: Logger = {
  log() {
    // Libraries remain silent by default.
  },
};

export function createRedactingLogger(inner: Logger): Logger {
  return {
    log(event: LogEvent): void {
      inner.log(redactLogEvent(event));
    },
  };
}

/**
 * Isolate logger callbacks from operation outcomes. Failures are swallowed.
 */
export function safeLog(logger: Logger, event: LogEvent): void {
  try {
    logger.log(event);
  } catch {
    // Logger callbacks must never mutate lifecycle results.
  }
}

export function redactLogEvent(event: LogEvent): LogEvent {
  const details =
    event.details === undefined ? undefined : (redactRecord(event.details) as LogEvent["details"]);
  return {
    level: event.level,
    message: event.message,
    ...(event.operation !== undefined ? { operation: event.operation } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.resultCode !== undefined ? { resultCode: event.resultCode } : {}),
    ...(event.project !== undefined ? { project: event.project } : {}),
    ...(event.profile !== undefined ? { profile: event.profile } : {}),
    ...(event.instance !== undefined ? { instance: event.instance } : {}),
    ...(event.nativeName !== undefined ? { nativeName: event.nativeName } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function redactRecord(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(value);
  }
  return out;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === "object") {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}

export function collectingLogger(): {
  readonly logger: Logger;
  readonly events: LogEvent[];
} {
  const events: LogEvent[] = [];
  return {
    events,
    logger: {
      log(event) {
        events.push(redactLogEvent(event));
      },
    },
  };
}
