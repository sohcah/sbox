import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseProjectConfig, isSboxError } from "../src/index.js";
import {
  acquireVolumeLock,
  assertManagedHostPath,
  childOverlayPath,
  parseQemuImgInfoJson,
  volumeLockListenPath,
  volumePaths,
  POSIX_VOLUME_LOCK_LISTEN_MAX,
} from "../src/volume/index.js";
import { maintenanceInstanceId } from "../src/volume/naming.js";
import { FakeHost } from "../src/fake-host.js";
import { createSboxClient } from "../src/client/client.js";

const holdLockHelper = join(
  dirname(fileURLToPath(import.meta.url)),
  "helpers/hold-volume-lock-and-exit.mjs",
);
const distLockModule = join(dirname(fileURLToPath(import.meta.url)), "../dist/volume/lock.js");

describe("volume paths", () => {
  it("keeps managed paths under the data root", () => {
    // resolve() so Windows drive letters match volumePaths()/assertManagedHostPath().
    const root = resolve(
      process.platform === "win32" ? join(tmpdir(), "sbox-vol-root") : "/tmp/sbox-vol-root",
    );
    const paths = volumePaths("demo", "cache", root);
    expect(paths.basePath).toBe(join(root, "demo", "cache", "base.qcow2"));
    expect(childOverlayPath("demo", "cache", "default", root)).toBe(
      join(root, "demo", "cache", "children", "default", "cache.qcow2"),
    );
    expect(assertManagedHostPath(paths.basePath, root)).toBe(paths.basePath);
    expect(() => assertManagedHostPath(join(root, "..", "outside"), root)).toThrow();
  });

  it("builds portable maintenance instance ids", () => {
    expect(maintenanceInstanceId("cache")).toBe("vmaint-cache");
  });
});

describe("volume config attachments", () => {
  it("accepts profile attachments that reference declared volumes", () => {
    const config = parseProjectConfig({
      version: 1,
      project: "demo",
      volumes: { cache: { size: "1GiB" } },
      profiles: {
        default: {
          image: "alpine:3.20",
          volumes: [{ volume: "cache", path: "/cache" }],
        },
      },
    });
    expect(config.profiles["default"]?.volumes?.[0]).toEqual({
      volume: "cache",
      path: "/cache",
    });
  });

  it("rejects unknown volume attachments", () => {
    expect(() =>
      parseProjectConfig({
        version: 1,
        project: "demo",
        volumes: { cache: { size: "1GiB" } },
        profiles: {
          default: {
            image: "alpine:3.20",
            volumes: [{ volume: "missing", path: "/cache" }],
          },
        },
      }),
    ).toThrow(/Project configuration validation failed/);
  });

  it("rejects duplicate guest paths in one profile", () => {
    expect(() =>
      parseProjectConfig({
        version: 1,
        project: "demo",
        volumes: {
          cache: { size: "1GiB" },
          data: { size: "2GiB" },
        },
        profiles: {
          default: {
            image: "alpine:3.20",
            volumes: [
              { volume: "cache", path: "/data" },
              { volume: "data", path: "/data" },
            ],
          },
        },
      }),
    ).toThrow(/Project configuration validation failed/);
  });
});

describe("qemu-img info parsing", () => {
  it("parses virtual size and backing filename", () => {
    const info = parseQemuImgInfoJson(
      JSON.stringify({
        format: "qcow2",
        "virtual-size": 1073741824,
        "backing-filename": "/tmp/base.qcow2",
        "full-backing-filename": "/tmp/base.qcow2",
      }),
      "/tmp/child.qcow2",
    );
    expect(info.format).toBe("qcow2");
    expect(info.virtualSize).toBe(1073741824);
    expect(info.fullBackingFilename).toBe("/tmp/base.qcow2");
  });
});

describe("volume lock", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("excludes concurrent holders and releases on close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbox-vol-lock-"));
    dirs.push(dir);
    const sock = join(dir, "base.qcow2.lock.sock");
    const first = await acquireVolumeLock(sock);
    let secondError: unknown;
    try {
      await acquireVolumeLock(sock);
    } catch (error) {
      secondError = error;
    }
    expect(isSboxError(secondError) && secondError.code === "busy").toBe(true);
    await first.release();
    const third = await acquireVolumeLock(sock);
    await third.release();
  });

  it("allows concurrent holders on unrelated bases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbox-vol-lock-"));
    dirs.push(dir);
    const sockA = join(dir, "a", "base.qcow2.lock.sock");
    const sockB = join(dir, "b", "base.qcow2.lock.sock");
    const [first, second] = await Promise.all([acquireVolumeLock(sockA), acquireVolumeLock(sockB)]);
    await Promise.all([first.release(), second.release()]);
  });

  it("reclaims after the holding process exits without release", async () => {
    try {
      await access(distLockModule);
    } catch {
      // Unit runs after `pnpm build` in check; skip when dist is absent.
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "sbox-vol-lock-"));
    dirs.push(dir);
    const sock = join(dir, "base.qcow2.lock.sock");

    const child = spawn(process.execPath, [holdLockHelper, sock], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const exitCode = await new Promise<number | null>((res, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => res(code));
    });
    expect(stdout).toContain("held");
    expect(exitCode).toBe(0);

    const reclaimed = await acquireVolumeLock(sock);
    await reclaimed.release();
  });

  it("keeps POSIX listen paths short under deep data roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    const deep = join(
      "/var/folders",
      "x".repeat(40),
      "T",
      `sbox-vol-accept-${"y".repeat(20)}`,
      "volaccept",
      "cache",
      "base.qcow2.lock.sock",
    );
    expect(deep.length).toBeGreaterThan(104);
    const listen = volumeLockListenPath(deep);
    expect(listen.length).toBeLessThanOrEqual(POSIX_VOLUME_LOCK_LISTEN_MAX);
    expect(listen.startsWith("/tmp/sbox-vl-")).toBe(true);
    expect(listen.endsWith(".sock")).toBe(true);

    const held = await acquireVolumeLock(deep);
    await held.release();
  });
});

describe("FakeHost volume APIs", () => {
  it("ensures, lists, refuses remove with descendants, and supports shell", async () => {
    const host = new FakeHost();
    await using client = createSboxClient({
      host,
      ownsHost: false,
      project: {
        version: 1,
        project: "demo",
        volumes: { cache: { size: "1GiB" } },
        profiles: {
          default: {
            image: "alpine:3.20",
            volumes: [{ volume: "cache", path: "/cache" }],
          },
        },
      },
    });

    const ensured = await client.ensureVolume("cache");
    expect(ensured.sizeBytes).toBe(1024 ** 3);
    expect((await client.listVolumes())[0]?.volume).toBe("cache");

    const handle = await client.create();
    await expect(client.removeVolume("cache")).rejects.toMatchObject({ code: "busy" });

    await handle.remove();
    await client.removeVolume("cache");
    expect(await client.listVolumes()).toEqual([]);

    await client.ensureVolume("cache");
    const shell = await client.volumeShell("cache");
    expect(shell.identity.instance).toBe("vmaint-cache");
    await shell.remove();
  });
});
