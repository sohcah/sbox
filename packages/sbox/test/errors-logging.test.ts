import { describe, expect, it } from "vitest";
import { SECRET_DETAIL_CANARY_KEYS, SboxError, isSboxError } from "../src/errors.js";
import {
  SECRET_LOG_CANARY_KEYS,
  collectingLogger,
  createRedactingLogger,
  silentLogger,
} from "../src/logging.js";

describe("SboxError", () => {
  it("uses a compact discriminated code union", () => {
    const error = SboxError.notFound("missing", {
      details: { project: "demo", token: "super-secret" },
    });
    expect(isSboxError(error)).toBe(true);
    expect(error.code).toBe("not_found");
    const safe = error.toSafeJSON();
    expect(safe.details["token"]).toBe("[redacted]");
    expect(safe.details["project"]).toBe("demo");
    expect(JSON.stringify(safe)).not.toContain("super-secret");
  });

  it("redacts secret canary keys in details", () => {
    const details: Record<string, string> = {};
    for (const key of SECRET_DETAIL_CANARY_KEYS) {
      details[key] = `value-for-${key}`;
    }
    const safe = SboxError.internal("boom", { details }).toSafeJSON();
    for (const key of SECRET_DETAIL_CANARY_KEYS) {
      expect(safe.details[key]).toBe("[redacted]");
    }
  });
});

describe("logging", () => {
  it("keeps libraries silent by default", () => {
    expect(() =>
      silentLogger.log({
        level: "info",
        message: "should not throw",
        details: { token: "secret" },
      }),
    ).not.toThrow();
  });

  it("redacts secret-bearing log details", () => {
    const { logger, events } = collectingLogger();
    const redacting = createRedactingLogger(logger);
    const details: Record<string, string> = { project: "demo" };
    for (const key of SECRET_LOG_CANARY_KEYS) {
      details[key] = `value-for-${key}`;
    }
    redacting.log({
      level: "info",
      message: "op",
      operation: "create",
      details,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.details?.["project"]).toBe("demo");
    for (const key of SECRET_LOG_CANARY_KEYS) {
      expect(events[0]?.details?.[key]).toBe("[redacted]");
    }
  });
});
