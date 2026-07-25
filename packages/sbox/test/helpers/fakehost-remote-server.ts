/**
 * Spawn/manage an authenticated sbox server subprocess (FakeHost or LocalHost).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RemoteLimits } from "../../src/remote/limits.js";

const helperPath = join(dirname(fileURLToPath(import.meta.url)), "fakehost-remote-server.mjs");
const distFakeHost = join(dirname(fileURLToPath(import.meta.url)), "../../dist/fake-host.js");

export const FAKEHOST_REMOTE_TOKEN = "test-token-subprocess-0123456789abcdef";

export type RemoteServerHostKind = "fake" | "local";

export interface RemoteServerHandle extends AsyncDisposable {
  readonly url: string;
  readonly token: string;
  readonly hostKind: RemoteServerHostKind;
  readonly pid: number | undefined;
  /** Accumulated child stderr (for failure diagnosis). */
  readonly stderr: () => string;
  /** Request graceful shutdown via stdin and wait for exit. */
  shutdown(): Promise<number | null>;
  /** Abruptly kill the child (SIGKILL). */
  kill(): Promise<number | null>;
}

export type StartRemoteServerResult =
  | { readonly kind: "ready"; readonly server: RemoteServerHandle }
  | { readonly kind: "unavailable"; readonly reason: string };

export async function distModulesAvailable(): Promise<boolean> {
  try {
    await access(distFakeHost);
    return true;
  } catch {
    return false;
  }
}

/** @deprecated Use {@link startRemoteServer} with `host: "fake"`. */
export async function startFakeHostRemoteServer(options?: {
  readonly token?: string;
  readonly limits?: Partial<RemoteLimits>;
  readonly readyTimeoutMs?: number;
}): Promise<RemoteServerHandle> {
  const result = await startRemoteServer({
    host: "fake",
    ...(options?.token !== undefined ? { token: options.token } : {}),
    ...(options?.limits !== undefined ? { limits: options.limits } : {}),
    ...(options?.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
  });
  if (result.kind !== "ready") {
    throw new Error(`FakeHost server unavailable: ${result.reason}`);
  }
  return result.server;
}

export async function startRemoteServer(options?: {
  readonly host?: RemoteServerHostKind;
  readonly token?: string;
  readonly limits?: Partial<RemoteLimits>;
  readonly readyTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<StartRemoteServerResult> {
  if (!(await distModulesAvailable())) {
    throw new Error(`Remote server subprocess requires built dist (missing ${distFakeHost}).`);
  }

  const hostKind = options?.host ?? "fake";
  const token = options?.token ?? FAKEHOST_REMOTE_TOKEN;
  const readyTimeoutMs = options?.readyTimeoutMs ?? (hostKind === "local" ? 60_000 : 15_000);
  const child = spawn(process.execPath, [helperPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...options?.env,
      SBOX_TEST_TOKEN: token,
      SBOX_TEST_BIND: "127.0.0.1",
      SBOX_TEST_HOST: hostKind,
      ...(options?.limits !== undefined
        ? { SBOX_TEST_LIMITS: JSON.stringify(options.limits) }
        : {}),
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const ready = await waitForReadyLine(child, () => stdout, readyTimeoutMs).catch((error) => {
    child.kill("SIGKILL");
    throw new Error(
      `Remote server (${hostKind}) failed to become ready: ${String(error)}\nstderr:\n${stderr}\nstdout:\n${stdout}`,
    );
  });

  if (ready.unavailable) {
    await waitChildExit(child).catch(() => undefined);
    return { kind: "unavailable", reason: ready.reason ?? "unavailable" };
  }

  let exitPromise: Promise<number | null> | undefined;
  const waitExit = (): Promise<number | null> => {
    if (exitPromise === undefined) {
      exitPromise = waitChildExit(child);
    }
    return exitPromise;
  };

  const stop = async (mode: "shutdown" | "kill"): Promise<number | null> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return child.exitCode;
    }
    if (mode === "shutdown") {
      child.stdin?.write("shutdown\n");
      child.stdin?.end();
      return await Promise.race([
        waitExit(),
        delay(10_000).then(() => {
          child.kill("SIGKILL");
          return waitExit();
        }),
      ]);
    }
    child.kill("SIGKILL");
    return waitExit();
  };

  const server: RemoteServerHandle = {
    url: ready.url!,
    token: ready.token!,
    hostKind,
    pid: child.pid,
    stderr: () => stderr,
    shutdown: () => stop("shutdown"),
    kill: () => stop("kill"),
    async [Symbol.asyncDispose]() {
      await stop("shutdown");
    },
  };
  return { kind: "ready", server };
}

function waitChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function waitForReadyLine(
  child: ChildProcess,
  getStdout: () => string,
  timeoutMs: number,
): Promise<{
  readonly unavailable?: boolean;
  readonly reason?: string;
  readonly url?: string;
  readonly token?: string;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child exited before ready (code=${String(child.exitCode)})`);
    }
    const text = getStdout();
    const nl = text.indexOf("\n");
    if (nl !== -1) {
      const line = text.slice(0, nl).trim();
      const parsed = JSON.parse(line) as {
        ok?: boolean;
        unavailable?: boolean;
        reason?: string;
        url?: string;
        token?: string;
      };
      if (parsed.ok === false && parsed.unavailable === true) {
        return {
          unavailable: true,
          reason: typeof parsed.reason === "string" ? parsed.reason : "unavailable",
        };
      }
      if (
        parsed.ok !== true ||
        typeof parsed.url !== "string" ||
        typeof parsed.token !== "string"
      ) {
        throw new Error(`invalid ready line: ${line}`);
      }
      return { url: parsed.url, token: parsed.token };
    }
    await delay(20);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ready line`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
