import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_SUCCESS, EXIT_VALIDATION } from "../src/cli/exit-codes.js";
import { runCli } from "../src/cli/runner.js";
import { FakeHost } from "../src/fake-host.js";
import { clearEnsureImageCoalescing } from "../src/image/ensure.js";

afterEach(() => {
  clearEnsureImageCoalescing();
});

function collectingIo(cwd: string) {
  let stdout = "";
  let stderr = "";
  return {
    stdoutText: () => stdout,
    stderrText: () => stderr,
    io: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
        },
      },
      cwd,
      env: process.env,
      homeDir: cwd,
      platform: "linux" as const,
    },
  };
}

describe("image CLI", () => {
  it("builds, lists, and removes exact generated images", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-img-"));
    await writeFile(
      join(root, "sbox.yaml"),
      `version: 1
project: climg
defaultProfile: built
profiles:
  built:
    build:
      context: .
    memory: 512MiB
`,
    );
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const host = new FakeHost();

    const build = collectingIo(root);
    const buildCode = await runCli({
      argv: ["build", "built", "--json"],
      io: build.io,
      host,
    });
    expect(buildCode).toBe(EXIT_SUCCESS);
    const built = JSON.parse(build.stdoutText());
    expect(built.ok).toBe(true);
    expect(built.data.reference).toMatch(/^sbox-img:sha256-/);
    expect(build.stdoutText()).not.toContain("FROM alpine");

    const list = collectingIo(root);
    const listCode = await runCli({ argv: ["image", "list", "--json"], io: list.io, host });
    expect(listCode).toBe(EXIT_SUCCESS);
    const listed = JSON.parse(list.stdoutText());
    expect(
      listed.data.images.some(
        (image: { reference: string }) => image.reference === built.data.reference,
      ),
    ).toBe(true);

    const remove = collectingIo(root);
    const removeCode = await runCli({
      argv: ["image", "remove", built.data.reference, "--json"],
      io: remove.io,
      host,
    });
    expect(removeCode).toBe(EXIT_SUCCESS);

    const missing = await runCli({
      argv: ["image", "remove"],
      io: collectingIo(root).io,
      host,
    });
    expect(missing).toBe(EXIT_VALIDATION);
  });

  it("streams build phases to stderr before the build completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-progress-"));
    await writeFile(
      join(root, "sbox.yaml"),
      `version: 1
project: cliprog
defaultProfile: built
profiles:
  built:
    build:
      context: .
    memory: 512MiB
`,
    );
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const host = new FakeHost();
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    host.ensureImage = async (_request, options) => {
      options?.onProgress?.({ type: "phase", phase: "identity" });
      await gate;
      options?.onProgress?.({ type: "phase", phase: "reuse" });
      return {
        reference: "sbox-img:sha256-" + "a".repeat(64),
        contentIdentity: ("sha256:" + "a".repeat(64)) as `sha256:${string}`,
        algorithmVersion: 1,
        owned: true,
        labels: {},
        reused: true,
        built: false,
      };
    };

    const build = collectingIo(root);
    const pending = runCli({
      argv: ["build", "built", "--json"],
      io: build.io,
      host,
    });
    let sawLiveProgress = false;
    for (let i = 0; i < 50; i += 1) {
      if (build.stderrText().includes('"phase":"identity"')) {
        sawLiveProgress = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sawLiveProgress).toBe(true);
    resolveGate?.();
    const code = await pending;
    expect(code).toBe(EXIT_SUCCESS);
    const final = JSON.parse(build.stdoutText());
    expect(final.ok).toBe(true);
    expect(final.data.phases).toEqual(["identity", "reuse"]);
  });
});
