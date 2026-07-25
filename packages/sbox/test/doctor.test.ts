import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_OPERATIONAL, EXIT_SUCCESS } from "../src/index.js";
import { evaluateNodeVersion, MIN_NODE_MAJOR, runDoctor } from "../src/cli/commands/doctor.js";
import { FakeHost } from "../src/fake-host.js";

function collectingIo(cwd: string, env: Record<string, string | undefined> = {}) {
  let stdout = "";
  return {
    stdoutText: () => stdout,
    io: {
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        },
      },
      stderr: { write() {} },
      cwd,
      env,
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

const silentTooling = {
  probeDocker: async () => ({ available: false, detail: "docker missing" }),
  probeQemu: async () => ({ available: false, detail: "qemu missing" }),
  probeFormatterImage: async () => ({
    available: false,
    detail: "formatter missing",
  }),
} as const;

describe("evaluateNodeVersion", () => {
  it("accepts supported majors and rejects older/unrecognized versions", () => {
    expect(evaluateNodeVersion("v24.0.0").ok).toBe(true);
    expect(evaluateNodeVersion("v25.1.2").ok).toBe(true);
    expect(evaluateNodeVersion(`v${MIN_NODE_MAJOR}.99.0`).detail).toContain("@sohcah/sbox");
    expect(evaluateNodeVersion("v23.9.0").ok).toBe(false);
    expect(evaluateNodeVersion("v23.9.0").detail).toContain(`require Node ${MIN_NODE_MAJOR}+`);
    expect(evaluateNodeVersion("not-a-version").ok).toBe(false);
  });
});

describe("runDoctor", () => {
  it("passes required checks and reports informational tooling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbox-doctor-"));
    await writeProject(dir);
    const { io, stdoutText } = collectingIo(dir);
    const code = await runDoctor(
      {
        io,
        format: "json",
        flags: { json: true },
        host: new FakeHost(),
      },
      {
        nodeVersion: "v24.1.0",
        ...silentTooling,
      },
    );
    expect(code).toBe(EXIT_SUCCESS);
    const payload = JSON.parse(stdoutText()) as {
      ok: boolean;
      data: {
        checks: Array<{ name: string; ok: boolean; required: boolean; detail?: string }>;
      };
    };
    expect(payload.ok).toBe(true);
    const byName = Object.fromEntries(payload.data.checks.map((c) => [c.name, c]));
    expect(byName["node"]?.required).toBe(true);
    expect(byName["node"]?.ok).toBe(true);
    expect(byName["node"]?.detail).toContain("v24.1.0");
    expect(byName["protocol"]?.detail).toContain("protocol 1");
    expect(byName["target-mode"]?.detail).toBe("local-host");
    expect(byName["docker"]?.required).toBe(false);
    expect(byName["docker"]?.ok).toBe(false);
    expect(byName["docker"]?.detail).toContain("docker missing");
    expect(byName["qemu-img"]?.required).toBe(false);
    expect(byName["formatter-image"]?.required).toBe(false);
    expect(byName["formatter-image"]?.ok).toBe(false);
    expect(JSON.stringify(payload)).not.toMatch(/token|password|secret-value/i);
  });

  it("fails when Node is below the supported major", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbox-doctor-old-node-"));
    await writeProject(dir);
    const { io, stdoutText } = collectingIo(dir);
    const code = await runDoctor(
      {
        io,
        format: "json",
        flags: { json: true },
        host: new FakeHost(),
      },
      {
        nodeVersion: "v22.11.0",
        ...silentTooling,
      },
    );
    expect(code).toBe(EXIT_OPERATIONAL);
    const payload = JSON.parse(stdoutText()) as {
      ok: boolean;
      data: {
        checks: Array<{ name: string; ok: boolean; required: boolean; detail?: string }>;
      };
    };
    expect(payload.ok).toBe(false);
    const node = payload.data.checks.find((c) => c.name === "node");
    expect(node?.ok).toBe(false);
    expect(node?.required).toBe(true);
    expect(node?.detail).toContain("v22.11.0");
    expect(node?.detail).toContain(`require Node ${MIN_NODE_MAJOR}+`);
  });

  it("fails required remote credential resolution without leaking env secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbox-doctor-bad-"));
    await writeProject(dir);
    const userDir = join(dir, ".config", "sbox");
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(userDir, "config.yaml"),
      `
version: 1
targets:
  lab:
    kind: remote
    url: http://127.0.0.1:9
    token:
      env: SBOX_DOCTOR_MISSING_TOKEN
`,
      "utf8",
    );
    const canary = "doctor-auth-canary-VALUE-never-emit";
    const { io, stdoutText } = collectingIo(dir, {
      SBOX_DOCTOR_MISSING_TOKEN: undefined,
      SBOX_LEAK_PROBE: canary,
    });
    const code = await runDoctor(
      {
        io,
        format: "json",
        flags: { json: true, target: "lab" },
      },
      {
        nodeVersion: "v24.0.0",
        ...silentTooling,
      },
    );
    expect(code).toBe(EXIT_OPERATIONAL);
    const text = stdoutText();
    expect(text).not.toContain(canary);
    const payload = JSON.parse(text) as { ok: boolean };
    expect(payload.ok).toBe(false);
  });
});
