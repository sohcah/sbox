import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageModuleUrl } from "./helpers/acceptance-module.js";
import { formatAcceptanceStatusLine } from "./helpers/acceptance-status.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (...segments: string[]) => JSON.stringify(packageModuleUrl(packageRoot, ...segments));

function disposableTempPrefix(): string {
  return process.platform === "win32" ? join(tmpdir(), "sbox-") : "/tmp/sbox-";
}

const CHILD_TIMEOUT_MS = 180_000;

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type AcceptanceReport =
  | { readonly status: "passed"; readonly nativeName: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

async function run(
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
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

  const timeoutMs = options?.timeoutMs;
  let timedOut = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
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

describe("local image-reference up acceptance", () => {
  it("first up creates; repeated up is idempotent; stop+up restarts; remove cleans up", async ({
    skip,
  }) => {
    const forced = process.env["SBOX_ACCEPTANCE_FORCE"];
    if (forced === "unavailable" || forced === "passed" || forced === "failed") {
      console.log(
        formatAcceptanceStatusLine(forced, forced === "unavailable" ? "forced" : undefined),
      );
      if (forced === "unavailable") {
        skip(true, "Microsandbox acceptance unavailable: forced");
      }
      if (forced === "failed") {
        throw new Error("forced acceptance failure");
      }
      return;
    }

    const root = await mkdtemp(disposableTempPrefix());
    const home = join(root, "h");
    await mkdir(home);
    const scriptPath = join(root, "up-lifecycle.mjs");

    await writeFile(
      scriptPath,
      `
        import { createMicrosandboxRuntime } from ${mod("dist/microsandbox-runtime.js")};
        import { createLocalHostInternal } from ${mod("dist/local-host-internal.js")};
        import { createSboxClient } from ${mod("dist/client/client.js")};
        import { parseProjectConfig } from ${mod("dist/config/validate.js")};
        import { isSboxError } from ${mod("dist/errors.js")};

        process.env.MSB_HOME = ${JSON.stringify(home)};
        const UNAVAILABLE_REASONS = new Set([
          "registry_unavailable",
          "image_unavailable",
          "missing_runtime",
          "unsupported_hypervisor",
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
          project: "accept",
          defaultProfile: "default",
          profiles: {
            default: {
              image: "alpine:3.20",
              cpus: 1,
              memoryMiB: 512,
              workdir: "/root",
              user: "root",
              shell: "/bin/sh",
              hostname: "accept-up",
            },
          },
        });

        const runtime = createMicrosandboxRuntime();
        const host = createLocalHostInternal({ runtime });
        const client = createSboxClient({ project, host, ownsHost: false });
        const report = async (payload) => {
          process.stdout.write(JSON.stringify(payload) + "\\n");
        };

        const cleanup = async (identity) => {
          try { await client.stop(identity); } catch {}
          try { await client.remove(identity); } catch {}
        };

        const main = async () => {
          let identity;
          try {
            const probe = await runtime.probe();
            if (!probe.available) {
              await report({ status: "unavailable", reason: probe.notes.join("; ") });
              process.exitCode = 0;
              return;
            }

            const first = await client.up({ profile: "default" });
            identity = first.identity;
            const firstInspect = await first.inspect();
            if (firstInspect.state !== "running") {
              throw new Error("expected running after first up");
            }

            const second = await client.up({ profile: "default" });
            const secondInspect = await second.inspect();
            if (secondInspect.nativeName !== firstInspect.nativeName) {
              throw new Error("repeated up changed identity");
            }
            if (secondInspect.state !== "running") {
              throw new Error("expected running after repeated up");
            }

            await client.stop(identity);
            const stopped = await client.inspect(identity);
            if (stopped.state !== "stopped") {
              throw new Error("expected stopped");
            }

            const restarted = await client.up({ profile: "default" });
            const restartedInspect = await restarted.inspect();
            if (restartedInspect.state !== "running") {
              throw new Error("expected running after restart up");
            }
            if (restartedInspect.nativeName !== firstInspect.nativeName) {
              throw new Error("restart up changed identity");
            }

            await client.remove(identity);
            await report({ status: "passed", nativeName: firstInspect.nativeName });
          } catch (error) {
            const status = classifyFailure(error);
            if (identity !== undefined) {
              await cleanup(identity);
            }
            await report({ status, reason: safeReason(error) });
            process.exitCode = status === "unavailable" ? 0 : 1;
          } finally {
            await client[Symbol.asyncDispose]();
            await host[Symbol.asyncDispose]();
          }
        };

        await main();
      `,
    );

    try {
      const result = await run(process.execPath, [scriptPath], {
        cwd: packageRoot,
        env: { ...process.env, MSB_HOME: home },
        timeoutMs: CHILD_TIMEOUT_MS,
      });
      if (result.timedOut) {
        throw new Error(
          `acceptance child timed out after ${CHILD_TIMEOUT_MS}ms\n${result.stderr}\n${result.stdout}`,
        );
      }
      const report = parseReport(result.stdout);
      if (report.status === "unavailable") {
        console.log(formatAcceptanceStatusLine("unavailable", report.reason));
        skip(true, `Microsandbox acceptance unavailable: ${report.reason}`);
      }
      if (report.status === "failed") {
        console.log(formatAcceptanceStatusLine("failed", report.reason));
        throw new Error(`acceptance failed: ${report.reason}`);
      }
      console.log(formatAcceptanceStatusLine("passed"));
      expect(report.status).toBe("passed");
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
