/**
 * Local + remote Sandcastle adapter acceptance over real Microsandbox.
 *
 * Opt-in via `pnpm test:acceptance`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createLocalHost,
  createRemoteHost,
  createSboxClient,
  parseProjectConfig,
  type Host,
  type SboxClient,
} from "@sohcah/sbox";
import { createSboxSandcastleProvider } from "../src/index.js";
import { classifyAcceptanceFailure } from "../../sbox/test/helpers/acceptance-outcome.js";
import { formatAcceptanceStatusLine } from "../../sbox/test/helpers/acceptance-status.js";
import {
  distModulesAvailable,
  startRemoteServer,
} from "../../sbox/test/helpers/fakehost-remote-server.js";

function disposableTempPrefix(): string {
  return process.platform === "win32" ? join(tmpdir(), "sbox-sc-") : "/tmp/sbox-sc-";
}

function projectConfig(volume?: boolean) {
  return parseProjectConfig({
    version: 1,
    project: "scaccept",
    defaultProfile: "default",
    ...(volume
      ? {
          volumes: {
            data: { size: "64MiB" },
          },
        }
      : {}),
    profiles: {
      default: {
        image: "alpine:3.20",
        cpus: 1,
        memoryMiB: 512,
        workdir: "/root",
        user: "root",
        shell: "/bin/sh",
        ...(volume
          ? {
              volumes: [{ volume: "data", path: "/data" }],
            }
          : {}),
      },
    },
  });
}

async function exerciseProvider(client: SboxClient, workDir: string): Promise<void> {
  const provider = createSboxSandcastleProvider({
    client,
    profile: "default",
    worktreePath: "/root",
  });
  const handle = await provider.create({ env: { SC_ACCEPT: "1" } });
  try {
    expect(handle.worktreePath).toBe("/root");

    const lines: string[] = [];
    const live = await handle.exec("printf 'a\\nb\\n'; printf 'c\\n' 1>&2", {
      onLine: (line) => lines.push(line),
      cwd: "/root",
    });
    expect(live.exitCode).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(["a", "b", "c"]));

    const sudo = await handle.exec("id -u", { sudo: true });
    expect(sudo.exitCode).toBe(0);
    expect(sudo.stdout.trim()).toBe("0");

    const withStdin = await handle.exec("cat", { stdin: "from-stdin" });
    expect(withStdin.stdout).toBe("from-stdin");

    const src = join(workDir, "payload");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "note.txt"), "hello-sc", "utf8");
    await handle.copyIn(src, "/root/in");
    const outFile = join(workDir, "out.txt");
    await handle.copyFileOut("/root/in/note.txt", outFile);
    expect(await readFile(outFile, "utf8")).toBe("hello-sc");

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const interactive = handle.interactiveExec!(["printf", "%s", "pipe-ok"], {
      stdin,
      stdout,
      stderr,
    });
    stdin.end();
    await expect(interactive).resolves.toEqual({ exitCode: 0 });
    expect(out).toBe("pipe-ok");
  } finally {
    await handle.close();
  }
}

describe("Sandcastle adapter acceptance", () => {
  it("local: create → exec/onLine/sudo/stdin → copy → interactive → close", async ({ skip }) => {
    const forced = process.env["SBOX_ACCEPTANCE_FORCE"];
    if (forced === "unavailable" || forced === "passed" || forced === "failed") {
      console.log(
        formatAcceptanceStatusLine(forced, forced === "unavailable" ? "forced" : undefined),
      );
      if (forced === "unavailable") {
        skip(true, "Sandcastle acceptance unavailable: forced");
      }
      if (forced === "failed") {
        throw new Error("forced acceptance failure");
      }
      return;
    }

    const root = await mkdtemp(disposableTempPrefix());
    const home = join(root, "h");
    await mkdir(home);
    process.env["MSB_HOME"] = home;

    await using host: Host = createLocalHost();
    const caps = await host.capabilities();
    if (!caps.localMicrosandbox) {
      console.log(
        formatAcceptanceStatusLine("unavailable", caps.notes.join("; ") || "no microsandbox"),
      );
      skip(true, "Sandcastle acceptance unavailable: localMicrosandbox=false");
      return;
    }

    const useVolume = caps.qemuImg === true;
    const client = createSboxClient({
      project: projectConfig(useVolume),
      host,
      ownsHost: false,
    });

    try {
      if (useVolume) {
        await client.ensureVolume("data");
      }
      await exerciseProvider(client, root);
      console.log(formatAcceptanceStatusLine("passed", useVolume ? "volume" : "no-volume"));
    } catch (error) {
      const outcome = classifyAcceptanceFailure(error);
      console.log(
        formatAcceptanceStatusLine(outcome, error instanceof Error ? error.message : String(error)),
      );
      if (outcome === "unavailable") {
        skip(true, `Sandcastle acceptance unavailable: ${String(error)}`);
        return;
      }
      throw error;
    } finally {
      await client[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("remote: LocalHost behind serve driven by injected RemoteHost", async ({ skip }) => {
    const forced = process.env["SBOX_ACCEPTANCE_FORCE"];
    if (forced === "unavailable" || forced === "passed" || forced === "failed") {
      console.log(
        formatAcceptanceStatusLine(forced, forced === "unavailable" ? "forced" : undefined),
      );
      if (forced === "unavailable") {
        skip(true, "Sandcastle remote acceptance unavailable: forced");
      }
      if (forced === "failed") {
        throw new Error("forced acceptance failure");
      }
      return;
    }

    if (!(await distModulesAvailable())) {
      console.log(formatAcceptanceStatusLine("unavailable", "dist_missing"));
      skip(true, "Sandcastle remote acceptance unavailable: dist not built");
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
      skip(true, `Sandcastle remote acceptance unavailable: ${started.reason}`);
      return;
    }

    const { server } = started;
    await using remote = createRemoteHost({
      url: server.url,
      bearerToken: server.token,
    });

    try {
      const caps = await remote.capabilities();
      if (!caps.localMicrosandbox) {
        console.log(
          formatAcceptanceStatusLine("unavailable", caps.notes.join("; ") || "no microsandbox"),
        );
        skip(true, "Sandcastle remote acceptance unavailable: localMicrosandbox=false");
        return;
      }

      const client = createSboxClient({
        project: projectConfig(false),
        host: remote,
        ownsHost: false,
      });
      try {
        await exerciseProvider(client, root);
        console.log(formatAcceptanceStatusLine("passed", "remote"));
      } finally {
        await client[Symbol.asyncDispose]();
      }
    } catch (error) {
      const outcome = classifyAcceptanceFailure(error);
      console.log(
        formatAcceptanceStatusLine(outcome, error instanceof Error ? error.message : String(error)),
      );
      if (outcome === "unavailable") {
        skip(true, `Sandcastle remote acceptance unavailable: ${String(error)}`);
        return;
      }
      throw error;
    } finally {
      await server[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
