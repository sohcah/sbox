import { chmod, lstat, mkdir, mkdtemp, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeHost } from "../src/fake-host.js";
import { assertSandboxIdentity, type SandboxIdentity } from "../src/index.js";
import { assertStandaloneSymlinkTarget, isSafeSymlinkTarget } from "../src/transfer/paths.js";
import { defaultNetworkConfig, toSafeNetworkConfig } from "../src/network/types.js";

function identity(): SandboxIdentity {
  return assertSandboxIdentity({
    project: "demo",
    profile: "default",
    instance: "symlink-mode",
  });
}

function seedRunning(host: FakeHost): SandboxIdentity {
  const id = identity();
  host.seed({
    identity: id,
    state: "running",
    creation: {
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
      network: toSafeNetworkConfig(defaultNetworkConfig()),
      secrets: [],
      volumes: [],
    },
  });
  return id;
}

describe("standalone symlink transfer semantics", () => {
  it("allows relative sibling targets under the link parent", () => {
    expect(() => assertStandaloneSymlinkTarget("sibling", "/app/link", "guestPath")).not.toThrow();
    expect(isSafeSymlinkTarget("sibling", "/app", "/app")).toBe(true);
  });

  it("rejects nested ../ targets", () => {
    expect(() => assertStandaloneSymlinkTarget("../outside", "/app/link", "guestPath")).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
  });

  it("rejects absolute symlink targets including root destinations", () => {
    expect(() => assertStandaloneSymlinkTarget("/etc/passwd", "/link", "guestPath")).toThrow(
      expect.objectContaining({
        code: "validation",
        message: expect.stringMatching(/Absolute symlink targets/i),
      }),
    );
    expect(() => assertStandaloneSymlinkTarget("/app/target", "/app/link", "guestPath")).toThrow(
      expect.objectContaining({
        code: "validation",
        message: expect.stringMatching(/Absolute symlink targets/i),
      }),
    );
    expect(isSafeSymlinkTarget("/app/target", "/app", "/app")).toBe(false);
    expect(isSafeSymlinkTarget("/etc/passwd", "/", "/")).toBe(false);
  });

  it("rejects host-to-guest absolute symlink targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-abs-h2g-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const src = join(root, "src");
    await mkdir(src);
    await writeFile(join(src, "target"), "x", "utf8");
    // Absolute target inside the same tree — still not portable.
    await symlink(join(src, "target"), join(src, "link"));
    await expect(
      host.copyHostToGuest({
        identity: id,
        hostPath: join(src, "link"),
        guestPath: "/tree/link",
      }),
    ).rejects.toMatchObject({ code: "validation" });

    await expect(
      host.copyHostToGuest({
        identity: id,
        hostPath: src,
        guestPath: "/tree",
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("rejects guest-to-host absolute symlink targets that would cross namespaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-abs-g2h-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const fs = host.filesystemFor(id);
    fs.set("/tree", { kind: "directory", mode: 0o755 });
    fs.set("/tree/target", { kind: "file", mode: 0o644, data: new Uint8Array([1]) });
    fs.set("/tree/link", { kind: "symlink", target: "/tree/target" });
    await expect(
      host.copyGuestToHost({
        identity: id,
        guestPath: "/tree",
        hostPath: join(root, "out"),
      }),
    ).rejects.toMatchObject({ code: "validation" });

    fs.set("/link", { kind: "symlink", target: "/etc/passwd" });
    await expect(
      host.copyGuestToHost({
        identity: id,
        guestPath: "/link",
        hostPath: join(root, "passwd-link"),
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("rejects host-to-guest standalone escaping relative links", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-link-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const link = join(root, "escape");
    await symlink("../../outside", link);
    await expect(
      host.copyHostToGuest({
        identity: id,
        hostPath: link,
        guestPath: "/app/escape",
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("publishes relative links that resolve inside the destination tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-sib-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const link = join(root, "link");
    await symlink("sibling", link);
    await host.copyHostToGuest({
      identity: id,
      hostPath: link,
      guestPath: "/app/link",
    });
    expect(host.filesystemFor(id).get("/app/link")).toEqual({
      kind: "symlink",
      target: "sibling",
    });
  });

  it("rejects guest-to-host standalone escaping relative targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-g2h-link-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const fs = host.filesystemFor(id);
    fs.set("/app", { kind: "directory", mode: 0o755 });
    fs.set("/app/link", { kind: "symlink", target: "../escape" });
    await expect(
      host.copyGuestToHost({
        identity: id,
        guestPath: "/app/link",
        hostPath: join(root, "out"),
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("preserves valid relative links inside a transferred directory tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-tree-link-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const src = join(root, "src");
    await mkdir(src);
    await writeFile(join(src, "target.txt"), "ok", "utf8");
    await symlink("target.txt", join(src, "link.txt"));
    await host.copyHostToGuest({ identity: id, hostPath: src, guestPath: "/tree" });
    expect(host.filesystemFor(id).get("/tree/link.txt")).toEqual({
      kind: "symlink",
      target: "target.txt",
    });

    const dest = join(root, "dest");
    await host.copyGuestToHost({ identity: id, guestPath: "/tree", hostPath: dest });
    expect(await readlink(join(dest, "link.txt"))).toBe("target.txt");
  });
});

describe("directory permission bit preservation", () => {
  it.skipIf(process.platform === "win32")(
    "round-trips directory modes including 0700 and 0750",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "sbox-dir-mode-"));
      const host = new FakeHost();
      const id = seedRunning(host);
      const src = join(root, "src");
      const nested = join(src, "nested");
      await mkdir(nested, { recursive: true });
      await chmod(src, 0o700);
      await chmod(nested, 0o750);
      await writeFile(join(nested, "f.txt"), "x", "utf8");

      await host.copyHostToGuest({ identity: id, hostPath: src, guestPath: "/app" });
      const fs = host.filesystemFor(id);
      expect(fs.get("/app")).toEqual({ kind: "directory", mode: 0o700 });
      expect(fs.get("/app/nested")).toEqual({ kind: "directory", mode: 0o750 });

      const dest = join(root, "dest");
      await host.copyGuestToHost({ identity: id, guestPath: "/app", hostPath: dest });
      expect((await lstat(dest)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(dest, "nested"))).mode & 0o777).toBe(0o750);
    },
  );

  it.skipIf(process.platform === "win32")(
    "materializes children before applying restrictive final directory modes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "sbox-dir-restrict-"));
      const host = new FakeHost();
      const id = seedRunning(host);
      const src = join(root, "src");
      const nested = join(src, "nested");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "f.txt"), "payload", "utf8");
      // Restrictive final modes that would block child creation if applied early.
      // 0555/0500 remain listable/traversable by the owner for the host read path.
      await chmod(nested, 0o555);
      await chmod(src, 0o500);

      await host.copyHostToGuest({ identity: id, hostPath: src, guestPath: "/locked" });
      const fs = host.filesystemFor(id);
      expect(fs.get("/locked")).toEqual({ kind: "directory", mode: 0o500 });
      expect(fs.get("/locked/nested")).toEqual({ kind: "directory", mode: 0o555 });
      expect(fs.get("/locked/nested/f.txt")?.kind).toBe("file");

      const dest = join(root, "dest");
      await host.copyGuestToHost({ identity: id, guestPath: "/locked", hostPath: dest });
      try {
        expect((await lstat(dest)).mode & 0o777).toBe(0o500);
        expect((await lstat(join(dest, "nested"))).mode & 0o777).toBe(0o555);
        const { readFile } = await import("node:fs/promises");
        // Restore write/traverse briefly so the assertion can read the file.
        await chmod(dest, 0o755);
        await chmod(join(dest, "nested"), 0o755);
        expect(await readFile(join(dest, "nested", "f.txt"), "utf8")).toBe("payload");
      } finally {
        await chmod(join(dest, "nested"), 0o755).catch(() => undefined);
        await chmod(dest, 0o755).catch(() => undefined);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "applies 0000 directory mode only after children are staged",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "sbox-dir-zero-"));
      const host = new FakeHost();
      const id = seedRunning(host);
      // Seed an already-populated guest tree with a final 0000 directory mode.
      // (Reading a host 0000 directory would fail before transfer starts.)
      const fs = host.filesystemFor(id);
      fs.set("/zero", { kind: "directory", mode: 0o000 });
      fs.set("/zero/f.txt", {
        kind: "file",
        mode: 0o644,
        data: new TextEncoder().encode("z"),
      });

      const dest = join(root, "dest");
      await host.copyGuestToHost({ identity: id, guestPath: "/zero", hostPath: dest });
      try {
        expect((await lstat(dest)).mode & 0o777).toBe(0o000);
        await chmod(dest, 0o755);
        const { readFile } = await import("node:fs/promises");
        expect(await readFile(join(dest, "f.txt"), "utf8")).toBe("z");
      } finally {
        await chmod(dest, 0o755).catch(() => undefined);
      }
    },
  );
});
