/**
 * Transfer atomic publication and replace-not-merge contract tests.
 */

import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeHost } from "../src/fake-host.js";
import { failNextTransferRootMode } from "../src/fake-process.js";
import { assertSandboxIdentity, type SandboxIdentity } from "../src/index.js";
import { publishHostPath, stagingNameBeside } from "../src/transfer/publish-host.js";
import { defaultNetworkConfig, toSafeNetworkConfig } from "../src/network/types.js";

function identity(): SandboxIdentity {
  return assertSandboxIdentity({
    project: "demo",
    profile: "default",
    instance: "xfer-atomic",
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
    },
  });
  return id;
}

function abortAfterChecks(count: number): AbortSignal {
  const controller = new AbortController();
  let seen = 0;
  return new Proxy(controller.signal, {
    get(target, prop, receiver) {
      if (prop === "aborted") {
        seen += 1;
        if (seen >= count) {
          controller.abort();
        }
        return Reflect.get(target, prop, receiver);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as AbortSignal;
}

describe("transfer atomic publication", () => {
  it("leaves an absent host destination absent when cancelled mid-tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-partial-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const fs = host.filesystemFor(id);
    fs.set("/tree", { kind: "directory", mode: 0o755 });
    fs.set("/tree/a.txt", { kind: "file", mode: 0o644, data: new Uint8Array([1]) });
    fs.set("/tree/b.txt", { kind: "file", mode: 0o644, data: new Uint8Array([2]) });

    const dest = join(root, "dest");
    await expect(
      host.copyGuestToHost(
        { identity: id, guestPath: "/tree", hostPath: dest },
        { signal: abortAfterChecks(2) },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    await expect(readFile(dest).catch((error: NodeJS.ErrnoException) => error.code)).resolves.toBe(
      "ENOENT",
    );
  });

  it("preserves an existing host directory byte-for-byte when replace fails mid-stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-preserve-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const fs = host.filesystemFor(id);
    fs.set("/tree", { kind: "directory", mode: 0o755 });
    fs.set("/tree/a.txt", { kind: "file", mode: 0o644, data: new Uint8Array([9]) });
    fs.set("/tree/b.txt", { kind: "file", mode: 0o644, data: new Uint8Array([8]) });

    const dest = join(root, "dest");
    await mkdir(dest);
    await writeFile(join(dest, "keep.txt"), "original-bytes", "utf8");

    await expect(
      host.copyGuestToHost(
        { identity: id, guestPath: "/tree", hostPath: dest },
        { overwrite: "replace", signal: abortAfterChecks(2) },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(await readFile(join(dest, "keep.txt"), "utf8")).toBe("original-bytes");
  });

  it("replaces a guest directory instead of merging leftover children", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-replace-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const fs = host.filesystemFor(id);

    const first = join(root, "first");
    await mkdir(first);
    await writeFile(join(first, "old.txt"), "old", "utf8");
    await writeFile(join(first, "keep-name.txt"), "v1", "utf8");
    await host.copyHostToGuest({ identity: id, hostPath: first, guestPath: "/app" });
    expect(fs.get("/app/old.txt")?.kind).toBe("file");

    const second = join(root, "second");
    await mkdir(second);
    await writeFile(join(second, "keep-name.txt"), "v2", "utf8");
    await writeFile(join(second, "new.txt"), "new", "utf8");
    await host.copyHostToGuest(
      { identity: id, hostPath: second, guestPath: "/app" },
      { overwrite: "replace" },
    );

    expect(fs.get("/app/old.txt")).toBeUndefined();
    const keep = fs.get("/app/keep-name.txt");
    expect(keep?.kind).toBe("file");
    if (keep?.kind === "file") {
      expect(Buffer.from(keep.data).toString()).toBe("v2");
    }
    expect(fs.get("/app/new.txt")?.kind).toBe("file");
  });

  it("publishes host paths beside the destination and restores on rename failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-xfer-rename-"));
    const dest = join(root, "out.txt");
    await writeFile(dest, "live", "utf8");
    const staging = stagingNameBeside(dest, "file");
    await writeFile(staging, "staged", "utf8");

    let calls = 0;
    await expect(
      publishHostPath({
        stagingPath: staging,
        destPath: dest,
        destExists: true,
        remove: async () => undefined,
        rename: async (from, to) => {
          calls += 1;
          if (calls === 2) {
            const err = new Error("cross-device") as NodeJS.ErrnoException;
            err.code = "EXDEV";
            throw err;
          }
          await rename(from, to);
        },
      }),
    ).rejects.toMatchObject({ code: "internal" });

    expect(await readFile(dest, "utf8")).toBe("live");
  });

  it("leaves an absent guest destination absent when root mode fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-root-mode-h2g-abs-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const src = join(root, "src");
    await mkdir(src);
    await writeFile(join(src, "a.txt"), "new", "utf8");

    failNextTransferRootMode();
    await expect(
      host.copyHostToGuest({ identity: id, hostPath: src, guestPath: "/fresh" }),
    ).rejects.toMatchObject({ code: "native_state" });

    expect(host.filesystemFor(id).get("/fresh")).toBeUndefined();
  });

  it("preserves an existing guest destination when root mode fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-root-mode-h2g-exist-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const fs = host.filesystemFor(id);
    fs.set("/app", { kind: "directory", mode: 0o755 });
    fs.set("/app/keep.txt", {
      kind: "file",
      mode: 0o644,
      data: new TextEncoder().encode("original-bytes"),
    });

    const src = join(root, "src");
    await mkdir(src);
    await writeFile(join(src, "a.txt"), "replacement", "utf8");

    failNextTransferRootMode();
    await expect(
      host.copyHostToGuest(
        { identity: id, hostPath: src, guestPath: "/app" },
        { overwrite: "replace" },
      ),
    ).rejects.toMatchObject({ code: "native_state" });

    const keep = fs.get("/app/keep.txt");
    expect(keep?.kind).toBe("file");
    if (keep?.kind === "file") {
      expect(Buffer.from(keep.data).toString()).toBe("original-bytes");
    }
    expect(fs.get("/app/a.txt")).toBeUndefined();
  });

  it("leaves an absent host destination absent when root mode fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-root-mode-g2h-abs-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const fs = host.filesystemFor(id);
    fs.set("/tree", { kind: "directory", mode: 0o755 });
    fs.set("/tree/a.txt", { kind: "file", mode: 0o644, data: new Uint8Array([1]) });

    const dest = join(root, "dest");
    failNextTransferRootMode();
    await expect(
      host.copyGuestToHost({ identity: id, guestPath: "/tree", hostPath: dest }),
    ).rejects.toMatchObject({ code: "native_state" });

    await expect(readFile(dest).catch((error: NodeJS.ErrnoException) => error.code)).resolves.toBe(
      "ENOENT",
    );
  });

  it("preserves an existing host destination when root mode fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-root-mode-g2h-exist-"));
    const host = new FakeHost();
    const id = seedRunning(host);
    const fs = host.filesystemFor(id);
    fs.set("/tree", { kind: "directory", mode: 0o755 });
    fs.set("/tree/a.txt", { kind: "file", mode: 0o644, data: new Uint8Array([9]) });

    const dest = join(root, "dest");
    await mkdir(dest);
    await writeFile(join(dest, "keep.txt"), "original-bytes", "utf8");

    failNextTransferRootMode();
    await expect(
      host.copyGuestToHost(
        { identity: id, guestPath: "/tree", hostPath: dest },
        { overwrite: "replace" },
      ),
    ).rejects.toMatchObject({ code: "native_state" });

    expect(await readFile(join(dest, "keep.txt"), "utf8")).toBe("original-bytes");
  });
});
