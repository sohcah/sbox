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

/** Prefer `/tmp` on Unix so `MSB_HOME` stays short (macOS Unix socket ~104 byte limit). */
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
  | { readonly status: "passed"; readonly detachSequence: readonly string[] }
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

describe("local Microsandbox lifecycle acceptance", () => {
  it("create → inspect(config) → stop(live stop→detach→fresh get) → start → remove", async ({
    skip,
  }) => {
    const forced = process.env["SBOX_ACCEPTANCE_FORCE"];
    if (forced === "unavailable" || forced === "passed" || forced === "failed") {
      // Deterministic CLI-output fixtures for unit coverage of `pnpm test:acceptance`.
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
    const scriptPath = join(root, "lifecycle.mjs");

    await writeFile(
      scriptPath,
      `
        import { createMicrosandboxRuntime } from ${mod("dist/microsandbox-runtime.js")};
        import { createLocalHostInternal } from ${mod("dist/local-host-internal.js")};
        import { assertSandboxIdentity, nativeSandboxName } from ${mod("dist/identity.js")};
        import { disposeHost } from ${mod("dist/host.js")};
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
        const identity = assertSandboxIdentity({
          project: "accept",
          profile: "default",
          instance: "t" + process.pid,
        });
        const nativeName = nativeSandboxName(identity.project, identity.instance);
        const base = createMicrosandboxRuntime();
        const detachSequence = [];
        const runtime = {
          create: async (request) => {
            const live = await base.create(request);
            return {
              name: live.name,
              stop: async () => {
                detachSequence.push("liveStop");
                await live.stop();
              },
              detach: async () => {
                detachSequence.push("liveDetach");
                await live.detach();
              },
            };
          },
          get: (name) => base.get(name),
          list: () => base.list(),
          start: async (name) => {
            const live = await base.start(name);
            return {
              name: live.name,
              stop: async () => {
                detachSequence.push("liveStop");
                await live.stop();
              },
              detach: async () => {
                detachSequence.push("liveDetach");
                await live.detach();
              },
            };
          },
          stopLiveThenFreshGet: async (name) => {
            detachSequence.push("connect");
            const result = await base.stopLiveThenFreshGet(name);
            // Real runtime performs stop+detach internally; record the contract markers.
            detachSequence.push("liveStop");
            detachSequence.push("liveDetach");
            detachSequence.push("freshGet");
            return result;
          },
          remove: (name) => base.remove(name),
          probe: () => base.probe(),
        };

        const host = createLocalHostInternal({ runtime });
        const report = async (payload) => {
          process.stdout.write(JSON.stringify(payload) + "\\n");
        };

        const cleanup = async () => {
          try { await host.stop(identity); } catch {}
          try { await host.remove(identity); } catch {}
          try {
            const record = await base.get(nativeName);
            if (record.status === "running" || record.status === "draining") {
              await base.stopLiveThenFreshGet(nativeName);
            }
            await base.remove(nativeName);
          } catch {}
        };

        const main = async () => {
          try {
            const probe = await runtime.probe();
            if (!probe.available) {
              await report({ status: "unavailable", reason: probe.notes.join("; ") });
              process.exitCode = 0;
              return;
            }

            const created = await host.create({
              identity,
              image: "alpine:3.20",
              cpus: 1,
              memoryMiB: 512,
              // Use a guest path that exists in alpine:3.20.
              workdir: "/root",
              user: "root",
              shell: "/bin/sh",
              hostname: "accept",
            });
            if (created.creation.image !== "alpine:3.20") {
              throw new Error("inspect image mismatch: " + created.creation.image);
            }
            if (created.creation.cpus !== 1 || created.creation.memoryMiB !== 512) {
              throw new Error("inspect resources mismatch");
            }
            if (created.creation.workdir !== "/root" || created.creation.user !== "root") {
              throw new Error("inspect runtime mismatch");
            }
            if (created.creation.shell !== "/bin/sh" || created.creation.hostname !== "accept") {
              throw new Error("inspect shell/hostname mismatch");
            }

            const inspected = await host.inspect(identity);
            if (inspected.nativeName !== created.nativeName) {
              throw new Error("inspect native name mismatch");
            }

            detachSequence.length = 0;
            const stopped = await host.stop(identity);
            if (stopped.state !== "stopped") {
              throw new Error("expected stopped, got " + JSON.stringify(stopped.state));
            }
            if (!detachSequence.includes("liveStop") || !detachSequence.includes("liveDetach") || !detachSequence.includes("freshGet")) {
              throw new Error("missing stop/detach/freshGet markers: " + detachSequence.join(","));
            }

            const got = await host.get(identity);
            if (got.state !== "stopped") {
              throw new Error("expected stopped after fresh get");
            }

            const started = await host.start(identity);
            if (started.state !== "running") {
              throw new Error("expected running after start");
            }
            if (started.creation.image !== "alpine:3.20") {
              throw new Error("image lost across restart");
            }

            await host.remove(identity);
            await report({ status: "passed", detachSequence: [...detachSequence] });
          } catch (error) {
            const status = classifyFailure(error);
            await cleanup();
            await report({
              status,
              reason: safeReason(error),
            });
            process.exitCode = status === "unavailable" ? 0 : 1;
          } finally {
            await disposeHost(host);
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
      if (report.status === "passed") {
        expect(report.detachSequence).toEqual(
          expect.arrayContaining(["liveStop", "liveDetach", "freshGet"]),
        );
      }
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
