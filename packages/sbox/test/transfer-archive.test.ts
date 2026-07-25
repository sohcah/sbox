import { describe, expect, it } from "vitest";
import { utf8ToBytes } from "../src/process/decode.js";
import {
  ARCHIVE_FORMAT_VERSION,
  createTransferArchive,
  executableBits,
  permissionBits,
  validateEntries,
} from "../src/transfer/archive.js";
import {
  assertGuestAbsolutePath,
  assertRelativeTransferPath,
  isSafeSymlinkTarget,
  joinGuestPath,
} from "../src/transfer/paths.js";

describe("transfer archive helpers", () => {
  it("creates a versioned archive after validating entries", () => {
    const archive = createTransferArchive([
      { kind: "directory", path: "pkg", mode: 0o755 },
      { kind: "file", path: "pkg/a.txt", mode: 0o644, data: utf8ToBytes("hi") },
      { kind: "symlink", path: "pkg/link", target: "a.txt" },
    ]);
    expect(archive.version).toBe(ARCHIVE_FORMAT_VERSION);
    expect(archive.entries).toHaveLength(3);
  });

  it("rejects absolute member paths, traversal, and duplicates", () => {
    expect(() =>
      validateEntries([{ kind: "file", path: "/abs", mode: 0o644, data: new Uint8Array() }]),
    ).toThrowError(/relative path/);

    expect(() =>
      validateEntries([{ kind: "file", path: "../x", mode: 0o644, data: new Uint8Array() }]),
    ).toThrow();

    expect(() =>
      validateEntries([
        { kind: "file", path: "a", mode: 0o644, data: new Uint8Array() },
        { kind: "file", path: "a", mode: 0o644, data: new Uint8Array() },
      ]),
    ).toThrowError(/duplicate/i);
  });

  it("accepts safe relative symlink targets", () => {
    expect(
      createTransferArchive([{ kind: "symlink", path: "link", target: "safe-relative" }]),
    ).toMatchObject({ version: ARCHIVE_FORMAT_VERSION });
  });

  it("enforces archive bounds", () => {
    expect(() =>
      createTransferArchive([{ kind: "file", path: "a", mode: 0o644, data: new Uint8Array(10) }], {
        maxTotalBytes: 5,
      }),
    ).toThrow();
    expect(() =>
      createTransferArchive(
        [
          { kind: "file", path: "a", mode: 0o644, data: new Uint8Array() },
          { kind: "file", path: "b", mode: 0o644, data: new Uint8Array() },
        ],
        { maxEntries: 1 },
      ),
    ).toThrow();
  });

  it("exposes permission helpers and path policy", () => {
    expect(executableBits(0o755)).toBeTruthy();
    expect(permissionBits(0o100755)).toBe(0o755);
    expect(joinGuestPath("/root", "a/b")).toBe("/root/a/b");
    expect(isSafeSymlinkTarget("a/b", "/root", "/root")).toBe(true);
    expect(isSafeSymlinkTarget("../x", "/root", "/root")).toBe(false);
    expect(assertRelativeTransferPath("a/b", "path")).toBe("a/b");
    expect(() => assertGuestAbsolutePath("rel", "guestPath")).toThrow();
    expect(assertGuestAbsolutePath("/abs", "guestPath")).toBe("/abs");
  });
});
