/**
 * Remote Host contract against an authenticated FakeHost-backed server.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { FakeHost } from "../src/fake-host.js";
import { createRemoteHost } from "../src/remote/remote-host.js";
import { createSboxServer } from "../src/remote/server.js";
import { SBOX_PROTOCOL_VERSION } from "../src/remote/protocol.js";
import { assertSandboxIdentity } from "../src/identity.js";
import { isSboxError } from "../src/errors.js";
import { utf8ToBytes } from "../src/process/decode.js";

const TOKEN = "test-token-phase7-0123456789abcdef";

const remoteSrcRoot = join(dirname(fileURLToPath(import.meta.url)), "../src/remote");

describe("remote host contract", () => {
  it("serves health without auth and rejects missing bearer", async () => {
    const fake = new FakeHost();
    await using server = await createSboxServer({
      host: fake,
      bearerToken: TOKEN,
      bind: "127.0.0.1",
    });

    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, protocolVersion: SBOX_PROTOCOL_VERSION });

    const denied = await fetch(`${server.url}/v1/handshake`);
    expect(denied.status).toBe(401);
  });

  it("handshakes and runs lifecycle + collected exec through RemoteHost", async () => {
    const fake = new FakeHost();
    await using server = await createSboxServer({
      host: fake,
      bearerToken: TOKEN,
      bind: "127.0.0.1",
    });
    await using remote = createRemoteHost({ url: server.url, bearerToken: TOKEN });

    const caps = await remote.capabilities();
    expect(typeof caps.localMicrosandbox).toBe("boolean");
    expect(Array.isArray(caps.notes)).toBe(true);

    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "main",
    });
    const created = await remote.create({
      identity,
      image: "alpine:3.20",
    });
    expect(created.identity.instance).toBe("main");

    const listed = await remote.list({ project: identity.project });
    expect(listed.some((s) => s.identity.instance === "main")).toBe(true);

    await remote.stop(identity);
    await remote.start(identity);

    const result = await remote.execArgv({ identity, argv: ["echo", "hi"] });
    expect(result.exitCode).toBe(0);

    await remote.remove(identity);
    expect(await remote.list({ project: identity.project })).toEqual([]);
  });

  it("rejects wrong bearer on HTTP handshake", async () => {
    const fake = new FakeHost();
    await using server = await createSboxServer({
      host: fake,
      bearerToken: TOKEN,
      bind: "127.0.0.1",
    });
    await using remote = createRemoteHost({ url: server.url, bearerToken: "wrong-token" });
    await expect(remote.capabilities()).rejects.toSatisfy(
      (error: unknown) => isSboxError(error) && error.code === "authentication",
    );
  });

  it("rejects wrong bearer on WebSocket upgrade", async () => {
    const fake = new FakeHost();
    await using server = await createSboxServer({
      host: fake,
      bearerToken: TOKEN,
      bind: "127.0.0.1",
    });
    const { WebSocket } = await import("ws");
    const wsUrl = server.url.replace(/^http/, "ws") + "/v1/session";
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          headers: { authorization: "Bearer wrong-token" },
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
        ws.once("error", () => {
          // Some stacks surface upgrade failure as error; treat as rejection.
          resolve();
        });
      }),
    ).resolves.toBeUndefined();
  });

  it("surfaces remote streaming not_found when opening the session", async () => {
    const fake = new FakeHost();
    await using server = await createSboxServer({
      host: fake,
      bearerToken: TOKEN,
      bind: "127.0.0.1",
    });
    await using remote = createRemoteHost({ url: server.url, bearerToken: TOKEN });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "missing",
    });

    await expect(remote.execArgvStream({ identity, argv: ["true"] })).rejects.toSatisfy(
      (error: unknown) => isSboxError(error) && error.code === "not_found",
    );
  });

  it("treats abrupt WebSocket close without exited as transport failure", async () => {
    const httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, protocolVersion: SBOX_PROTOCOL_VERSION }));
        return;
      }
      if (url.pathname === "/v1/handshake") {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            protocolVersion: SBOX_PROTOCOL_VERSION,
            capabilities: {
              localMicrosandbox: false,
              dynamicHostPorts: true,
              qemuImg: false,
              dockerPlatform: "linux/amd64",
              notes: [],
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.once("message", () => {
          ws.send(JSON.stringify({ type: "ready" }));
          ws.terminate();
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    try {
      await using remote = createRemoteHost({ url, bearerToken: TOKEN });
      const identity = assertSandboxIdentity({
        project: "demo",
        profile: "default",
        instance: "drop",
      });
      const session = await remote.execArgvStream({ identity, argv: ["true"] });
      await expect(session.wait()).rejects.toSatisfy(
        (error: unknown) => isSboxError(error) && error.code === "transport",
      );
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("accepts PTY writes immediately after open and settles wait without draining", async () => {
    const fake = new FakeHost();
    await using server = await createSboxServer({
      host: fake,
      bearerToken: TOKEN,
      bind: "127.0.0.1",
    });
    await using remote = createRemoteHost({ url: server.url, bearerToken: TOKEN });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "pty",
    });
    await remote.create({ identity, image: "alpine:3.20" });

    const session = await remote.pty({ identity, argv: ["/bin/sh"] }, { rows: 24, cols: 80 });
    // Client does not drain output — mirrors local FakeHost wait() after write.
    await session.write("hello-immediate-pty\n");
    await session.resize({ rows: 30, cols: 100 });
    await expect(session.wait()).resolves.toEqual({ exitCode: 0, signal: null });

    const session2 = await remote.pty({ identity, argv: ["/bin/sh"] });
    const chunks: Uint8Array[] = [];
    const pump = (async () => {
      for await (const chunk of session2.output) {
        chunks.push(chunk);
      }
    })();
    await session2.write("with-drain\n");
    await expect
      .poll(() => Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"))
      .toContain("with-drain");
    await session2.cancel("pty-test-done");
    await expect(session2.wait()).rejects.toSatisfy(
      (error: unknown) => isSboxError(error) && error.code === "cancellation",
    );
    await expect(pump).rejects.toSatisfy(
      (error: unknown) => isSboxError(error) && error.code === "cancellation",
    );

    await remote.remove(identity);
  });

  it("forwards collected stdoutMaxBytes through RemoteHost", async () => {
    const fake = new FakeHost();
    fake.execHandler = async () => ({
      exitCode: 0,
      stdout: utf8ToBytes("x".repeat(5000)),
      stderr: new Uint8Array(),
    });
    await using server = await createSboxServer({
      host: fake,
      bearerToken: TOKEN,
      bind: "127.0.0.1",
    });
    await using remote = createRemoteHost({ url: server.url, bearerToken: TOKEN });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "limit",
    });
    await remote.create({ identity, image: "alpine:3.20" });
    await expect(
      remote.execArgv({ identity, argv: ["big"] }, { stdoutMaxBytes: 10 }),
    ).rejects.toSatisfy((error: unknown) => isSboxError(error) && error.code === "output_limit");
    await remote.remove(identity);
  });

  it("rejects non-loopback bind without allowNonLoopback", async () => {
    const fake = new FakeHost();
    await expect(
      createSboxServer({
        host: fake,
        bearerToken: TOKEN,
        bind: "0.0.0.0",
      }),
    ).rejects.toSatisfy((error: unknown) => isSboxError(error) && error.code === "validation");
  });

  it("copies host↔guest through archive transfer", async () => {
    const fake = new FakeHost();
    await using server = await createSboxServer({
      host: fake,
      bearerToken: TOKEN,
      bind: "127.0.0.1",
    });
    await using remote = createRemoteHost({ url: server.url, bearerToken: TOKEN });

    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "xfer",
    });
    await remote.create({ identity, image: "alpine:3.20" });

    const srcDir = await mkdtemp(join(tmpdir(), "sbox-remote-src-"));
    const dstDir = await mkdtemp(join(tmpdir(), "sbox-remote-dst-"));
    try {
      await writeFile(join(srcDir, "note.txt"), "hello-remote");
      await remote.copyHostToGuest({
        identity,
        hostPath: join(srcDir, "note.txt"),
        guestPath: "/tmp/note.txt",
      });
      await remote.copyGuestToHost({
        identity,
        hostPath: dstDir,
        guestPath: "/tmp/note.txt",
      });
      const out = await readFile(join(dstDir, "note.txt"), "utf8");
      expect(out).toBe("hello-remote");
    } finally {
      await rm(srcDir, { recursive: true, force: true });
      await rm(dstDir, { recursive: true, force: true });
      await remote.remove(identity);
    }
  });

  it("does not import project YAML or discovery under src/remote", async () => {
    const { readdir } = await import("node:fs/promises");
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.name.endsWith(".ts")) {
          files.push(path);
        }
      }
    }
    await walk(remoteSrcRoot);
    expect(files.length).toBeGreaterThan(0);
    const forbidden =
      /from ["'].*(?:discovery|yaml|project-config|config\/load|config\/parse)["']|yamlProjectInputSchema|discoverProjectConfig|discoverUserConfig/;
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text, file).not.toMatch(forbidden);
    }
  });
});
