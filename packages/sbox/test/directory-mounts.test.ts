/**
 * Unit tests for Host mount config, LocalHost binds, remote stages,
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
import { mountsFromLabels } from "../src/directory/labels.js";
import { isSboxError } from "../src/errors.js";
import { decodeBindMounts } from "../src/directory/decode-binds.js";
import { assertHostMounts } from "../src/directory/validate.js";
import { expandHomePrefix } from "../src/directory/home-path.js";
import { directoryStageRootForIdentity } from "../src/directory/paths.js";
import { packClientMountArchive } from "../src/directory/stages.js";
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

describe("Host mount config", () => {
  it("parses defaults, allows RW host without quota, rejects client writable", () => {
    const ok = parseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          mounts: [
            { path: "./vendor", mount: "/vendor" },
            { path: "./config.json", mount: "/etc/app/config.json" },
            {
              path: "/var/cache/tools",
              source: "host",
              mount: "/tools",
              readonly: false,
              quota: "512MiB",
            },
            {
              path: "/var/log/app.log",
              source: "host",
              mount: "/var/log/app.log",
              readonly: false,
            },
          ],
        },
      },
    });
    const safe = toSafeProjectConfig(ok);
    expect(safe.profiles["default"]?.mounts).toEqual([
      { path: "./vendor", mount: "/vendor", source: "client", readonly: true },
      { path: "./config.json", mount: "/etc/app/config.json", source: "client", readonly: true },
      {
        path: "/var/cache/tools",
        mount: "/tools",
        source: "host",
        readonly: false,
        quota: "512MiB",
      },
      {
        path: "/var/log/app.log",
        mount: "/var/log/app.log",
        source: "host",
        readonly: false,
      },
    ]);

    const clientWritable = tryParseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          mounts: [{ path: "./x", mount: "/x", readonly: false }],
        },
      },
    });
    expect(clientWritable.ok).toBe(false);
    if (!clientWritable.ok) {
      expect(clientWritable.issues.some((issue) => /read-only/i.test(issue.message))).toBe(true);
    }
  });

  it("rejects legacy directories: YAML key", () => {
    const result = tryParseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          directories: [{ path: "./x", mount: "/x" }],
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) =>
            /unrecognized|unrecognized_keys|directories/i.test(issue.message) ||
            issue.path.includes("directories"),
        ),
      ).toBe(true);
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
          mounts: [{ path: "./x", mount: "/data" }],
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => /already used/i.test(issue.message))).toBe(true);
    }
  });
});

describe("HostCreateRequest mount invariants", () => {
  it("rejects client writable, relative host paths, quota on RO, and collisions", () => {
    expect(() =>
      assertHostMounts([{ source: "client", path: "/tmp/x", mount: "/x", readonly: false }]),
    ).toThrow(/read-only/i);

    expect(() =>
      assertHostMounts([{ source: "host", path: "relative", mount: "/x", readonly: true }]),
    ).toThrow(/absolute|home-relative/i);

    expect(() =>
      assertHostMounts([{ source: "host", path: "~/cache", mount: "/x", readonly: true }]),
    ).not.toThrow();

    expect(() =>
      assertHostMounts([
        { source: "host", path: "/tmp/x", mount: "/x", readonly: true, quotaMiB: 64 },
      ]),
    ).toThrow(/quota/i);

    expect(() =>
      assertHostMounts([{ source: "host", path: "/tmp/x", mount: "/x", readonly: false }]),
    ).not.toThrow();

    expect(() =>
      assertHostMounts(
        [{ source: "client", path: "/tmp/x", mount: "/data", readonly: true }],
        [{ path: "/data" }],
      ),
    ).toThrow(/already used/i);

    expect(() =>
      assertHostMounts([{ source: "client", path: "/tmp/x", mount: "relative", readonly: true }]),
    ).toThrow(/absolute/i);
  });

  it("LocalHost rejects invalid HostCreateRequest mounts", async () => {
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
        mounts: [{ source: "client", path: "/tmp/x", mount: "/x", readonly: false }],
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

describe("Host mounts on LocalHost", () => {
  it("binds resolved client/host files and directories and labels them for inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-dir-"));
    dirs.push(root);
    const vendor = join(root, "vendor");
    const configFile = join(root, "config.json");
    const hostTools = join(root, "tools");
    const hostLog = join(root, "app.log");
    await mkdir(vendor);
    await mkdir(hostTools);
    await writeFile(join(vendor, "a.txt"), "a", "utf8");
    await writeFile(configFile, '{"ok":true}', "utf8");
    await writeFile(hostLog, "log", "utf8");

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
          mounts: [
            { path: "./vendor", mount: "/vendor" },
            { path: "./config.json", mount: "/etc/app/config.json" },
            {
              path: hostTools,
              source: "host",
              mount: "/tools",
              readonly: false,
              quota: "64MiB",
            },
            {
              path: hostLog,
              source: "host",
              mount: "/var/log/app.log",
              readonly: false,
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
      { guestPath: "/etc/app/config.json", hostPath: configFile, readonly: true },
      { guestPath: "/tools", hostPath: hostTools, readonly: false, quotaMiB: 64 },
      { guestPath: "/var/log/app.log", hostPath: hostLog, readonly: false },
    ]);
    // Fingerprint / inspection order is by guest mount path.
    expect(inspection.creation.mounts).toEqual([
      {
        source: "client",
        path: configFile,
        mount: "/etc/app/config.json",
        readonly: true,
        kind: "file",
      },
      {
        source: "host",
        path: hostTools,
        mount: "/tools",
        readonly: false,
        kind: "directory",
        quotaMiB: 64,
      },
      {
        source: "host",
        path: hostLog,
        mount: "/var/log/app.log",
        readonly: false,
        kind: "file",
      },
      { source: "client", path: vendor, mount: "/vendor", readonly: true, kind: "directory" },
    ]);
    expect(mountsFromLabels(inspection.labels)).toEqual(inspection.creation.mounts);
    expect(inspection.labels[OWNERSHIP_LABEL_KEYS.mounts]).toBeDefined();
    const stored = await runtime.get(inspection.nativeName);
    expect(stored.bindMounts).toEqual(seenBinds);
    await host[Symbol.asyncDispose]();
  });

  it("rejects symlink directory and file roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-dir-sym-"));
    dirs.push(root);
    const real = join(root, "real");
    const link = join(root, "link");
    const realFile = join(root, "real.txt");
    const linkFile = join(root, "link.txt");
    await mkdir(real);
    await symlink(real, link);
    await writeFile(realFile, "x", "utf8");
    await symlink(realFile, linkFile);

    const host = createLocalHostInternal({ runtime: new MemoryNativeRuntime() });
    const projectDir = parseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          mounts: [{ path: "./link", mount: "/x" }],
        },
      },
    });
    await expect(
      resolveCreateIntent({
        project: projectDir,
        external: { configDirectory: root, env: {} },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isSboxError(error) || error.code !== "validation") {
        return false;
      }
      const issues = error.details?.["issues"];
      if (!Array.isArray(issues)) {
        return /symlink/i.test(error.message);
      }
      return issues.some(
        (issue) =>
          issue !== null &&
          typeof issue === "object" &&
          "message" in issue &&
          typeof issue.message === "string" &&
          /symlink/i.test(issue.message),
      );
    });

    // Host create also rejects symlink roots when given a raw request.
    await expect(
      host.create({
        identity: assertSandboxIdentity({
          project: "demo",
          profile: "default",
          instance: "sym-file",
        }),
        image: "alpine:3.20",
        mounts: [{ source: "client", path: linkFile, mount: "/x.txt", readonly: true }],
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/symlink/i),
    });
    await host[Symbol.asyncDispose]();
  });

  it("treats kind flip as creation drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-kind-flip-"));
    dirs.push(root);
    const path = join(root, "shared");
    await mkdir(path);

    const runtime = new MemoryNativeRuntime();
    const host = createLocalHostInternal({ runtime });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "kind-flip",
    });

    await host.create({
      identity,
      image: "alpine:3.20",
      mounts: [{ source: "client", path, mount: "/shared", readonly: true, kind: "directory" }],
    });

    await rm(path, { recursive: true, force: true });
    await writeFile(path, "now-a-file", "utf8");

    await expect(
      host.create({
        identity,
        image: "alpine:3.20",
        mounts: [{ source: "client", path, mount: "/shared", readonly: true, kind: "file" }],
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isSboxError(error) &&
        (error.code === "already_exists" ||
          error.code === "ownership_conflict" ||
          /ownership|configuration|creation|immutable|conflict/i.test(error.message)),
    );
    await host.remove(identity);
    await host[Symbol.asyncDispose]();
  });

  it("expands ~/ client and host mount paths", async () => {
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
          mounts: [
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
    expect(intent.request.mounts).toEqual([
      { source: "client", path: vendor, mount: "/vendor", readonly: true, kind: "directory" },
      {
        source: "host",
        path: homeRelativeTools,
        mount: "/tools",
        readonly: false,
        kind: "directory",
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

describe("Host mounts over RemoteHost", () => {
  const TOKEN = "test-token-mounts-0123456789ab";

  it("stages client mounts then cleans them on remove", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-dir-remote-"));
    dirs.push(root);
    const vendor = join(root, "vendor");
    const configFile = join(root, "config.json");
    await mkdir(vendor);
    await writeFile(join(vendor, "a.txt"), "a", "utf8");
    await writeFile(configFile, '{"ok":true}', "utf8");

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
      mounts: [
        { source: "client", path: vendor, mount: "/vendor", readonly: true },
        { source: "client", path: configFile, mount: "/etc/app/config.json", readonly: true },
      ],
    });
    expect(inspection.creation.mounts).toEqual([
      {
        source: "client",
        path: configFile,
        mount: "/etc/app/config.json",
        readonly: true,
        kind: "file",
      },
      { source: "client", path: vendor, mount: "/vendor", readonly: true, kind: "directory" },
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
      mounts: [{ source: "client", path: vendor, mount: "/vendor", readonly: true }],
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
        mounts: [{ source: "client", path: vendor, mount: "/vendor", readonly: true }],
      }),
    ).rejects.toSatisfy((error: unknown) => isSboxError(error) && error.code === "already_exists");

    const after = await readdir(stageRoot);
    expect(after).toEqual(before);
    expect(await readFile(stagedFile, "utf8")).toBe("keep-me");

    await remote.remove(identity);
  });

  it("rejects followEscapingSymlinks on Host-sourced mounts", () => {
    expect(() =>
      assertHostMounts([
        {
          source: "host",
          path: "/var/data",
          mount: "/data",
          readonly: true,
          followEscapingSymlinks: true,
        },
      ]),
    ).toThrow(/followEscapingSymlinks/i);
  });

  it("rejects symlink client roots before packing", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-dir-remote-sym-"));
    dirs.push(root);
    const real = join(root, "real");
    const link = join(root, "link");
    await mkdir(real);
    await symlink(real, link);

    await expect(
      packClientMountArchive([{ source: "client", path: link, mount: "/x", readonly: true }]),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/symlink/i),
    });
  });

  it.skipIf(process.platform === "win32")(
    "followEscapingSymlinks dereferences escaping links when packing Client mounts",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "sbox-follow-esc-"));
      dirs.push(root);
      const outside = join(root, "outside");
      const tree = join(root, "tree");
      await mkdir(outside);
      await mkdir(tree);
      await writeFile(join(outside, "secret.txt"), "followed", "utf8");
      await symlink(join("..", "outside"), join(tree, "link"));
      await symlink("secret.txt", join(outside, "inner"));

      await expect(
        packClientMountArchive([
          { source: "client", path: tree, mount: "/skills", readonly: true, kind: "directory" },
        ]),
      ).rejects.toMatchObject({
        code: "validation",
        message: expect.stringMatching(/escapes the transfer root/i),
      });

      const packed = await packClientMountArchive([
        {
          source: "client",
          path: tree,
          mount: "/skills",
          readonly: true,
          kind: "directory",
          followEscapingSymlinks: true,
        },
      ]);
      const byPath = Object.fromEntries(packed.archive.entries.map((e) => [e.path, e]));
      expect(byPath["0/link"]?.kind).toBe("directory");
      expect(byPath["0/link/secret.txt"]).toMatchObject({
        kind: "file",
        data: expect.any(Uint8Array),
      });
      expect(
        Buffer.from((byPath["0/link/secret.txt"] as { data: Uint8Array }).data).toString(),
      ).toBe("followed");
      // Relative link inside the followed tree stays a symlink when safe under that subtree…
      // …but relative to the mount archive root `inner` -> secret.txt is safe under 0/link/.
      expect(byPath["0/link/inner"]).toEqual({
        kind: "symlink",
        path: "0/link/inner",
        target: "secret.txt",
      });
    },
  );

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
        mounts: [
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
