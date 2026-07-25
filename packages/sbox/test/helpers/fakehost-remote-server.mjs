/**
 * Subprocess authenticated sbox server for remote contract / acceptance tests.
 *
 * Requires `pnpm build` (imports `dist/`). Protocol:
 * - stdout: one JSON ready line
 *   success: `{ "ok": true, "url": "...", "token": "...", "host": "fake"|"local" }`
 *   probe miss (local only): `{ "ok": false, "unavailable": true, "reason": "..." }`
 * - stdin line `shutdown` → graceful server close, exit 0
 * - SIGTERM/SIGINT → graceful close, exit 0
 *
 * Env:
 * - SBOX_TEST_TOKEN (required, min 16 chars)
 * - SBOX_TEST_HOST (`fake` default, or `local`)
 * - SBOX_TEST_BIND (default 127.0.0.1)
 * - SBOX_TEST_PORT (default 0 = ephemeral)
 * - SBOX_TEST_LIMITS (optional JSON Partial<RemoteLimits>)
 * - MSB_HOME (recommended for `local`)
 */

import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = join(here, "../../dist");
const serverPath = join(distRoot, "remote/server.js");
const fakeHostPath = join(distRoot, "fake-host.js");
const localHostPath = join(distRoot, "local-host.js");
const runtimePath = join(distRoot, "microsandbox-runtime.js");

const hostKind = process.env.SBOX_TEST_HOST === "local" ? "local" : "fake";
const required = [serverPath, hostKind === "local" ? localHostPath : fakeHostPath];
if (hostKind === "local") {
  required.push(runtimePath);
}
for (const path of required) {
  try {
    await access(path);
  } catch {
    console.error(`missing built module: ${path}`);
    process.exit(3);
  }
}

const token = process.env.SBOX_TEST_TOKEN;
if (typeof token !== "string" || token.length < 16) {
  console.error("SBOX_TEST_TOKEN must be set to at least 16 characters.");
  process.exit(2);
}

const bind = process.env.SBOX_TEST_BIND ?? "127.0.0.1";
const portRaw = process.env.SBOX_TEST_PORT;
const port = typeof portRaw === "string" && portRaw.length > 0 ? Number(portRaw) : 0;
if (!Number.isInteger(port) || port < 0) {
  console.error("SBOX_TEST_PORT must be a nonnegative integer.");
  process.exit(2);
}

let limits = {};
if (typeof process.env.SBOX_TEST_LIMITS === "string" && process.env.SBOX_TEST_LIMITS.length > 0) {
  try {
    limits = JSON.parse(process.env.SBOX_TEST_LIMITS);
  } catch (error) {
    console.error("SBOX_TEST_LIMITS must be valid JSON.", error);
    process.exit(2);
  }
}

const { createSboxServer } = await import(pathToFileURL(serverPath).href);

/** @type {import("../../dist/host.js").Host} */
let host;
if (hostKind === "local") {
  const { createMicrosandboxRuntime } = await import(pathToFileURL(runtimePath).href);
  const { createLocalHost } = await import(pathToFileURL(localHostPath).href);
  const runtime = createMicrosandboxRuntime();
  const probe = await runtime.probe();
  if (!probe.available) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        unavailable: true,
        reason: probe.notes.join("; ") || "microsandbox unavailable",
        host: "local",
      })}\n`,
    );
    process.exit(0);
  }
  host = createLocalHost();
} else {
  const { FakeHost } = await import(pathToFileURL(fakeHostPath).href);
  host = new FakeHost();
}

const server = await createSboxServer({
  host,
  bearerToken: token,
  bind,
  port,
  limits,
});

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    url: server.url,
    token,
    bind: server.bind,
    port: server.port,
    host: hostKind,
  })}\n`,
);

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await server.close();
  } catch (error) {
    console.error("server close failed", error);
    process.exitCode = 1;
    process.exit(1);
  }
  try {
    await host[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
  process.exit(code);
}

process.on("SIGTERM", () => {
  void shutdown(0);
});
process.on("SIGINT", () => {
  void shutdown(0);
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim() === "shutdown") {
    void shutdown(0);
  }
});
