import { describe, expect, it, vi } from "vitest";
import { collectProcessEvents, utf8ToBytes, type ProcessEvent } from "../src/index.js";

async function* eventsOf(items: readonly ProcessEvent[]): AsyncGenerator<ProcessEvent> {
  for (const item of items) {
    yield item;
  }
}

describe("collectProcessEvents", () => {
  it("collects stdout/stderr and treats non-zero exit as a result", async () => {
    const result = await collectProcessEvents(
      eventsOf([
        { type: "started", pid: 7 },
        { type: "stdout", data: utf8ToBytes("out") },
        { type: "stderr", data: utf8ToBytes("err") },
        { type: "exited", exitCode: 42, signal: null },
      ]),
    );
    expect(result.exitCode).toBe(42);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(Buffer.from(result.stdout).toString()).toBe("out");
    expect(Buffer.from(result.stderr).toString()).toBe("err");
  });

  it("enforces stdout limits and calls onOverflow before throwing output_limit", async () => {
    const onOverflow = vi.fn();
    await expect(
      collectProcessEvents(
        eventsOf([
          { type: "started" },
          { type: "stdout", data: utf8ToBytes("abcdef") },
          { type: "exited", exitCode: 0, signal: null },
        ]),
        { stdoutMaxBytes: 4, onOverflow },
      ),
    ).rejects.toMatchObject({
      code: "output_limit",
      details: expect.objectContaining({ stream: "stdout", limitBytes: 4 }),
    });
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it("enforces stderr limits independently", async () => {
    const onOverflow = vi.fn(async () => undefined);
    await expect(
      collectProcessEvents(
        eventsOf([
          { type: "stderr", data: new Uint8Array([1, 2, 3, 4, 5]) },
          { type: "exited", exitCode: 0, signal: null },
        ]),
        { stderrMaxBytes: 3, onOverflow },
      ),
    ).rejects.toMatchObject({ code: "output_limit", details: { stream: "stderr" } });
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it("throws internal when the stream ends without exited", async () => {
    await expect(
      collectProcessEvents(eventsOf([{ type: "stdout", data: utf8ToBytes("x") }])),
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("concatenates multiple stdout chunks under the limit", async () => {
    const result = await collectProcessEvents(
      eventsOf([
        { type: "stdout", data: utf8ToBytes("ab") },
        { type: "stdout", data: utf8ToBytes("cd") },
        { type: "exited", exitCode: 0, signal: "SIGTERM" },
      ]),
      { stdoutMaxBytes: 10 },
    );
    expect(Buffer.from(result.stdout).toString()).toBe("abcd");
    expect(result.signal).toBe("SIGTERM");
  });
});
