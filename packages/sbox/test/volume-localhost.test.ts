import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalHostInternal } from "../src/local-host-internal.js";
import { assertSandboxIdentity } from "../src/identity.js";
import { buildOwnershipLabels } from "../src/ownership-adoption.js";
import { projectCreateRequest } from "../src/immutable-creation.js";
import { isSboxError, SboxError } from "../src/errors.js";
import {
  acquireVolumeLock,
  buildVolumeMaintenanceLabels,
  childOverlayPath,
  ensureVolumeBase,
  formatAndPublishBase,
  isManagedChildOverlayPath,
  maintenanceInstanceId,
  removeHostOverlayPath,
  volumePaths,
} from "../src/volume/index.js";
import { decodeDiskMounts } from "../src/volume/mounts.js";
import { recoverCrashedMaintenance } from "../src/volume/maintenance.js";
import { MemoryNativeRuntime } from "./helpers/memory-native-runtime.js";
import { createFakeQemuImgPorts } from "./helpers/fake-qemu-img.js";
import { nativeSandboxName } from "../src/identity.js";

const SIZE = 64 * 1024 * 1024;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("LocalHost managed volumes", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function setup() {
    const dataRoot = await mkdtemp(join(tmpdir(), "sbox-vol-lh-"));
    dirs.push(dataRoot);
    const runtime = new MemoryNativeRuntime();
    const qemu = createFakeQemuImgPorts(SIZE);
    const host = createLocalHostInternal({
      runtime,
      volumeDataRoot: dataRoot,
      qemuImg: qemu.ports,
    });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "main",
    });
    const paths = volumePaths("demo", "cache", dataRoot);
    await qemu.seedBase(paths.basePath);
    return { host, runtime, qemu, dataRoot, identity, paths };
  }

  it("creates child overlays on create and removes only children on remove", async () => {
    const { host, dataRoot, identity, paths } = await setup();
    const childPath = childOverlayPath("demo", "cache", "main", dataRoot);

    const created = await host.create({
      identity,
      image: "alpine:3.20",
      volumes: [{ volume: "cache", path: "/cache", sizeBytes: SIZE }],
    });
    expect(created.creation.volumes).toEqual([{ volume: "cache", path: "/cache" }]);
    expect(await pathExists(childPath)).toBe(true);
    expect(await pathExists(paths.basePath)).toBe(true);

    await host.remove(identity);
    expect(await pathExists(childPath)).toBe(false);
    expect(await pathExists(paths.basePath)).toBe(true);
  });

  it("does not delete the base when removing a maintenance sandbox", async () => {
    const { host, dataRoot, paths, identity } = await setup();
    const shell = await host.volumeShell({
      project: identity.project,
      profile: "default",
      volume: "cache",
      sizeBytes: SIZE,
      image: "alpine:3.20",
      path: "/cache",
    });
    expect(await pathExists(paths.basePath)).toBe(true);
    await host.stop(shell.identity);
    await host.remove(shell.identity);
    expect(await pathExists(paths.basePath)).toBe(true);
    expect(
      isManagedChildOverlayPath(paths.basePath, "demo", "cache", shell.identity.instance, dataRoot),
    ).toBe(false);
  });

  it("removeHostOverlayPath refuses to delete a base path", async () => {
    const { dataRoot, paths } = await setup();
    await removeHostOverlayPath({
      hostPath: paths.basePath,
      project: "demo",
      volume: "cache",
      instance: "main",
      dataRoot,
    });
    expect(await pathExists(paths.basePath)).toBe(true);
  });

  it("keeps overlays when uncertain create actually published the sandbox", async () => {
    const { host, runtime, dataRoot, identity } = await setup();
    runtime.createFailMode = "uncertain-success";
    const childPath = childOverlayPath("demo", "cache", "main", dataRoot);

    const inspection = await host.create({
      identity,
      image: "alpine:3.20",
      volumes: [{ volume: "cache", path: "/cache", sizeBytes: SIZE }],
    });
    expect(inspection.identity.instance).toBe("main");
    expect(await pathExists(childPath)).toBe(true);
  });

  it("rolls back overlays when uncertain create leaves no sandbox", async () => {
    const { host, runtime, dataRoot, identity } = await setup();
    runtime.createFailMode = "uncertain-absent";
    const childPath = childOverlayPath("demo", "cache", "main", dataRoot);

    await expect(
      host.create({
        identity,
        image: "alpine:3.20",
        volumes: [{ volume: "cache", path: "/cache", sizeBytes: SIZE }],
      }),
    ).rejects.toMatchObject({ code: "internal" });
    expect(await pathExists(childPath)).toBe(false);
  });

  it("refuses ordinary create while maintenance is running", async () => {
    const { host, identity } = await setup();
    await host.volumeShell({
      project: identity.project,
      profile: "default",
      volume: "cache",
      sizeBytes: SIZE,
      image: "alpine:3.20",
      path: "/cache",
    });

    await expect(
      host.create({
        identity,
        image: "alpine:3.20",
        volumes: [{ volume: "cache", path: "/cache", sizeBytes: SIZE }],
      }),
    ).rejects.toMatchObject({ code: "busy" });
  });

  it("recovers terminal maintenance but not live sessions", async () => {
    const { runtime, identity, paths } = await setup();
    const maintIdentity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: maintenanceInstanceId("cache"),
    });
    const projected = projectCreateRequest({
      image: "alpine:3.20",
      volumes: [{ volume: "cache", path: "/cache" }],
    });
    const labels = {
      ...buildOwnershipLabels(maintIdentity, projected),
      ...buildVolumeMaintenanceLabels("cache"),
    };
    const nativeName = nativeSandboxName(maintIdentity.project, maintIdentity.instance);

    runtime.seed({
      name: nativeName,
      status: "running",
      labels,
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
      workdir: null,
      user: null,
      shell: null,
      hostname: null,
      maxDurationSecs: null,
      idleTimeoutSecs: null,
      env: {},
      mounts: [
        {
          guestPath: "/cache",
          hostPath: paths.basePath,
          format: "qcow2",
          fstype: "ext4",
        },
      ],
    });

    await expect(
      recoverCrashedMaintenance({
        runtime,
        project: identity.project,
        volume: "cache",
        expectedNativeName: nativeName,
      }),
    ).rejects.toMatchObject({ code: "busy" });

    // Terminal: recover succeeds.
    const stored = await runtime.get(nativeName);
    runtime.seed({ ...stored, status: "stopped" });
    await recoverCrashedMaintenance({
      runtime,
      project: identity.project,
      volume: "cache",
      expectedNativeName: nativeName,
    });
    await expect(runtime.get(nativeName)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses ensure child when backing path mismatches", async () => {
    const { host, qemu, dataRoot, identity, paths } = await setup();
    const childPath = childOverlayPath("demo", "cache", "main", dataRoot);
    await qemu.registerWrongBacking(childPath, join(dataRoot, "wrong-base.qcow2"));

    await expect(
      host.create({
        identity,
        image: "alpine:3.20",
        volumes: [{ volume: "cache", path: "/cache", sizeBytes: SIZE }],
      }),
    ).rejects.toMatchObject({ code: "ownership_conflict" });
    void paths;
  });

  it("refuses base ensure on size mismatch", async () => {
    const { host, qemu, paths, identity } = await setup();
    await qemu.registerSizeMismatch(paths.basePath, SIZE * 2);

    await expect(
      host.ensureVolume({
        project: identity.project,
        volume: "cache",
        sizeBytes: SIZE,
      }),
    ).rejects.toMatchObject({ code: "ownership_conflict" });
  });

  it("refuses volume shell while ordinary descendants exist", async () => {
    const { host, identity } = await setup();
    await host.create({
      identity,
      image: "alpine:3.20",
      volumes: [{ volume: "cache", path: "/cache", sizeBytes: SIZE }],
    });
    await host.stop(identity);

    await expect(
      host.volumeShell({
        project: identity.project,
        profile: "default",
        volume: "cache",
        sizeBytes: SIZE,
        image: "alpine:3.20",
        path: "/cache",
      }),
    ).rejects.toMatchObject({ code: "busy" });
  });

  it("capabilities does not probe qemu-img", async () => {
    const { host } = await setup();
    const caps = await host.capabilities();
    expect(caps.qemuImg).toBe(false);
    expect(caps.notes.some((n) => n.includes("qemu-img"))).toBe(true);
  });

  it("lifecycle ops proceed while the volume base lock is held", async () => {
    const { host, identity, paths } = await setup();
    await host.create({
      identity,
      image: "alpine:3.20",
      volumes: [{ volume: "cache", path: "/cache", sizeBytes: SIZE }],
    });

    const lock = await acquireVolumeLock(paths.lockSocketPath);
    try {
      const listed = await host.list();
      expect(listed.some((s) => s.identity.instance === "main")).toBe(true);
      await host.inspect(identity);
      await host.stop(identity);
      await host.start(identity);

      await expect(
        host.create({
          identity: assertSandboxIdentity({
            project: "demo",
            profile: "default",
            instance: "other",
          }),
          image: "alpine:3.20",
          volumes: [{ volume: "cache", path: "/cache", sizeBytes: SIZE }],
        }),
      ).rejects.toMatchObject({ code: "busy" });

      // Image listing may fail for unrelated native reasons; it must not be busy.
      try {
        await host.listImages();
      } catch (error) {
        expect(isSboxError(error) && error.code === "busy").toBe(false);
      }
    } finally {
      await lock.release();
    }
  });

  it("cleans staging and partial files when base format fails", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "sbox-vol-fmt-"));
    dirs.push(dataRoot);
    const paths = volumePaths("demo", "cache", dataRoot);
    const runtime = new MemoryNativeRuntime();
    const qemu = createFakeQemuImgPorts(SIZE);
    const failingQemu = {
      runCommand: async (request: Parameters<typeof qemu.ports.runCommand>[0]) => {
        if (request.args[0] === "convert") {
          throw SboxError.internal("Simulated convert failure.");
        }
        return qemu.ports.runCommand(request);
      },
    };

    await expect(
      formatAndPublishBase(
        {
          volumeRoot: paths.volumeRoot,
          basePath: paths.basePath,
          sizeBytes: SIZE,
        },
        {
          runtime,
          qemuImg: failingQemu,
          execInSandbox: async () => ({ exitCode: 0, stderr: "" }),
          ensureFormatterImage: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: "internal" });

    const entries = await readdir(paths.volumeRoot).catch(() => [] as string[]);
    expect(entries.filter((name) => name.includes("partial"))).toEqual([]);
    expect(entries.filter((name) => name.startsWith(".staging-"))).toEqual([]);
    expect(await pathExists(paths.basePath)).toBe(false);

    const createCall = runtime.calls.find((call) => call.op === "create");
    expect(createCall).toBeDefined();
  });

  it("formats via bind-mounted staging rather than raw virtio-blk", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "sbox-vol-bind-"));
    dirs.push(dataRoot);
    const paths = volumePaths("demo", "cache", dataRoot);
    const runtime = new MemoryNativeRuntime();
    const qemu = createFakeQemuImgPorts(SIZE);
    let seenBind: unknown;
    const originalCreate = runtime.create.bind(runtime);
    runtime.create = async (request) => {
      seenBind = request.bindMounts;
      expect(request.mounts ?? []).toEqual([]);
      return originalCreate(request);
    };

    await formatAndPublishBase(
      {
        volumeRoot: paths.volumeRoot,
        basePath: paths.basePath,
        sizeBytes: SIZE,
      },
      {
        runtime,
        qemuImg: qemu.ports,
        execInSandbox: async () => ({ exitCode: 0, stderr: "" }),
        ensureFormatterImage: async () => undefined,
      },
    );

    expect(seenBind).toEqual([
      expect.objectContaining({
        guestPath: "/sbox-format",
        quotaMiB: expect.any(Number),
      }),
    ]);
    expect(await pathExists(paths.basePath)).toBe(true);
  });

  it("ignores leftover partial bases when ensuring a missing base", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "sbox-vol-partial-"));
    dirs.push(dataRoot);
    const paths = volumePaths("demo", "cache", dataRoot);
    const runtime = new MemoryNativeRuntime();
    const qemu = createFakeQemuImgPorts(SIZE);
    await mkdir(paths.volumeRoot, { recursive: true });
    await writeFile(join(paths.volumeRoot, "base.qcow2.partial-orphaned"), "leftover");

    const ensured = await ensureVolumeBase(
      {
        project: "demo",
        volume: "cache",
        sizeBytes: SIZE,
        dataRoot,
      },
      {
        runtime,
        qemuImg: qemu.ports,
        execInSandbox: async () => ({ exitCode: 0, stderr: "" }),
        ensureFormatterImage: async () => undefined,
      },
    );
    expect(ensured.created).toBe(true);
    expect(await pathExists(paths.basePath)).toBe(true);
    expect(await pathExists(join(paths.volumeRoot, "base.qcow2.partial-orphaned"))).toBe(true);
  });
});

describe("decodeDiskMounts fixture", () => {
  it("decodes the captured DiskImage mount shape from microsandbox 0.6.6", async () => {
    const raw = await readFile(
      new URL("./fixtures/sandbox-config-disk-mount-0.6.6.json", import.meta.url),
      "utf8",
    );
    const fixture = JSON.parse(raw) as {
      fixtureNote?: string;
      mounts: Array<Record<string, unknown>>;
    };
    expect(fixture.fixtureNote).toMatch(/Captured via Sandbox\.builder/);
    expect(fixture.mounts[0]?.["type"]).toBe("DiskImage");
    expect(fixture.mounts[0]?.["format"]).toBe("Qcow2");

    const mounts = decodeDiskMounts({ mounts: fixture.mounts });
    expect(mounts).toEqual([
      {
        host: "/tmp/example-child.qcow2",
        guest: "/cache",
        format: "qcow2",
        fstype: "ext4",
        readonly: false,
      },
    ]);
  });

  it("defaults missing format to qcow2 without aborting decode", () => {
    const mounts = decodeDiskMounts({
      mounts: [
        {
          type: "DiskImage",
          host: "/tmp/x.qcow2",
          guest: "/data",
          fstype: "ext4",
        },
      ],
    });
    expect(mounts[0]?.format).toBe("qcow2");
  });
});
