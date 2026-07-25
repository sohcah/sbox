/**
 * Remote Host contract against an authenticated FakeHost server in a subprocess.
 *
 * Catches transport timing / stream-lifecycle issues that in-process tests miss.
 * Requires built `dist/` (available under `pnpm check`).
 */

import { describe, expect, it, beforeEach } from "vitest";
import { WebSocket } from "ws";
import { createRemoteHost } from "../src/remote/remote-host.js";
import { SBOX_PROTOCOL_VERSION } from "../src/remote/protocol.js";
import { assertSandboxIdentity } from "../src/identity.js";
import { isSboxError } from "../src/errors.js";
import {
  distModulesAvailable,
  startFakeHostRemoteServer,
} from "./helpers/fakehost-remote-server.js";

const distReady = await distModulesAvailable();

describe.skipIf(!distReady)("remote host subprocess contract", () => {
  // Name the active case on stderr so a rare flake / hang is identifiable in CI logs.
  beforeEach((ctx) => {
    console.error(`[remote-subprocess] ${ctx.task.name}`);
  });

  it("serves health without auth and rejects missing/wrong bearer over the wire", async () => {
    await using server = await startFakeHostRemoteServer();

    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, protocolVersion: SBOX_PROTOCOL_VERSION });

    const denied = await fetch(`${server.url}/v1/handshake`);
    expect(denied.status).toBe(401);

    await using bad = createRemoteHost({
      url: server.url,
      bearerToken: "wrong-token-subprocess",
    });
    await expect(bad.capabilities()).rejects.toSatisfy(
      (error: unknown) => isSboxError(error) && error.code === "authentication",
    );
  });

  it("rejects wrong bearer on WebSocket upgrade", async () => {
    await using server = await startFakeHostRemoteServer();
    const wsUrl = server.url.replace(/^http/, "ws") + "/v1/session";
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          headers: { authorization: "Bearer wrong-token-subprocess" },
        });
        ws.once("open", () => {
          ws.close();
          reject(new Error("upgrade should not succeed"));
        });
        ws.once("unexpected-response", (_req, res) => {
          expect(res.statusCode).toBe(401);
          res.resume();
          resolve();
        });
        ws.once("error", () => resolve());
      }),
    ).resolves.toBeUndefined();
  });

  it("runs lifecycle + collected exec through RemoteHost", async () => {
    await using server = await startFakeHostRemoteServer();
    await using remote = createRemoteHost({
      url: server.url,
      bearerToken: server.token,
    });

    const caps = await remote.capabilities();
    expect(caps.notes.some((n) => n.includes("FakeHost"))).toBe(true);

    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "main",
    });
    await remote.create({ identity, image: "alpine:3.20" });
    expect((await remote.list({ project: identity.project })).length).toBe(1);
    await remote.stop(identity);
    await remote.start(identity);

    const result = await remote.execArgv({ identity, argv: ["echo", "hi"] });
    expect(result.exitCode).toBe(0);

    await remote.remove(identity);
    expect(await remote.list({ project: identity.project })).toEqual([]);
  });

  it("surfaces streaming not_found across the process boundary", async () => {
    await using server = await startFakeHostRemoteServer();
    await using remote = createRemoteHost({
      url: server.url,
      bearerToken: server.token,
    });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "missing",
    });
    await expect(remote.execArgvStream({ identity, argv: ["true"] })).rejects.toSatisfy(
      (error: unknown) => isSboxError(error) && error.code === "not_found",
    );
  });

  it("accepts immediate PTY write and settles wait without draining", async () => {
    await using server = await startFakeHostRemoteServer();
    await using remote = createRemoteHost({
      url: server.url,
      bearerToken: server.token,
    });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "pty",
    });
    await remote.create({ identity, image: "alpine:3.20" });

    const session = await remote.pty({ identity, argv: ["/bin/sh"] }, { rows: 24, cols: 80 });
    await session.write("hello-subprocess-pty\n");
    await session.resize({ rows: 30, cols: 100 });
    await expect(session.wait()).resolves.toEqual({ exitCode: 0, signal: null });

    await remote.remove(identity);
  });

  it("streams exec events across processes", async () => {
    await using server = await startFakeHostRemoteServer();
    await using remote = createRemoteHost({
      url: server.url,
      bearerToken: server.token,
    });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "stream",
    });
    await remote.create({ identity, image: "alpine:3.20" });

    const session = await remote.execArgvStream({ identity, argv: ["echo", "stream-hi"] });
    const types: string[] = [];
    let stdout = "";
    for await (const event of session) {
      types.push(event.type);
      if (event.type === "stdout") {
        stdout += Buffer.from(event.data).toString("utf8");
      }
    }
    const settled = await session.wait();
    expect(settled.exitCode).toBe(0);
    expect(types).toContain("started");
    expect(types).toContain("exited");
    expect(stdout.length).toBeGreaterThan(0);

    await remote.remove(identity);
  });

  it("reports transport when the server subprocess is killed mid-session", async () => {
    const server = await startFakeHostRemoteServer();
    try {
      await using remote = createRemoteHost({
        url: server.url,
        bearerToken: server.token,
      });
      const identity = assertSandboxIdentity({
        project: "demo",
        profile: "default",
        instance: "kill",
      });
      await remote.create({ identity, image: "alpine:3.20" });
      const session = await remote.pty({ identity, argv: ["/bin/sh"] });
      await session.write("still-here\n");
      await server.kill();
      await expect(session.wait()).rejects.toSatisfy(
        (error: unknown) => isSboxError(error) && error.code === "transport",
      );
    } finally {
      await server.kill().catch(() => undefined);
    }
  });

  it("drains on graceful shutdown and rejects new work", async () => {
    const server = await startFakeHostRemoteServer();
    try {
      await using warm = createRemoteHost({
        url: server.url,
        bearerToken: server.token,
      });
      await warm.capabilities();
      const code = await server.shutdown();
      expect(code).toBe(0);

      // New client — handshake cache must not hide a dead server.
      await using cold = createRemoteHost({
        url: server.url,
        bearerToken: server.token,
      });
      await expect(cold.capabilities()).rejects.toSatisfy(
        (error: unknown) =>
          isSboxError(error) && (error.code === "transport" || error.code === "busy"),
      );
    } finally {
      await server.kill().catch(() => undefined);
    }
  });
});
