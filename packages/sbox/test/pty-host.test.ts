import { describe, expect, it } from "vitest";
import { FakeHost } from "../src/fake-host.js";
import { defaultNetworkConfig, toSafeNetworkConfig } from "../src/network/types.js";
import {
  assertSandboxIdentity,
  bytesToUtf8,
  utf8ToBytes,
  type SandboxIdentity,
} from "../src/index.js";

function identity(): SandboxIdentity {
  return assertSandboxIdentity({
    project: "demo",
    profile: "default",
    instance: "pty",
  });
}

function seedRunning(host: FakeHost): SandboxIdentity {
  const id = identity();
  host.seed({
    identity: id,
    state: "running",
    creation: {
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
      network: toSafeNetworkConfig(defaultNetworkConfig()),
      secrets: [],
    },
  });
  return id;
}

async function collectOutput(output: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of output) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("FakeHost PTY contract", () => {
  it("merges arbitrary write streams into output", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const session = await host.pty({ identity: id, argv: ["/bin/sh"] }, { rows: 24, cols: 80 });
    try {
      const reader = collectOutput(session.output);
      await session.write("hello");
      await session.write(utf8ToBytes(" world"));
      const waitPromise = session.wait();
      const merged = await reader;
      expect(bytesToUtf8(merged)).toContain("hello");
      expect(bytesToUtf8(merged)).toContain(" world");
      await expect(waitPromise).resolves.toEqual({ exitCode: 0, signal: null });
      expect(host.operations).toContain("pty");
    } finally {
      await session[Symbol.asyncDispose]();
    }
  });

  it("emits resize escape sequences and accepts cancellation", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const session = await host.pty({ identity: id, argv: ["sh"] });
    const chunks: string[] = [];
    const pump = (async () => {
      for await (const chunk of session.output) {
        chunks.push(bytesToUtf8(chunk));
      }
    })();
    try {
      await session.resize({ rows: 40, cols: 120 });
      await expect.poll(() => chunks.some((chunk) => chunk.includes("\x1b[8;40;120t"))).toBe(true);
      await session.cancel("test");
      await expect(pump).rejects.toMatchObject({ code: "cancellation" });
      await expect(session.wait()).rejects.toMatchObject({ code: "cancellation" });
    } finally {
      await session[Symbol.asyncDispose]();
    }
  });

  it("reports exit status after wait and cleans up on dispose", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const session = await host.pty({ identity: id, argv: ["sh"] });
    const exit = await session.wait();
    expect(exit).toEqual({ exitCode: 0, signal: null });
    await session[Symbol.asyncDispose]();
    await session[Symbol.asyncDispose]();
    await expect(session.write("late")).rejects.toMatchObject({ code: "native_state" });
  });

  it("forwards optional input iterable into merged output", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const session = await host.pty(
      { identity: id, argv: ["sh"] },
      {
        input: (async function* () {
          yield utf8ToBytes("from-input");
        })(),
      },
    );
    try {
      const waitPromise = session.wait();
      const text = bytesToUtf8(await collectOutput(session.output));
      expect(text).toContain("from-input");
      await waitPromise;
    } finally {
      await session[Symbol.asyncDispose]();
    }
  });

  it("rejects empty PTY argv", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    await expect(host.pty({ identity: id, argv: [] })).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("times out distinctly from cancel", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const session = await host.pty({ identity: id, argv: ["sh"] }, { timeoutMs: 40 });
    try {
      await expect(session.wait()).rejects.toMatchObject({ code: "timeout" });
    } finally {
      await session[Symbol.asyncDispose]();
    }
  });
});
