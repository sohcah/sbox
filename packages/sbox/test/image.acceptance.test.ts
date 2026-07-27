/**
 * Real Docker → Microsandbox image acceptance (opt-in via pnpm test:acceptance).
 *
 * Isolation:
 * - unique short disposable MSB_HOME
 * - unique marked SBOX_IMAGE_WORKSPACE_ROOT
 * - content-addressed generated image refs
 * - exact cleanup of owned image, workspace root, and MSB_HOME
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { packageModuleUrl } from "./helpers/acceptance-module.js";
import { formatAcceptanceStatusLine } from "./helpers/acceptance-status.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (...segments: string[]) => JSON.stringify(packageModuleUrl(packageRoot, ...segments));
const CHILD_TIMEOUT_MS = 300_000;

function disposableTempPrefix(): string {
  return process.platform === "win32" ? join(tmpdir(), "sbox-") : "/tmp/sbox-";
}

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type AcceptanceReport =
  | { readonly status: "passed"; readonly reference: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

async function run(
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<RunResult> {
  const child = spawn(command, [...args], {
    cwd: options?.cwd,
    env: options?.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let timedOut = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalationTimer = setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref();
    }, timeoutMs);
    timer.unref?.();
  }

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => {
      closed = true;
      resolve(exitCode);
    });
  });
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (escalationTimer !== undefined) {
    clearTimeout(escalationTimer);
  }
  return { code, stdout, stderr, timedOut };
}

function parseReport(stdout: string): AcceptanceReport {
  const line = stdout
    .trim()
    .split("\n")
    .filter((entry) => entry.startsWith("{"))
    .at(-1);
  if (line === undefined) {
    return { status: "failed", reason: `No JSON report in stdout:\n${stdout}` };
  }
  return JSON.parse(line) as AcceptanceReport;
}

describe("Dockerfile image build acceptance", () => {
  it("builds, loads, reuses offline, forces, ups, and removes exactly", async ({ skip }) => {
    const forced = process.env["SBOX_ACCEPTANCE_FORCE"];
    if (forced === "unavailable" || forced === "passed" || forced === "failed") {
      console.log(
        formatAcceptanceStatusLine(forced, forced === "unavailable" ? "forced" : undefined),
      );
      if (forced === "unavailable") {
        skip(true, "Image acceptance unavailable: forced");
      }
      if (forced === "failed") {
        throw new Error("forced acceptance failure");
      }
      return;
    }

    const root = await mkdtemp(disposableTempPrefix());
    const home = join(root, "h");
    const workspaceRoot = join(root, "ws");
    const projectDir = join(root, "project");
    await mkdir(home);
    await mkdir(workspaceRoot);
    await mkdir(projectDir);
    const token = Date.now().toString(36);

    await writeFile(
      join(projectDir, "Dockerfile"),
      `FROM alpine:3.20
RUN echo sbox-phase4-${token} > /sbox-marker
`,
    );

    const scriptPath = join(root, "image-lifecycle.mjs");
    await writeFile(
      scriptPath,
      `
        import { createMicrosandboxRuntime } from ${mod("dist/microsandbox-runtime.js")};
        import { createLocalHostInternal } from ${mod("dist/local-host-internal.js")};
        import { createSboxClient } from ${mod("dist/client/client.js")};
        import { parseProjectConfig } from ${mod("dist/config/validate.js")};
        import { isSboxError } from ${mod("dist/errors.js")};

        process.env.MSB_HOME = ${JSON.stringify(home)};
        process.env.SBOX_IMAGE_WORKSPACE_ROOT = ${JSON.stringify(workspaceRoot)};

        const UNAVAILABLE_REASONS = new Set([
          "registry_unavailable",
          "image_unavailable",
          "missing_runtime",
          "unsupported_hypervisor",
          "image_ownership_evidence_unavailable",
        ]);
        const classifyFailure = (error) => {
          if (isSboxError(error) && error.code === "capability") {
            const reason = error.details && error.details.unavailableReason;
            if (typeof reason === "string" && UNAVAILABLE_REASONS.has(reason)) {
              return "unavailable";
            }
          }
          return "failed";
        };
        const safeReason = (error) => {
          if (isSboxError(error)) {
            const unavailableReason =
              error.details && typeof error.details.unavailableReason === "string"
                ? error.details.unavailableReason
                : undefined;
            return unavailableReason !== undefined
              ? error.code + ":" + unavailableReason
              : error.code + ":" + error.message;
          }
          return error instanceof Error ? error.message : String(error);
        };

        const project = parseProjectConfig({
          version: 1,
          project: "img" + ${JSON.stringify(token.slice(-6))},
          defaultProfile: "built",
          profiles: {
            built: {
              build: { context: ${JSON.stringify(projectDir)} },
              cpus: 1,
              memoryMiB: 512,
            },
          },
        });

        const runtime = createMicrosandboxRuntime();
        const host = createLocalHostInternal({ runtime });
        const client = createSboxClient({
          project,
          host,
          ownsHost: false,
          configDirectory: ${JSON.stringify(projectDir)},
        });
        const report = async (payload) => {
          process.stdout.write(JSON.stringify(payload) + "\\n");
        };

        const main = async () => {
          try {
            const probe = await runtime.probe();
            if (!probe.available) {
              await report({ status: "unavailable", reason: probe.notes.join("; ") });
              process.exitCode = 0;
              return;
            }
            const first = await client.build({ profile: "built" });
            if (!first.built || first.reused) {
              await report({ status: "failed", reason: "first build should build" });
              process.exitCode = 1;
              return;
            }

            // Offline reuse: hide Docker so a mistaken rebuild cannot succeed.
            const blockedBin = ${JSON.stringify(join(root, "blocked-bin"))};
            const originalPath = process.env.PATH ?? "";
            await import("node:fs/promises").then(async (fs) => {
              await fs.mkdir(blockedBin, { recursive: true });
              await fs.writeFile(
                blockedBin + "/docker",
                "#!/bin/sh\\necho docker-blocked >&2\\nexit 127\\n",
                { mode: 0o755 },
              );
            });
            process.env.PATH = blockedBin + ":" + originalPath;

            const second = await client.build({ profile: "built" });
            if (!second.reused || second.reference !== first.reference) {
              await report({ status: "failed", reason: "offline reuse failed" });
              process.exitCode = 1;
              return;
            }

            // Force rebuild needs Docker again — restore PATH for force/up.
            process.env.PATH = originalPath;

            const forcedBuild = await client.build({ profile: "built", force: true });
            if (!forcedBuild.built || forcedBuild.reference !== first.reference) {
              await report({ status: "failed", reason: "force failed" });
              process.exitCode = 1;
              return;
            }
            const handle = await client.up({ profile: "built" });
            const inspection = await handle.inspect();
            if (inspection.creation.image !== first.reference) {
              await report({ status: "failed", reason: "up image mismatch" });
              process.exitCode = 1;
              return;
            }
            await handle.stop();
            // Stopped up must not require Docker (identity + start only).
            process.env.PATH = blockedBin + ":" + originalPath;
            const again = await client.up({ profile: "built" });
            if ((await again.inspect()).state !== "running") {
              await report({ status: "failed", reason: "stopped up without docker failed" });
              process.exitCode = 1;
              return;
            }
            process.env.PATH = originalPath;
            await again.stop();
            await again.remove();
            await client.removeImage(first.reference);
            await report({ status: "passed", reference: first.reference });
          } catch (error) {
            const classified = classifyFailure(error);
            await report({ status: classified, reason: safeReason(error) });
            process.exitCode = classified === "unavailable" ? 0 : 1;
          } finally {
            await client[Symbol.asyncDispose]();
            await host[Symbol.asyncDispose]();
          }
        };

        await main();
      `,
    );

    try {
      const docker = await run("docker", ["version"], { timeoutMs: 30_000 });
      if (docker.code !== 0 || docker.timedOut) {
        console.log(formatAcceptanceStatusLine("unavailable", "docker_unavailable"));
        skip(true, "Docker unavailable");
        return;
      }

      const result = await run(process.execPath, [scriptPath], {
        cwd: projectDir,
        env: {
          ...process.env,
          MSB_HOME: home,
          SBOX_IMAGE_WORKSPACE_ROOT: workspaceRoot,
        },
        timeoutMs: CHILD_TIMEOUT_MS,
      });

      if (result.timedOut) {
        console.log(formatAcceptanceStatusLine("failed", "timeout"));
        throw new Error("image acceptance timed out");
      }

      const report = parseReport(result.stdout + "\n" + result.stderr);
      console.log(
        formatAcceptanceStatusLine(
          report.status,
          report.status === "unavailable" ? report.reason : undefined,
        ),
      );
      if (report.status === "unavailable") {
        skip(true, `Image acceptance unavailable: ${report.reason}`);
        return;
      }
      if (report.status === "failed") {
        throw new Error(report.reason);
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
