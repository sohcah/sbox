/**
 * Remote acceptance: real LocalHost behind authenticated serve, driven via RemoteHost.
 *
 * Opt-in via `pnpm test:acceptance`. Requires Microsandbox (and Docker for images).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile, chmod, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRemoteHost } from "../src/remote/remote-host.js";
import { assertSandboxIdentity } from "../src/identity.js";
import { bytesToUtf8 } from "../src/process/decode.js";
import { classifyAcceptanceFailure } from "./helpers/acceptance-outcome.js";
import { formatAcceptanceStatusLine } from "./helpers/acceptance-status.js";
import { distModulesAvailable, startRemoteServer } from "./helpers/fakehost-remote-server.js";

/** Prefer `/tmp` on Unix so `MSB_HOME` stays short (macOS Unix socket ~104 byte limit). */
function disposableTempPrefix(): string {
  return process.platform === "win32" ? join(tmpdir(), "sbox-") : "/tmp/sbox-";
}

describe("remote LocalHost acceptance", () => {
  it("create → exec → stream → PTY → transfer → remove over RemoteHost", async ({ skip }) => {
    const forced = process.env["SBOX_ACCEPTANCE_FORCE"];
    if (forced === "unavailable" || forced === "passed" || forced === "failed") {
      console.log(
        formatAcceptanceStatusLine(forced, forced === "unavailable" ? "forced" : undefined),
      );
      if (forced === "unavailable") {
        skip(true, "Remote acceptance unavailable: forced");
      }
      if (forced === "failed") {
        throw new Error("forced acceptance failure");
      }
      return;
    }

    if (!(await distModulesAvailable())) {
      console.log(formatAcceptanceStatusLine("unavailable", "dist_missing"));
      skip(true, "Remote acceptance unavailable: dist not built");
      return;
    }

    const root = await mkdtemp(disposableTempPrefix());
    const home = join(root, "h");
    await mkdir(home);

    const started = await startRemoteServer({
      host: "local",
      env: { MSB_HOME: home },
      readyTimeoutMs: 60_000,
    });
    if (started.kind === "unavailable") {
      console.log(formatAcceptanceStatusLine("unavailable", started.reason));
      await rm(root, { recursive: true, force: true });
      skip(true, `Remote acceptance unavailable: ${started.reason}`);
      return;
    }

    const { server } = started;
    await using remote = createRemoteHost({
      url: server.url,
      bearerToken: server.token,
    });

    const identity = assertSandboxIdentity({
      project: "accept",
      profile: "default",
      instance: `r${process.pid}`,
    });

    try {
      const caps = await remote.capabilities();
      if (!caps.localMicrosandbox) {
        console.log(
          formatAcceptanceStatusLine("unavailable", caps.notes.join("; ") || "no microsandbox"),
        );
        skip(true, "Remote acceptance unavailable: localMicrosandbox=false");
        return;
      }

      await remote.create({
        identity,
        image: "alpine:3.20",
        cpus: 1,
        memoryMiB: 512,
        workdir: "/root",
        user: "root",
        shell: "/bin/sh",
        hostname: "accept-remote",
      });

      const exact = await remote.execArgv({
        identity,
        argv: ["printf", "%s", "hello-remote"],
      });
      expect(exact.exitCode).toBe(0);
      expect(bytesToUtf8(exact.stdout)).toBe("hello-remote");

      const shelled = await remote.execShell({
        identity,
        script: "printf '%s' shell-remote",
        shell: "/bin/sh",
      });
      expect(shelled.exitCode).toBe(0);
      expect(bytesToUtf8(shelled.stdout)).toBe("shell-remote");

      const session = await remote.execArgvStream({
        identity,
        argv: ["printf", "%s", "stream-remote"],
      });
      const types: string[] = [];
      let streamOut = "";
      try {
        for await (const event of session) {
          types.push(event.type);
          if (event.type === "stdout") {
            streamOut += bytesToUtf8(event.data);
          }
        }
        expect(await session.wait()).toEqual({ exitCode: 0, signal: null });
        expect(streamOut).toBe("stream-remote");
        expect(types).toContain("started");
        expect(types).toContain("exited");
      } finally {
        await session[Symbol.asyncDispose]();
      }

      const pty = await remote.pty({ identity, argv: ["/bin/sh"] }, { rows: 24, cols: 80 });
      try {
        await pty.write("echo pty-remote\\n");
        await pty.resize({ rows: 30, cols: 100 });
        await pty.cancel("acceptance-done");
      } finally {
        try {
          await pty[Symbol.asyncDispose]();
        } catch {
          // ignore
        }
      }

      const xferRoot = await mkdtemp(join(tmpdir(), "sbox-remote-accept-xfer-"));
      try {
        const hostFile = join(xferRoot, "payload.bin");
        const payload = Buffer.from([0, 1, 2, 255, 10]);
        await writeFile(hostFile, payload);
        await remote.copyHostToGuest({
          identity,
          hostPath: hostFile,
          guestPath: "/tmp/payload.bin",
        });
        const roundTripFile = join(xferRoot, "out.bin");
        await remote.copyGuestToHost({
          identity,
          guestPath: "/tmp/payload.bin",
          hostPath: roundTripFile,
        });
        expect(await readFile(roundTripFile)).toEqual(payload);

        const hostDir = join(xferRoot, "dir");
        await mkdir(join(hostDir, "nested"), { recursive: true });
        const script = join(hostDir, "nested", "run.sh");
        await writeFile(script, "#!/bin/sh\necho hi\n");
        await chmod(script, 0o755);
        await remote.copyHostToGuest({
          identity,
          hostPath: hostDir,
          guestPath: "/tmp/treedir",
        });
        const backDir = join(xferRoot, "back");
        await remote.copyGuestToHost({
          identity,
          guestPath: "/tmp/treedir",
          hostPath: backDir,
        });
        const st = await lstat(join(backDir, "nested", "run.sh"));
        expect(st.mode & 0o111).not.toBe(0);
      } finally {
        await rm(xferRoot, { recursive: true, force: true });
      }

      await remote.stop(identity);
      await remote.remove(identity);
      console.log(formatAcceptanceStatusLine("passed"));
    } catch (error) {
      try {
        await remote.stop(identity);
      } catch {
        // ignore
      }
      try {
        await remote.remove(identity);
      } catch {
        // ignore
      }
      const status = classifyAcceptanceFailure(error);
      const reason =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
      console.log(formatAcceptanceStatusLine(status, reason));
      const childErr = server.stderr();
      if (childErr.trim() !== "") {
        console.error(`[remote-acceptance] server stderr:\n${childErr}`);
      }
      if (status === "unavailable") {
        skip(true, `Remote acceptance unavailable: ${reason}`);
        return;
      }
      throw error;
    } finally {
      await server.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
