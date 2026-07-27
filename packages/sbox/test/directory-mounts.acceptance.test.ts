import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

describe("local Host directory mounts acceptance", () => {
  it("RO client + RO/RW host mounts, drift, bad roots, and bind decode after restart", async ({
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
    const vendor = join(root, "vendor");
    const toolsRo = join(root, "tools-ro");
    const toolsRw = join(root, "tools-rw");
    const realDir = join(root, "real");
    const linkDir = join(root, "link");
    await mkdir(home);
    await mkdir(vendor);
    await mkdir(toolsRo);
    await mkdir(toolsRw);
    await mkdir(realDir);
    await symlink(realDir, linkDir);
    await writeFile(join(vendor, "marker.txt"), "vendor", "utf8");
    const scriptPath = join(root, "directories.mjs");

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

        const vendor = ${JSON.stringify(vendor)};
        const toolsRo = ${JSON.stringify(toolsRo)};
        const toolsRw = ${JSON.stringify(toolsRw)};
        const linkDir = ${JSON.stringify(linkDir)};

        const identity = assertSandboxIdentity({
          project: "accept-dir",
          profile: "default",
          instance: "t" + process.pid,
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

            await expectReject(
              () => host.create({
                identity,
                image: "alpine:3.20",
                directories: [{ source: "client", path: linkDir, mount: "/bad", readonly: true }],
              }),
              /symlink/i,
            );

            const created = await host.create({
              identity,
              image: "alpine:3.20",
              cpus: 1,
              memoryMiB: 512,
              workdir: "/root",
              directories: [
                { source: "client", path: vendor, mount: "/vendor", readonly: true },
                { source: "host", path: toolsRo, mount: "/tools-ro", readonly: true },
                {
                  source: "host",
                  path: toolsRw,
                  mount: "/tools-rw",
                  readonly: false,
                  quotaMiB: 64,
                },
              ],
            });

            const dirs = created.creation.directories;
            if (dirs.length !== 3) {
              throw new Error("expected 3 directory mounts, got " + dirs.length);
            }
            const byMount = Object.fromEntries(dirs.map((d) => [d.mount, d]));
            if (byMount["/vendor"]?.readonly !== true || byMount["/vendor"]?.source !== "client") {
              throw new Error("client mount projection mismatch");
            }
            if (byMount["/tools-ro"]?.readonly !== true || byMount["/tools-ro"]?.source !== "host") {
              throw new Error("host RO mount projection mismatch");
            }
            if (
              byMount["/tools-rw"]?.readonly !== false ||
              byMount["/tools-rw"]?.quotaMiB !== 64
            ) {
              throw new Error("host RW mount projection mismatch");
            }

            const handle = await runtime.get(nativeName);
            const binds = handle.bindMounts;
            const bindByGuest = Object.fromEntries(binds.map((b) => [b.guestPath, b]));
            if (bindByGuest["/vendor"]?.readonly !== true) {
              throw new Error("native bind /vendor not readonly");
            }
            if (bindByGuest["/tools-ro"]?.readonly !== true) {
              throw new Error("native bind /tools-ro not readonly");
            }
            if (bindByGuest["/tools-rw"]?.readonly !== false || bindByGuest["/tools-rw"]?.quotaMiB !== 64) {
              throw new Error("native bind /tools-rw mode/quota mismatch");
            }
            if (bindByGuest["/vendor"]?.hostPath !== vendor) {
              throw new Error("native bind /vendor host path mismatch");
            }

            const exec = await host.execArgv({
              identity,
              argv: ["sh", "-c", "test -f /vendor/marker.txt && test -d /tools-ro && test -d /tools-rw"],
            });
            if (exec.exitCode !== 0) {
              throw new Error("guest mount paths missing (exit " + exec.exitCode + ")");
            }

            await host.stop(identity);
            // Fresh LocalHost process boundary: new runtime + host over same MSB_HOME.
            await disposeHost(host);
            const runtime2 = createMicrosandboxRuntime();
            const host2 = createLocalHostInternal({ runtime: runtime2 });
            try {
              const inspected = await host2.inspect(identity);
              if (JSON.stringify(inspected.creation.directories) !== JSON.stringify(dirs)) {
                throw new Error("directory projection drift after restart boundary");
              }
              const record = await runtime2.get(nativeName);
              if (record.bindMounts.length !== 3) {
                throw new Error("bindMounts not decoded after restart: " + record.bindMounts.length);
              }
              const drifted = await host2.create({
                identity: {
                  project: identity.project,
                  profile: identity.profile,
                  instance: identity.instance + "-drift",
                },
                image: "alpine:3.20",
                directories: [
                  { source: "client", path: vendor, mount: "/vendor", readonly: true },
                ],
              }).catch(() => null);
              // Drift check against existing: up-style already-exists with different dirs.
              await expectReject(
                () => host2.create({
                  identity,
                  image: "alpine:3.20",
                  directories: [
                    { source: "client", path: vendor, mount: "/vendor", readonly: true },
                    { source: "host", path: toolsRo, mount: "/tools-ro", readonly: true },
                  ],
                }),
                /ownership|configuration|already exists|creation|directories|immutable|conflict/i,
              );
              if (drifted !== null) {
                await host2.remove({
                  project: identity.project,
                  profile: identity.profile,
                  instance: identity.instance + "-drift",
                });
              }
              await host2.remove(identity);
            } finally {
              await disposeHost(host2);
            }

            await report({ status: "passed" });
          } catch (error) {
            const status = classifyFailure(error);
            await cleanup();
            await report({ status, reason: safeReason(error) });
            process.exitCode = status === "unavailable" ? 0 : 1;
          }
        };

        async function expectReject(fn, pattern) {
          try {
            await fn();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!pattern.test(message)) {
              throw new Error("rejection message mismatch: " + message);
            }
            return;
          }
          throw new Error("expected rejection matching " + pattern);
        }

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
        throw new Error(`acceptance failed: ${report.reason}\n${result.stderr}`);
      }
      console.log(formatAcceptanceStatusLine("passed"));
      expect(report.status).toBe("passed");
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
