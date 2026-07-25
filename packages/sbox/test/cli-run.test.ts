import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXIT_CANCELLED,
  EXIT_OPERATIONAL,
  EXIT_SUCCESS,
  EXIT_VALIDATION,
  SboxError,
} from "../src/index.js";
import { runCli } from "../src/cli/runner.js";
import { FakeHost } from "../src/fake-host.js";
import { assertSandboxIdentity } from "../src/identity.js";
import { utf8ToBytes } from "../src/process/decode.js";

function collectingIo(cwd: string) {
  let stdout = "";
  let stderr = "";
  return {
    stdoutText: () => stdout,
    stderrText: () => stderr,
    io: {
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        },
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        },
      },
      cwd,
      env: {} as Record<string, string | undefined>,
      homeDir: cwd,
      platform: "linux" as const,
    },
  };
}

async function writeProject(dir: string): Promise<void> {
  await writeFile(
    join(dir, "sbox.yaml"),
    `
version: 1
project: demo
defaultProfile: default
profiles:
  default:
    image: alpine:3.20
    cpus: 1
    memory: 512MiB
    shell: /bin/sh
`,
    "utf8",
  );
}

/** Parse one or more pretty-printed JSON objects from CLI stdout. */
function parseJsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return out;
}

describe("CLI run with FakeHost", () => {
  it("creates a unique sandbox, propagates guest exit, and removes in finally", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-run-"));
    await writeProject(root);
    const host = new FakeHost();
    host.execHandler = async () => ({
      exitCode: 7,
      stdout: utf8ToBytes("ran"),
      stderr: new Uint8Array(),
    });
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["run", "default", "--", "false"],
      io: collected.io,
      host,
    });
    expect(code).toBe(7);
    expect(collected.stdoutText()).toContain("ran");
    expect(await host.list()).toHaveLength(0);
    expect(host.operations).toContain("create");
    expect(host.operations).toContain("remove");
  });

  it("rejects --instance because run always generates a unique identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-run-"));
    await writeProject(root);
    const host = new FakeHost();
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["run", "--instance", "fixed", "--", "true"],
      io: collected.io,
      host,
    });
    expect(code).toBe(EXIT_VALIDATION);
    expect(collected.stdoutText() + collected.stderrText()).toMatch(/unique instance/);
  });

  it("maps abort/cancellation to exit 130 and still removes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-run-"));
    await writeProject(root);
    const host = new FakeHost();
    host.execArgv = async () => {
      throw SboxError.cancellation("cancelled by test");
    };
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["run", "--json", "--", "true"],
      io: collected.io,
      host,
    });
    expect(code).toBe(EXIT_CANCELLED);
    expect(JSON.parse(collected.stdoutText()).error.code).toBe("cancellation");
    expect(await host.list()).toHaveLength(0);
  });

  it("reports standalone operation failure without cleanupFailed", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-run-"));
    await writeProject(root);
    const host = new FakeHost();
    host.execHandler = async () => {
      throw SboxError.internal("exec boom");
    };
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["run", "--json", "--", "true"],
      io: collected.io,
      host,
    });
    expect(code).toBe(EXIT_OPERATIONAL);
    const payload = JSON.parse(collected.stdoutText()) as {
      error: { code: string; details: Record<string, unknown> };
    };
    expect(payload.error.code).toBe("internal");
    expect(payload.error.details["cleanupFailed"]).toBeUndefined();
    expect(await host.list()).toHaveLength(0);
  });

  it("reports standalone cleanup failure after guest success", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-run-"));
    await writeProject(root);
    const host = new FakeHost();
    const originalRemove = host.remove.bind(host);
    host.remove = async (identity, options) => {
      await originalRemove(identity, options);
      throw SboxError.internal("cleanup boom");
    };
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["run", "--json", "--", "echo", "ok"],
      io: collected.io,
      host,
    });
    expect(code).toBe(EXIT_OPERATIONAL);
    const payloads = parseJsonObjects(collected.stdoutText());
    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as {
      ok: boolean;
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toMatch(/cleanup boom/);
    expect(payload.error.details["cleanupFailed"]).toBe(true);
    expect(payload.error.details["cleanupCode"]).toBe("internal");
  });

  it("preserves primary failure when cleanup also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-run-"));
    await writeProject(root);
    const host = new FakeHost();
    host.execHandler = async () => {
      throw SboxError.internal("exec boom");
    };
    const originalRemove = host.remove.bind(host);
    host.remove = async (identity, options) => {
      await originalRemove(identity, options);
      throw SboxError.busy("cleanup boom");
    };
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["run", "--json", "--", "true"],
      io: collected.io,
      host,
    });
    expect(code).toBe(EXIT_OPERATIONAL);
    const payloads = parseJsonObjects(collected.stdoutText());
    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(payload.error.message).toMatch(/exec boom/);
    expect(payload.error.details["cleanupFailed"]).toBe(true);
    expect(payload.error.details["cleanupCode"]).toBe("busy");
    expect(payload.error.details["cleanupMessage"]).toMatch(/cleanup boom/);
    expect(payload.error.details["guestExitCode"]).toBeUndefined();
  });

  it("preserves streamed operational failure as primary when cleanup also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-run-"));
    await writeProject(root);
    const host = new FakeHost();
    host.execArgvStream = async () => {
      throw SboxError.internal("stream boom");
    };
    const originalRemove = host.remove.bind(host);
    host.remove = async (identity, options) => {
      await originalRemove(identity, options);
      throw SboxError.internal("cleanup boom");
    };
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["run", "--json", "--stream", "--", "true"],
      io: collected.io,
      host,
    });
    expect(code).toBe(EXIT_OPERATIONAL);
    const payloads = parseJsonObjects(collected.stdoutText());
    const last = payloads.at(-1) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(last.error.message).toMatch(/stream boom/);
    expect(last.error.details["cleanupFailed"]).toBe(true);
    expect(last.error.details["cleanupCode"]).toBe("internal");
    expect(last.error.details["guestExitCode"]).toBeUndefined();
  });

  it("returns success and leaves no sandbox after a zero exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-run-"));
    await writeProject(root);
    const host = new FakeHost();
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["run", "--json", "--", "echo", "ok"],
      io: collected.io,
      host,
    });
    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(collected.stdoutText()).data.exitCode).toBe(0);
    expect(await host.list()).toHaveLength(0);
  });

  it("does not leave sandboxes when create succeeds and command fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-run-"));
    await writeProject(root);
    const host = new FakeHost();
    host.execHandler = async () => ({
      exitCode: 3,
      stdout: new Uint8Array(),
      stderr: utf8ToBytes("nope"),
    });
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["run", "--", "false"],
      io: collected.io,
      host,
    });
    expect(code).toBe(3);
    expect(await host.list()).toEqual([]);
    await expect(
      host.get(assertSandboxIdentity({ project: "demo", profile: "default", instance: "default" })),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
