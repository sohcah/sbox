import { describe, expect, it } from "vitest";
import { FakeHost } from "../src/fake-host.js";
import { defaultNetworkConfig, toSafeNetworkConfig } from "../src/network/types.js";
import {
  SECRET_LOG_CANARY_KEYS,
  assertSandboxIdentity,
  bytesToUtf8,
  collectingLogger,
  utf8ToBytes,
  type ProcessEvent,
  type SandboxIdentity,
} from "../src/index.js";

function identity(project = "demo", profile = "default", instance = "main"): SandboxIdentity {
  return assertSandboxIdentity({ project, profile, instance });
}

function seedRunning(host: FakeHost, id = identity()): SandboxIdentity {
  host.seed({
    identity: id,
    state: "running",
    creation: {
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
      network: toSafeNetworkConfig(defaultNetworkConfig()),
      secrets: [],
      volumes: [],
    },
  });
  return id;
}

async function collectEvents(session: AsyncIterable<ProcessEvent>): Promise<ProcessEvent[]> {
  const out: ProcessEvent[] = [];
  for await (const event of session) {
    out.push(event);
  }
  return out;
}

describe("FakeHost process contract", () => {
  it("passes exact argv without shell interpretation", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const result = await host.execArgv({
      identity: id,
      argv: ["echo", "hello world", "--flag=1"],
    });
    expect(result.exitCode).toBe(0);
    expect(bytesToUtf8(result.stdout)).toBe(
      `${JSON.stringify("echo")} ${JSON.stringify("hello world")} ${JSON.stringify("--flag=1")}`,
    );
    expect(host.operations).toContain("execArgv");
  });

  it("routes shell scripts through [shell, -c, script]", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const result = await host.execShell({
      identity: id,
      script: "echo hi && true",
      shell: "/bin/sh",
    });
    expect(result.exitCode).toBe(0);
    expect(bytesToUtf8(result.stdout)).toBe("shell:echo hi && true");
    expect(host.operations).toContain("execShell");
  });

  it.each([
    ["spaces", ["cmd", "a b", "c"]],
    ["quotes", ["cmd", `say "hi"`, "it's"]],
    ["empty", ["cmd", "", "tail"]],
    ["unicode", ["cmd", "日本語", "café", "😀"]],
  ])("preserves argv with %s", async (_label, argv) => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const result = await host.execArgv({ identity: id, argv });
    expect(bytesToUtf8(result.stdout)).toBe(argv.map((part) => JSON.stringify(part)).join(" "));
  });

  it("accepts string and byte stdin for collected exec", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const stringResult = await host.execArgv(
      { identity: id, argv: ["cat"] },
      { stdin: "string-stdin" },
    );
    expect(bytesToUtf8(stringResult.stdout)).toBe("string-stdin");

    const bytes = utf8ToBytes("byte-stdin\0binary");
    const byteResult = await host.execArgv({ identity: id, argv: ["cat"] }, { stdin: bytes });
    expect(Buffer.from(byteResult.stdout)).toEqual(Buffer.from(bytes));
  });

  it("returns non-zero guest exit as a ProcessResult", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const result = await host.execArgv({ identity: id, argv: ["false"] });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it("keeps stdout and stderr separate", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    host.execHandler = async () => ({
      exitCode: 0,
      stdout: utf8ToBytes("OUT"),
      stderr: utf8ToBytes("ERR"),
    });
    const result = await host.execArgv({ identity: id, argv: ["any"] });
    expect(bytesToUtf8(result.stdout)).toBe("OUT");
    expect(bytesToUtf8(result.stderr)).toBe("ERR");
  });

  it("throws validation when timeoutMs is not a positive safe integer", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    await expect(
      host.execArgv({ identity: id, argv: ["true"] }, { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      host.execArgv({ identity: id, argv: ["true"] }, { timeoutMs: Number.NaN }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("aborts streaming exec via AbortSignal", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const controller = new AbortController();
    controller.abort();
    await expect(
      host.execArgvStream({ identity: id, argv: ["true"] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("streams events in started → stdout → stderr → exited order", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    host.execHandler = async () => ({
      exitCode: 3,
      stdout: utf8ToBytes("out"),
      stderr: utf8ToBytes("err"),
    });
    const session = await host.execArgvStream({ identity: id, argv: ["x"] });
    try {
      const events = await collectEvents(session);
      expect(events.map((event) => event.type)).toEqual(["started", "stdout", "stderr", "exited"]);
      expect(events.at(-1)).toMatchObject({ type: "exited", exitCode: 3, signal: null });
      await expect(session.wait()).resolves.toEqual({ exitCode: 3, signal: null });
    } finally {
      await session[Symbol.asyncDispose]();
    }
  });

  it("feeds streaming stdin and respects EOF before running the command", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    let seenStdin: Uint8Array | undefined;
    host.execHandler = async (_argv, stdin) => {
      seenStdin = stdin;
      return { exitCode: 0, stdout: stdin, stderr: new Uint8Array() };
    };
    const session = await host.execArgvStream(
      { identity: id, argv: ["cat"] },
      {
        stdin: (async function* () {
          yield utf8ToBytes("chunk-a");
          yield utf8ToBytes("-b");
        })(),
      },
    );
    try {
      const events = await collectEvents(session);
      const stdout = events.find((event) => event.type === "stdout");
      expect(stdout?.type).toBe("stdout");
      if (stdout?.type === "stdout") {
        expect(bytesToUtf8(stdout.data)).toBe("chunk-a-b");
      }
      expect(seenStdin && bytesToUtf8(seenStdin)).toBe("chunk-a-b");
    } finally {
      await session[Symbol.asyncDispose]();
    }
  });

  it("never logs argv, stdin, stdout, or env secret canaries", async () => {
    const { logger, events } = collectingLogger();
    const host = new FakeHost({ logger });
    const id = seedRunning(host);
    const secretArg = "super-secret-argv-value";
    const secretStdin = "super-secret-stdin-value";
    const secretStdout = "super-secret-stdout-value";
    const secretEnv = "super-secret-env-value";

    host.execHandler = async () => ({
      exitCode: 0,
      stdout: utf8ToBytes(secretStdout),
      stderr: new Uint8Array(),
    });

    await host.execArgv(
      { identity: id, argv: ["echo", secretArg] },
      {
        stdin: secretStdin,
        env: { TOKEN: secretEnv, SAFE: "ok" },
      },
    );

    // Also exercise canary keys in a failure path details bag via a thrown validation.
    await expect(host.execArgv({ identity: id, argv: [] })).rejects.toMatchObject({
      code: "validation",
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secretArg);
    expect(serialized).not.toContain(secretStdin);
    expect(serialized).not.toContain(secretStdout);
    expect(serialized).not.toContain(secretEnv);

    for (const key of SECRET_LOG_CANARY_KEYS) {
      // Canary keys themselves may appear as redacted detail keys; values must not.
      expect(serialized).not.toContain(`value-for-${key}`);
    }
  });
});
