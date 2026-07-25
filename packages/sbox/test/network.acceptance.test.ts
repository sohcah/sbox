import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatAcceptanceStatusLine } from "./helpers/acceptance-status.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

describe("local Microsandbox network acceptance", () => {
  it("default-deny blocks outbound, allow grants domain, publish is inspectable", async ({
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
    const scriptPath = join(root, "network.mjs");

    await writeFile(
      scriptPath,
      `
        import { createMicrosandboxRuntime } from ${JSON.stringify(join(packageRoot, "dist/microsandbox-runtime.js"))};
        import { createLocalHostInternal } from ${JSON.stringify(join(packageRoot, "dist/local-host-internal.js"))};
        import { assertSandboxIdentity, nativeSandboxName } from ${JSON.stringify(join(packageRoot, "dist/identity.js"))};
        import { disposeHost } from ${JSON.stringify(join(packageRoot, "dist/host.js"))};
        import { isSboxError } from ${JSON.stringify(join(packageRoot, "dist/errors.js"))};
        import { bytesToUtf8 } from ${JSON.stringify(join(packageRoot, "dist/process/decode.js"))};

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

        const report = async (payload) => {
          process.stdout.write(JSON.stringify(payload) + "\\n");
        };

        const makeIdentity = (instance) =>
          assertSandboxIdentity({
            project: "accept",
            profile: "default",
            instance,
          });

        const runtime = createMicrosandboxRuntime();
        const host = createLocalHostInternal({ runtime });

        const cleanup = async (identity) => {
          const nativeName = nativeSandboxName(identity.project, identity.instance);
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

        const wget = async (identity, url) => {
          const result = await host.execArgv({
            identity,
            argv: ["wget", "-T", "3", "-q", "-O", "-", url],
          });
          return {
            exitCode: result.exitCode,
            stdout: bytesToUtf8(result.stdout),
            stderr: bytesToUtf8(result.stderr),
          };
        };

        const main = async () => {
          const denyId = makeIdentity("n" + process.pid + "d");
          const allowId = makeIdentity("n" + process.pid + "a");
          const publishId = makeIdentity("n" + process.pid + "p");
          try {
            const probe = await runtime.probe();
            if (!probe.available) {
              await report({ status: "unavailable", reason: probe.notes.join("; ") });
              process.exitCode = 0;
              return;
            }

            const caps = await host.capabilities();
            if (caps.dynamicHostPorts) {
              await report({
                status: "failed",
                reason: "expected dynamicHostPorts=false on Microsandbox 0.6.6 (allocated ports not inspectable)",
              });
              process.exitCode = 1;
              return;
            }

            // 1) Unconfigured / default-deny: external HTTP must fail.
            await host.create({
              identity: denyId,
              image: "alpine:3.20",
              cpus: 1,
              memoryMiB: 512,
            });
            const denyInspect = await host.inspect(denyId);
            if (denyInspect.creation.network.mode !== "default-deny") {
              throw new Error("expected default-deny network on unconfigured create");
            }
            const blocked = await wget(denyId, "http://example.com/");
            if (blocked.exitCode === 0) {
              throw new Error("default-deny unexpectedly allowed outbound HTTP to example.com");
            }
            await cleanup(denyId);

            // 2) Explicit domain allow: example.com TCP 80 should succeed when host network works.
            await host.create({
              identity: allowId,
              image: "alpine:3.20",
              cpus: 1,
              memoryMiB: 512,
              network: {
                mode: "default-deny",
                allow: [{ kind: "domain", domain: "example.com", ports: [80], protocols: ["tcp"] }],
                publish: [],
              },
            });
            const allowed = await wget(allowId, "http://example.com/");
            if (allowed.exitCode !== 0) {
              // Distinguish policy failure from ambient network unavailability.
              const combined = (allowed.stdout + "\\n" + allowed.stderr).toLowerCase();
              if (combined.includes("bad address") || combined.includes("name resolution")) {
                await report({
                  status: "unavailable",
                  reason: "DNS/outbound unavailable in acceptance environment",
                });
                process.exitCode = 0;
                return;
              }
              throw new Error(
                "allowed domain wget failed exit=" +
                  allowed.exitCode +
                  " stderr=" +
                  allowed.stderr.slice(0, 200),
              );
            }
            await cleanup(allowId);

            // 3) Published port with explicit host binding (dynamic gated off on this pin).
            const hostPort = 18000 + (process.pid % 1000);
            const published = await host.create({
              identity: publishId,
              image: "alpine:3.20",
              cpus: 1,
              memoryMiB: 512,
              network: {
                mode: "default-deny",
                allow: [],
                publish: [{ guest: 8080, host: hostPort }],
              },
            });
            const port = published.creation.network.publish[0];
            if (
              port === undefined ||
              port.guest !== 8080 ||
              port.host !== hostPort ||
              port.bind !== "127.0.0.1"
            ) {
              throw new Error("expected inspectable explicit publish port, got " + JSON.stringify(port));
            }
            await cleanup(publishId);

            await report({ status: "passed" });
            process.exitCode = 0;
          } catch (error) {
            const kind = classifyFailure(error);
            await cleanup(denyId).catch(() => {});
            await cleanup(allowId).catch(() => {});
            await cleanup(publishId).catch(() => {});
            await report({ status: kind, reason: safeReason(error) });
            process.exitCode = kind === "unavailable" ? 0 : 1;
          } finally {
            await disposeHost(host);
          }
        };

        main();
      `,
    );

    try {
      const result = await run(process.execPath, [scriptPath], {
        cwd: packageRoot,
        env: { ...process.env, MSB_HOME: home },
        timeoutMs: CHILD_TIMEOUT_MS,
      });
      if (result.timedOut) {
        console.log(formatAcceptanceStatusLine("failed", "timed out"));
        throw new Error(`network acceptance timed out\n${result.stderr}`);
      }
      const report = parseReport(result.stdout);
      console.log(
        formatAcceptanceStatusLine(
          report.status,
          report.status === "unavailable" || report.status === "failed" ? report.reason : undefined,
        ),
      );
      if (report.status === "unavailable") {
        skip(true, `Microsandbox acceptance unavailable: ${report.reason}`);
        return;
      }
      expect(report.status).toBe("passed");
      expect(result.code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
