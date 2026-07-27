import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CANCELLED, EXIT_SUCCESS, SboxError } from "../src/index.js";
import { runCli } from "../src/cli/runner.js";
import { FakeHost } from "../src/fake-host.js";
import { assertSandboxIdentity } from "../src/identity.js";
import { defaultNetworkConfig, toSafeNetworkConfig } from "../src/network/types.js";

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

async function seedDefault(host: FakeHost): Promise<void> {
  host.seed({
    identity: assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "default",
    }),
    state: "running",
    creation: {
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
      shell: "/bin/sh",
      network: toSafeNetworkConfig(defaultNetworkConfig()),
      secrets: [],
      volumes: [],
      mounts: [],
    },
  });
}

describe("CLI exec/shell with FakeHost", () => {
  it("propagates guest exit codes from exec", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-exec-"));
    await writeProject(root);
    const host = new FakeHost();
    await seedDefault(host);
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["exec", "default", "--", "false"],
      io: collected.io,
      host,
    });
    expect(code).toBe(1);
  });

  it("streams NDJSON events with --json --stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-stream-"));
    await writeProject(root);
    const host = new FakeHost();
    await seedDefault(host);
    host.execHandler = async () => ({
      exitCode: 0,
      stdout: new TextEncoder().encode("hello"),
      stderr: new TextEncoder().encode("warn"),
    });
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["exec", "default", "--json", "--stream", "--", "echo", "hello"],
      io: collected.io,
      host,
    });
    expect(code).toBe(EXIT_SUCCESS);
    const lines = collected
      .stdoutText()
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string });
    expect(lines.map((line) => line.type)).toEqual(["started", "stdout", "stderr", "exited"]);
  });

  it("maps cancellation to exit 130", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-cancel-"));
    await writeProject(root);
    const host = new FakeHost();
    await seedDefault(host);
    host.execArgv = async () => {
      throw SboxError.cancellation("cancelled by test");
    };
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["exec", "default", "--json", "--", "true"],
      io: collected.io,
      host,
    });
    expect(code).toBe(EXIT_CANCELLED);
  });

  it("keeps exact argv distinct from explicit shell interpretation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-argv-"));
    await writeProject(root);
    const host = new FakeHost();
    await seedDefault(host);

    const execIo = collectingIo(root);
    expect(
      await runCli({
        argv: ["exec", "default", "--", "echo", "a b", "c"],
        io: execIo.io,
        host,
      }),
    ).toBe(EXIT_SUCCESS);
    expect(execIo.stdoutText()).toBe(
      `${JSON.stringify("echo")} ${JSON.stringify("a b")} ${JSON.stringify("c")}`,
    );

    const shellIo = collectingIo(root);
    expect(
      await runCli({
        argv: ["exec", "default", "--shell", "--", "echo", "a b"],
        io: shellIo.io,
        host,
      }),
    ).toBe(EXIT_SUCCESS);
    // --shell joins after `--` into one guest-shell expression.
    expect(shellIo.stdoutText()).toBe("shell:echo a b");
  });

  it("opens the profile shell through an interactive PTY", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-shell-"));
    await writeProject(root);
    const host = new FakeHost();
    await seedDefault(host);
    const collected = collectingIo(root);
    let resizeListener: (() => void) | undefined;
    let rawMode = false;
    let stdinStopped = false;
    const code = await runCli({
      argv: ["shell", "default"],
      io: {
        ...collected.io,
        stdin: (async function* () {
          yield "interactive-input";
        })(),
        terminalSize: () => ({ rows: 30, cols: 100 }),
        onTerminalResize: (listener) => {
          resizeListener = listener;
          return () => {
            resizeListener = undefined;
          };
        },
        enterRawMode: () => {
          rawMode = true;
          return () => {
            rawMode = false;
          };
        },
        stopStdin: () => {
          stdinStopped = true;
        },
      },
      host,
    });
    expect(code).toBe(EXIT_SUCCESS);
    expect(collected.stdoutText()).toContain("interactive-input");
    expect(host.operations).toContain("pty");
    expect(resizeListener).toBeUndefined();
    expect(rawMode).toBe(false);
    expect(stdinStopped).toBe(true);
  });

  it("prefers native terminal attachment when the host supports it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-native-shell-"));
    await writeProject(root);
    let attachCalls = 0;
    const host = Object.assign(new FakeHost(), {
      attachTerminal: async () => {
        attachCalls += 1;
        return 7;
      },
    });
    await seedDefault(host);
    const collected = collectingIo(root);

    const code = await runCli({
      argv: ["shell", "default"],
      io: collected.io,
      host,
    });

    expect(code).toBe(7);
    expect(attachCalls).toBe(1);
    expect(host.operations).not.toContain("pty");
  });

  it("rejects scripts passed to interactive shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-shell-script-"));
    await writeProject(root);
    const host = new FakeHost();
    await seedDefault(host);
    const collected = collectingIo(root);
    const code = await runCli({
      argv: ["shell", "default", "--", "echo", "no"],
      io: collected.io,
      host,
    });
    expect(code).not.toBe(EXIT_SUCCESS);
    expect(collected.stdoutText()).toContain("shell is interactive");
  });

  it("emits base64 stdout/stderr for collected --json exec", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-json-"));
    await writeProject(root);
    const host = new FakeHost();
    await seedDefault(host);
    const collected = collectingIo(root);
    expect(
      await runCli({
        argv: ["exec", "default", "--json", "--", "echo", "hi"],
        io: collected.io,
        host,
      }),
    ).toBe(EXIT_SUCCESS);
    const payload = JSON.parse(collected.stdoutText()) as {
      ok: boolean;
      data: { stdout: string; stdoutEncoding: string; exitCode: number };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.exitCode).toBe(0);
    expect(payload.data.stdoutEncoding).toBe("base64");
    expect(Buffer.from(payload.data.stdout, "base64").toString("utf8")).toContain("echo");
  });
});
