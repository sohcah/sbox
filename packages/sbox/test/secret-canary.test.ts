/**
 * Consolidated secret-canary coverage for diagnostics surfaces used by Phase 9.
 * Domain-specific canaries also live in network/process/transfer/image tests.
 */

import { describe, expect, it } from "vitest";
import { SECRET_DETAIL_CANARY_KEYS, SboxError } from "../src/errors.js";
import { SECRET_LOG_CANARY_KEYS, collectingLogger, createRedactingLogger } from "../src/logging.js";
import { formatCliResult } from "../src/cli/format.js";

const VALUE_CANARY = "phase9-secret-canary-VALUE-7e1a";

describe("secret canary consolidation", () => {
  it("redacts canary keys in SafeSboxError and CLI JSON", () => {
    const details: Record<string, string> = { project: "demo" };
    for (const key of SECRET_DETAIL_CANARY_KEYS) {
      details[key] = VALUE_CANARY;
    }
    const safe = SboxError.authentication("denied", { details }).toSafeJSON();
    const json = formatCliResult(
      {
        ok: false,
        command: "doctor",
        error: safe,
      },
      "json",
    );
    expect(json).not.toContain(VALUE_CANARY);
    expect(JSON.stringify(safe)).not.toContain(VALUE_CANARY);
    for (const key of SECRET_DETAIL_CANARY_KEYS) {
      expect(safe.details[key]).toBe("[redacted]");
    }
  });

  it("keeps canary values out of single-line JSON diagnostics", () => {
    const safe = SboxError.internal("boom", {
      details: { token: VALUE_CANARY, password: VALUE_CANARY },
    }).toSafeJSON();
    const line = `${JSON.stringify({ type: "error", error: safe })}\n`;
    expect(line).not.toContain(VALUE_CANARY);
    expect(line.startsWith("{")).toBe(true);
  });

  it("redacts canary keys through the redacting logger", () => {
    const { logger, events } = collectingLogger();
    const redacting = createRedactingLogger(logger);
    const details: Record<string, string> = { argv: "safe" };
    for (const key of SECRET_LOG_CANARY_KEYS) {
      details[key] = VALUE_CANARY;
    }
    redacting.log({
      level: "error",
      message: "diagnostic",
      operation: "doctor",
      details,
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(VALUE_CANARY);
    for (const key of SECRET_LOG_CANARY_KEYS) {
      expect(events[0]?.details?.[key]).toBe("[redacted]");
    }
  });
});
