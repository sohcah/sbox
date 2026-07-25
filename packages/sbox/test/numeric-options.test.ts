import { describe, expect, it } from "vitest";
import { assertPtyDimension, assertTimeoutMs, resolveOutputLimits } from "../src/process/limits.js";
import { collectProcessEvents, utf8ToBytes, type ProcessEvent } from "../src/index.js";

async function* eventsOf(items: readonly ProcessEvent[]): AsyncGenerator<ProcessEvent> {
  for (const item of items) {
    yield item;
  }
}

describe("numeric option validation", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["fraction", 1.5],
  ])("rejects stdoutMaxBytes=%s", async (_label, value) => {
    await expect(
      collectProcessEvents(
        eventsOf([
          { type: "started" },
          { type: "stdout", data: utf8ToBytes("x") },
          { type: "exited", exitCode: 0, signal: null },
        ]),
        { stdoutMaxBytes: value },
      ),
    ).rejects.toMatchObject({ code: "validation", details: { path: "stdoutMaxBytes" } });
  });

  it("rejects stderrMaxBytes NaN so overflow cannot be disabled", () => {
    expect(() => resolveOutputLimits({ stderrMaxBytes: Number.NaN })).toThrowError(
      expect.objectContaining({ code: "validation" }),
    );
  });

  it("accepts zero and positive safe integer bounds", () => {
    expect(resolveOutputLimits({ stdoutMaxBytes: 0, stderrMaxBytes: 1 })).toEqual({
      stdoutMaxBytes: 0,
      stderrMaxBytes: 1,
    });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -5],
    ["fraction", 1.2],
  ])("rejects timeoutMs=%s", (_label, value) => {
    expect(() => assertTimeoutMs(value)).toThrowError(
      expect.objectContaining({ code: "validation" }),
    );
  });

  it("accepts positive timeoutMs and leaves undefined alone", () => {
    expect(assertTimeoutMs(undefined)).toBeUndefined();
    expect(assertTimeoutMs(1)).toBe(1);
  });

  it.each([
    ["NaN", Number.NaN],
    ["zero", 0],
    ["too large", 65536],
    ["fraction", 1.5],
    ["negative", -1],
  ])("rejects PTY dimension %s", (_label, value) => {
    expect(() => assertPtyDimension(value, "rows")).toThrowError(
      expect.objectContaining({ code: "validation" }),
    );
  });

  it("accepts PTY dimension boundaries", () => {
    expect(assertPtyDimension(1, "rows")).toBe(1);
    expect(assertPtyDimension(65535, "cols")).toBe(65535);
  });
});
