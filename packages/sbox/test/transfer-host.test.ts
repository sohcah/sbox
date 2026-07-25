import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeHost } from "../src/fake-host.js";
import { defaultNetworkConfig, toSafeNetworkConfig } from "../src/network/types.js";
import {
  SECRET_DETAIL_CANARY_KEYS,
  SECRET_LOG_CANARY_KEYS,
  assertSandboxIdentity,
  collectingLogger,
  isSboxError,
  type SandboxIdentity,
} from "../src/index.js";

function identity(): SandboxIdentity {
  return assertSandboxIdentity({
    project: "demo",
    profile: "default",
    instance: "xfer",
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

describe("FakeHost transfer contract", () => {
  it("round-trips file bytes faithfully both ways", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const payload = new Uint8Array([0, 1, 2, 255, 10, 0x80]);
    const hostFile = join(root, "in.bin");
    await writeFile(hostFile, payload);

    await host.copyHostToGuest({
      identity: id,
      hostPath: hostFile,
      guestPath: "/data/in.bin",
    });
    const guest = host.filesystemFor(id).get("/data/in.bin");
    expect(guest?.kind).toBe("file");
    if (guest?.kind === "file") {
      expect(Buffer.from(guest.data)).toEqual(Buffer.from(payload));
    }

    const outFile = join(root, "out.bin");
    await host.copyGuestToHost({
      identity: id,
      guestPath: "/data/in.bin",
      hostPath: outFile,
    });
    expect(Buffer.from(await readFile(outFile))).toEqual(Buffer.from(payload));
    expect(host.operations).toEqual(expect.arrayContaining(["copyHostToGuest", "copyGuestToHost"]));
  });

  it("copies recursive directories and preserves the executable bit", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-dir-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const src = join(root, "src");
    await mkdir(join(src, "nested"), { recursive: true });
    const script = join(src, "nested", "run.sh");
    await writeFile(script, "#!/bin/sh\necho hi\n", "utf8");
    await chmod(script, 0o755);

    await host.copyHostToGuest({
      identity: id,
      hostPath: src,
      guestPath: "/app",
    });
    const node = host.filesystemFor(id).get("/app/nested/run.sh");
    expect(node?.kind).toBe("file");
    if (node?.kind === "file") {
      expect(node.mode & 0o111).toBeTruthy();
    }

    const dest = join(root, "dest");
    await host.copyGuestToHost({
      identity: id,
      guestPath: "/app",
      hostPath: dest,
    });
    const st = await lstat(join(dest, "nested", "run.sh"));
    expect(st.mode & 0o111).toBeTruthy();
  });

  it("preserves safe relative symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-link-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const src = join(root, "src");
    await mkdir(src);
    await writeFile(join(src, "target.txt"), "payload", "utf8");
    await symlink("target.txt", join(src, "link.txt"));

    await host.copyHostToGuest({
      identity: id,
      hostPath: src,
      guestPath: "/tree",
    });
    const link = host.filesystemFor(id).get("/tree/link.txt");
    expect(link).toEqual({ kind: "symlink", target: "target.txt" });

    const dest = join(root, "dest");
    await host.copyGuestToHost({
      identity: id,
      guestPath: "/tree",
      hostPath: dest,
    });
    expect(await readlink(join(dest, "link.txt"))).toBe("target.txt");
  });

  it("rejects traversal in guest paths", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-trav-"));
    await writeFile(join(root, "f.txt"), "x", "utf8");
    await expect(
      host.copyHostToGuest({
        identity: id,
        hostPath: join(root, "f.txt"),
        guestPath: "/ok/../etc/passwd",
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("rejects relative (non-absolute) guest paths", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-rel-"));
    await writeFile(join(root, "f.txt"), "x", "utf8");
    await expect(
      host.copyHostToGuest({
        identity: id,
        hostPath: join(root, "f.txt"),
        guestPath: "relative/path",
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("rejects escaping symlink targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-esc-"));
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

  it("rejects special files", async () => {
    const host = new FakeHost();
    const id = seedRunning(host);
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-sock-"));
    const sockPath = join(root, "s.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => resolve());
    });
    try {
      await expect(
        host.copyHostToGuest({
          identity: id,
          hostPath: sockPath,
          guestPath: "/s.sock",
        }),
      ).rejects.toMatchObject({ code: "validation" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("errors on conflict and replaces when overwrite=replace", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-ow-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const file = join(root, "a.txt");
    await writeFile(file, "one", "utf8");
    await host.copyHostToGuest({
      identity: id,
      hostPath: file,
      guestPath: "/a.txt",
    });
    await writeFile(file, "two", "utf8");
    await expect(
      host.copyHostToGuest({
        identity: id,
        hostPath: file,
        guestPath: "/a.txt",
      }),
    ).rejects.toMatchObject({ code: "already_exists" });

    await host.copyHostToGuest(
      { identity: id, hostPath: file, guestPath: "/a.txt" },
      { overwrite: "replace" },
    );
    const node = host.filesystemFor(id).get("/a.txt");
    expect(node?.kind).toBe("file");
    if (node?.kind === "file") {
      expect(Buffer.from(node.data).toString()).toBe("two");
    }
  });

  it("honours cancellation and does not publish partial host destinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-cancel-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const fs = host.filesystemFor(id);
    fs.set("/tree", { kind: "directory", mode: 0o755 });
    fs.set("/tree/a.txt", { kind: "file", mode: 0o644, data: new Uint8Array([1]) });
    fs.set("/tree/b.txt", { kind: "file", mode: 0o644, data: new Uint8Array([2]) });

    const controller = new AbortController();
    controller.abort();
    const dest = join(root, "dest");
    await expect(
      host.copyGuestToHost(
        { identity: id, guestPath: "/tree", hostPath: dest },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    await expect(lstat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps secret canaries out of transfer logs and safe errors", async () => {
    const { logger, events } = collectingLogger();
    const host = new FakeHost({ logger });
    const id = seedRunning(host);
    const canary = "transfer-secret-canary-value";

    await expect(
      host.copyHostToGuest({
        identity: id,
        hostPath: `/nonexistent/${canary}`,
        guestPath: "/x",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isSboxError(error)) {
        return false;
      }
      const safe = JSON.stringify(error.toSafeJSON());
      expect(safe).not.toContain(canary);
      for (const key of SECRET_DETAIL_CANARY_KEYS) {
        expect(safe).not.toContain(`value-for-${key}`);
      }
      return error.code === "not_found" || error.code === "validation";
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(canary);
    for (const key of SECRET_LOG_CANARY_KEYS) {
      expect(serialized).not.toContain(`value-for-${key}`);
    }
  });
});
