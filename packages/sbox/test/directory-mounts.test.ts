/**
 * Unit tests for Host directory mount config, LocalHost binds, remote stages,
 * Host-boundary validation, and Bind mount decode.
 */

import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalHostInternal } from "../src/local-host-internal.js";
import {
  parseYamlProjectInput,
  toSafeProjectConfig,
  tryParseYamlProjectInput,
} from "../src/config/validate.js";
import { resolveCreateIntent } from "../src/client/resolve-intent.js";
import { MemoryNativeRuntime } from "./helpers/memory-native-runtime.js";
import { OWNERSHIP_LABEL_KEYS } from "../src/ownership.js";
import { directoriesFromLabels } from "../src/directory/labels.js";
import { isSboxError } from "../src/errors.js";
import { decodeBindMounts } from "../src/directory/decode-binds.js";
import { assertHostDirectoryMounts } from "../src/directory/validate.js";
import { expandHomePrefix } from "../src/directory/home-path.js";
import { directoryStageRootForIdentity } from "../src/directory/paths.js";
import { packClientDirectoryArchive } from "../src/directory/stages.js";
import { FakeHost } from "../src/fake-host.js";
import { createRemoteHost } from "../src/remote/remote-host.js";
import { createSboxServer } from "../src/remote/server.js";
import { assertSandboxIdentity } from "../src/identity.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("directory mount config", () => {
  it("parses defaults and rejects client writable / missing quota", () => {
    const ok = parseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          directories: [
            { path: "./vendor", mount: "/vendor" },
            {
              path: "/var/cache/tools",
              source: "host",
              mount: "/tools",
              readonly: false,
              quota: "512MiB",
            },
          ],
        },
      },
    });
    const safe = toSafeProjectConfig(ok);
    expect(safe.profiles["default"]?.directories).toEqual([
      { path: "./vendor", mount: "/vendor", source: "client", readonly: true },
      {
        path: "/var/cache/tools",
        mount: "/tools",
        source: "host",
        readonly: false,
        quota: "512MiB",
      },
    ]);

    const clientWritable = tryParseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          directories: [{ path: "./x", mount: "/x", readonly: false }],
        },
      },
    });
    expect(clientWritable.ok).toBe(false);
    if (!clientWritable.ok) {
      expect(clientWritable.issues.some((issue) => /read-only/i.test(issue.message))).toBe(true);
    }

    const missingQuota = tryParseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          directories: [{ path: "/abs", source: "host", mount: "/x", readonly: false }],
        },
      },
    });
    expect(missingQuota.ok).toBe(false);
    if (!missingQuota.ok) {
      expect(missingQuota.issues.some((issue) => /quota/i.test(issue.message))).toBe(true);
    }
  });

  it("rejects guest path collisions with volumes", () => {
    const result = tryParseYamlProjectInput({
      version: 1,
      project: "demo",
      volumes: { cache: { size: "1GiB" } },
      profiles: {
        default: {
          image: "alpine:3.20",
          volumes: [{ volume: "cache", path: "/data" }],
          directories: [{ path: "./x", mount: "/data" }],
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => /already used/i.test(issue.message))).toBe(true);
    }
  });
});

describe("HostCreateRequest directory invariants", () => {
  it("rejects client writable, relative host paths, quota on RO, and collisions", () => {
    expect(() =>
      assertHostDirectoryMounts([
        { source: "client", path: "/tmp/x", mount: "/x", readonly: false },
      ]),
    ).toThrow(/read-only/i);

    expect(() =>
      assertHostDirectoryMounts([
        { source: "host", path: "relative", mount: "/x", readonly: true },
      ]),
    ).toThrow(/absolute|home-relative/i);

    expect(() =>
      assertHostDirectoryMounts([{ source: "host", path: "~/cache", mount: "/x", readonly: true }]),
    ).not.toThrow();

    expect(() =>
      assertHostDirectoryMounts([
        { source: "host", path: "/tmp/x", mount: "/x", readonly: true, quotaMiB: 64 },
      ]),
    ).toThrow(/quota/i);

    expect(() =>
      assertHostDirectoryMounts(
        [{ source: "client", path: "/tmp/x", mount: "/data", readonly: true }],
        [{ path: "/data" }],
      ),
    ).toThrow(/already used/i);

    expect(() =>
      assertHostDirectoryMounts([
        { source: "client", path: "/tmp/x", mount: "relative", readonly: true },
      ]),
    ).toThrow(/absolute/i);
  });

  it("LocalHost rejects invalid HostCreateRequest directories", async () => {
    const host = createLocalHostInternal({ runtime: new MemoryNativeRuntime() });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "main",
    });
    await expect(
      host.create({
        identity,
        image: "alpine:3.20",
        directories: [{ source: "client", path: "/tmp/x", mount: "/x", readonly: false }],
      }),
    ).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/read-only/i) });
    await host[Symbol.asyncDispose]();
  });
});

describe("decodeBindMounts", () => {
  it("decodes the captured Bind mount shape from microsandbox 0.6.6", async () => {
    const raw = await readFile(
      new URL("./fixtures/sandbox-config-bind-mount-0.6.6.json", import.meta.url),
      "utf8",
    );
    const fixture = JSON.parse(raw) as {
      fixtureNote?: string;
      mounts: Array<Record<string, unknown>>;
    };
    expect(fixture.fixtureNote).toMatch(/Captured via Sandbox\.builder/);
    expect(fixture.mounts[0]?.["type"]).toBe("Bind");

    const binds = decodeBindMounts({ mounts: fixture.mounts });
    expect(binds).toEqual([
      {
        hostPath: "/tmp/example-vendor",
        guestPath: "/vendor",
        readonly: true,
      },
      {
        hostPath: "/tmp/example-tools",
        guestPath: "/tools",
        readonly: false,
        quotaMiB: 64,
      },
    ]);
  });
});

describe("directory mounts on LocalHost", () => {
  it("binds resolved client and host directories and labels them for inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-dir-"));
    dirs.push(root);
    const vendor = join(root, "vendor");
    const hostTools = join(root, "tools");
    await mkdir(vendor);
    await mkdir(hostTools);
    await writeFile(join(vendor, "a.txt"), "a", "utf8");

    const runtime = new MemoryNativeRuntime();
    let seenBinds: unknown;
    const original = runtime.create.bind(runtime);
    runtime.create = async (request) => {
      seenBinds = request.bindMounts;
      return original(request);
    };

    const host = createLocalHostInternal({ runtime });
    const project = parseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          directories: [
            { path: "./vendor", mount: "/vendor" },
            {
              path: hostTools,
              source: "host",
              mount: "/tools",
              readonly: false,
              quota: "64MiB",
            },
          ],
        },
      },
    });
    const intent = await resolveCreateIntent({
      project,
      external: { configDirectory: root, env: {} },
    });
    const inspection = await host.create(intent.request);
    expect(seenBinds).toEqual([
      { guestPath: "/vendor", hostPath: vendor, readonly: true },
      { guestPath: "/tools", hostPath: hostTools, readonly: false, quotaMiB: 64 },
    ]);
    // Fingerprint / inspection order is by guest mount path.
    expect(inspection.creation.directories).toEqual([
      { source: "host", path: hostTools, mount: "/tools", readonly: false, quotaMiB: 64 },
      { source: "client", path: vendor, mount: "/vendor", readonly: true },
    ]);
    expect(directoriesFromLabels(inspection.labels)).toEqual(inspection.creation.directories);
    expect(inspection.labels[OWNERSHIP_LABEL_KEYS.directories]).toBeDefined();
    const stored = await runtime.get(inspection.nativeName);
    expect(stored.bindMounts).toEqual(seenBinds);
    await host[Symbol.asyncDispose]();
  });

  it("rejects symlink directory roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-dir-sym-"));
    dirs.push(root);
    const real = join(root, "real");
    const link = join(root, "link");
    await mkdir(real);
    await symlink(real, link);

    const host = createLocalHostInternal({ runtime: new MemoryNativeRuntime() });
    const project = parseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          directories: [{ path: "./link", mount: "/x" }],
        },
      },
    });
    const intent = await resolveCreateIntent({
      project,
      external: { configDirectory: root, env: {} },
    });
    await expect(host.create(intent.request)).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/symlink/i),
    });
    await host[Symbol.asyncDispose]();
  });

  it("expands ~/ client and host directory paths", async () => {
    expect(expandHomePrefix("~/cache", "/home/me")).toBe(join("/home/me", "cache"));
    expect(expandHomePrefix("~", "/home/me")).toBe("/home/me");
    expect(expandHomePrefix("~user/x", "/home/me")).toBe("~user/x");

    const home = homedir();
    const underHome = await mkdtemp(join(home, "sbox-dir-home-"));
    dirs.push(underHome);
    const vendor = join(underHome, "vendor");
    const tools = join(underHome, "tools");
    await mkdir(vendor);
    await mkdir(tools);
    const homeRelativeVendor = `~/${relative(home, vendor).replaceAll("\\", "/")}`;
    const homeRelativeTools = `~/${relative(home, tools).replaceAll("\\", "/")}`;

    const ok = parseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          directories: [
            { path: homeRelativeVendor, mount: "/vendor" },
            {
              path: homeRelativeTools,
              source: "host",
              mount: "/tools",
              readonly: false,
              quota: "64MiB",
            },
          ],
        },
      },
    });
    const intent = await resolveCreateIntent({
      project: ok,
      external: { configDirectory: underHome, env: {} },
    });
    expect(intent.request.directories).toEqual([
      { source: "client", path: vendor, mount: "/vendor", readonly: true },
      {
        source: "host",
        path: homeRelativeTools,
        mount: "/tools",
        readonly: false,
        quotaMiB: 64,
      },
    ]);

    const runtime = new MemoryNativeRuntime();
    let seenBinds: unknown;
    const original = runtime.create.bind(runtime);
    runtime.create = async (request) => {
      seenBinds = request.bindMounts;
      return original(request);
    };
    const host = createLocalHostInternal({ runtime });
    await host.create(intent.request);
    expect(seenBinds).toEqual([
      { guestPath: "/vendor", hostPath: vendor, readonly: true },
      { guestPath: "/tools", hostPath: tools, readonly: false, quotaMiB: 64 },
    ]);
    await host[Symbol.asyncDispose]();
  });
});

describe("directory mounts over RemoteHost", () => {
  const TOKEN = "test-token-directories-0123456789ab";

  it("stages client directories then cleans them on remove", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-dir-remote-"));
    dirs.push(root);
    const vendor = join(root, "vendor");
    await mkdir(vendor);
    await writeFile(join(vendor, "a.txt"), "a", "utf8");

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
      instance: "main",
    });
    const inspection = await remote.create({
      identity,
      image: "alpine:3.20",
      directories: [{ source: "client", path: vendor, mount: "/vendor", readonly: true }],
    });
    expect(inspection.creation.directories).toEqual([
      { source: "client", path: vendor, mount: "/vendor", readonly: true },
    ]);

    const stageRoot = directoryStageRootForIdentity(identity);
    await access(stageRoot);
    const generations = await readdir(stageRoot);
    expect(generations.length).toBe(1);

    await remote.remove(identity);
    await expect(access(stageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not erase an existing generation when a duplicate create fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-dir-dup-"));
    dirs.push(root);
    const vendor = join(root, "vendor");
    await mkdir(vendor);
    await writeFile(join(vendor, "a.txt"), "keep-me", "utf8");

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
      instance: "dup",
    });
    await remote.create({
      identity,
      image: "alpine:3.20",
      directories: [{ source: "client", path: vendor, mount: "/vendor", readonly: true }],
    });
    const stageRoot = directoryStageRootForIdentity(identity);
    const before = await readdir(stageRoot);
    expect(before.length).toBe(1);
    const generationPath = join(stageRoot, before[0]!);
    const stagedFile = join(generationPath, "0", "a.txt");
    expect(await readFile(stagedFile, "utf8")).toBe("keep-me");

    await expect(
      remote.create({
        identity,
        image: "alpine:3.20",
        directories: [{ source: "client", path: vendor, mount: "/vendor", readonly: true }],
      }),
    ).rejects.toSatisfy((error: unknown) => isSboxError(error) && error.code === "already_exists");

    const after = await readdir(stageRoot);
    expect(after).toEqual(before);
    expect(await readFile(stagedFile, "utf8")).toBe("keep-me");

    await remote.remove(identity);
  });

  it("rejects symlink client roots before packing", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-dir-remote-sym-"));
    dirs.push(root);
    const real = join(root, "real");
    const link = join(root, "link");
    await mkdir(real);
    await symlink(real, link);

    await expect(
      packClientDirectoryArchive([{ source: "client", path: link, mount: "/x", readonly: true }]),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/symlink/i),
    });
  });

  it("rejects client-supplied bindHostPath combinations that violate invariants", async () => {
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
      instance: "bad",
    });
    await expect(
      remote.create({
        identity,
        image: "alpine:3.20",
        directories: [
          {
            source: "client",
            path: "/tmp/x",
            mount: "/x",
            readonly: false,
            bindHostPath: "/evil",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/read-only/i) });
  });
});
