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
  | { readonly status: "passed" }
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

describe("local Microsandbox process/transfer acceptance", () => {
  it("exact argv, shell, collect/stream, stdin, exit, PTY resize, transfer", async ({ skip }) => {
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
    const scriptPath = join(root, "process.mjs");

    await writeFile(
      scriptPath,
      `
        import { mkdir, mkdtemp, readFile, writeFile, chmod, lstat } from "node:fs/promises";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        import { createMicrosandboxRuntime } from ${mod("dist/microsandbox-runtime.js")};
        import { createLocalHostInternal } from ${mod("dist/local-host-internal.js")};
        import { assertSandboxIdentity, nativeSandboxName } from ${mod("dist/identity.js")};
        import { disposeHost } from ${mod("dist/host.js")};
        import { isSboxError } from ${mod("dist/errors.js")};
        import { bytesToUtf8 } from ${mod("dist/process/decode.js")};

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
          instance: "p" + process.pid,
        });
        const nativeName = nativeSandboxName(identity.project, identity.instance);
        const runtime = createMicrosandboxRuntime();
        const host = createLocalHostInternal({ runtime });
        const report = async (payload) => {
          process.stdout.write(JSON.stringify(payload) + "\\n");
        };

        const cleanup = async () => {
          try { await host.stop(identity); } catch {}
          try { await host.remove(identity); } catch {}
          try {
            const record = await runtime.get(nativeName);
            if (record.status === "running" || record.status === "draining") {
              await runtime.stopLiveThenFreshGet(nativeName);
            }
            await runtime.remove(nativeName);
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

            await host.create({
              identity,
              image: "alpine:3.20",
              cpus: 1,
              memoryMiB: 512,
              workdir: "/root",
              user: "root",
              shell: "/bin/sh",
              hostname: "accept-proc",
            });

            // Exact argv — no shell splitting.
            const exact = await host.execArgv({
              identity,
              argv: ["printf", "%s", "hello world"],
            });
            if (exact.exitCode !== 0) {
              throw new Error("exact argv exit " + exact.exitCode);
            }
            if (bytesToUtf8(exact.stdout) !== "hello world") {
              throw new Error("exact argv stdout mismatch: " + bytesToUtf8(exact.stdout));
            }

            // Explicit shell.
            const shelled = await host.execShell({
              identity,
              script: "printf '%s' shell-ok",
              shell: "/bin/sh",
            });
            if (shelled.exitCode !== 0 || bytesToUtf8(shelled.stdout) !== "shell-ok") {
              throw new Error("shell mismatch");
            }

            // Collected stdin.
            const withStdin = await host.execArgv(
              { identity, argv: ["cat"] },
              { stdin: "stdin-bytes" },
            );
            if (bytesToUtf8(withStdin.stdout) !== "stdin-bytes") {
              throw new Error("stdin mismatch");
            }

            // Non-zero exit as result.
            const failed = await host.execArgv({ identity, argv: ["false"] });
            if (failed.exitCode === 0) {
              throw new Error("expected non-zero exit");
            }

            // Streaming events.
            const session = await host.execArgvStream({
              identity,
              argv: ["printf", "%s", "stream"],
            });
            const types = [];
            let streamOut = "";
            try {
              for await (const event of session) {
                types.push(event.type);
                if (event.type === "stdout") {
                  streamOut += bytesToUtf8(event.data);
                }
              }
              const waited = await session.wait();
              if (waited.exitCode !== 0 || streamOut !== "stream") {
                throw new Error("stream mismatch");
              }
              if (!types.includes("started") || !types.includes("exited")) {
                throw new Error("missing stream events: " + types.join(","));
              }
            } finally {
              await session[Symbol.asyncDispose]();
            }

            // PTY resize.
            const pty = await host.pty(
              { identity, argv: ["/bin/sh"] },
              { rows: 24, cols: 80 },
            );
            try {
              await pty.write("echo pty-ready\\n");
              await pty.resize({ rows: 30, cols: 100 });
              await pty.cancel("acceptance-done");
            } finally {
              try { await pty[Symbol.asyncDispose](); } catch {}
            }

            // File + directory transfer both ways.
            const xferRoot = await mkdtemp(join(tmpdir(), "sbox-accept-xfer-"));
            const hostFile = join(xferRoot, "payload.bin");
            const payload = Buffer.from([0, 1, 2, 255, 10]);
            await writeFile(hostFile, payload);
            await host.copyHostToGuest({
              identity,
              hostPath: hostFile,
              guestPath: "/tmp/payload.bin",
            });
            const roundTripFile = join(xferRoot, "out.bin");
            await host.copyGuestToHost({
              identity,
              guestPath: "/tmp/payload.bin",
              hostPath: roundTripFile,
            });
            const got = await readFile(roundTripFile);
            if (!got.equals(payload)) {
              throw new Error("file transfer mismatch");
            }

            const hostDir = join(xferRoot, "dir");
            await mkdir(join(hostDir, "nested"), { recursive: true });
            const script = join(hostDir, "nested", "run.sh");
            await writeFile(script, "#!/bin/sh\\necho hi\\n");
            await chmod(script, 0o755);
            await host.copyHostToGuest({
              identity,
              hostPath: hostDir,
              guestPath: "/tmp/treedir",
            });
            const backDir = join(xferRoot, "back");
            await host.copyGuestToHost({
              identity,
              guestPath: "/tmp/treedir",
              hostPath: backDir,
            });
            const st = await lstat(join(backDir, "nested", "run.sh"));
            // Windows host filesystems do not preserve Unix executable bits.
            if (process.platform !== "win32" && (st.mode & 0o111) === 0) {
              throw new Error("executable bit lost");
            }

            await cleanup();
            await report({ status: "passed" });
          } catch (error) {
            const status = classifyFailure(error);
            await cleanup();
            await report({ status, reason: safeReason(error) });
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
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
