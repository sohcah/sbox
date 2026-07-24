import { describe, expect, it } from "vitest";
import {
  NATIVE_SANDBOX_NAME_MAX_BYTES,
  assertSandboxIdentity,
  nativeSandboxName,
  stableIdentityHash,
  truncateUtf8,
  utf8Bytes,
} from "../src/identity.js";

describe("nativeSandboxName", () => {
  it("is deterministic for the same project/instance", () => {
    const a = nativeSandboxName("demo", "main");
    const b = nativeSandboxName("demo", "main");
    expect(a).toBe(b);
    expect(a.startsWith("sbox-")).toBe(true);
    expect(a).toContain(stableIdentityHash("demo", "main"));
  });

  it("stays within the Microsandbox 128-byte limit", () => {
    const name = nativeSandboxName("demo", "main");
    expect(utf8Bytes(name)).toBeLessThanOrEqual(NATIVE_SANDBOX_NAME_MAX_BYTES);
  });

  it("avoids truncation collisions via stable hash", () => {
    const longA = "a".repeat(200);
    const longB = "a".repeat(200) + "b";
    const nameA = nativeSandboxName(longA, "inst");
    const nameB = nativeSandboxName(longB, "inst");
    expect(utf8Bytes(nameA)).toBeLessThanOrEqual(NATIVE_SANDBOX_NAME_MAX_BYTES);
    expect(utf8Bytes(nameB)).toBeLessThanOrEqual(NATIVE_SANDBOX_NAME_MAX_BYTES);
    expect(nameA).not.toBe(nameB);
    expect(nameA).toContain(stableIdentityHash(longA, "inst"));
    expect(nameB).toContain(stableIdentityHash(longB, "inst"));
  });

  it("handles unicode inputs without exceeding the byte limit", () => {
    const project = "项目-" + "😀".repeat(40);
    const instance = "インスタンス-" + "🚀".repeat(40);
    const name = nativeSandboxName(project, instance);
    expect(utf8Bytes(name)).toBeLessThanOrEqual(NATIVE_SANDBOX_NAME_MAX_BYTES);
    expect(name).toContain(stableIdentityHash(project, instance));
  });

  it("produces readable names for ordinary slugs", () => {
    const name = nativeSandboxName("my-app", "worker-1");
    expect(name).toMatch(/^sbox-my-app-worker-1-[0-9a-f]{16}$/);
  });

  it("differs across project or instance changes", () => {
    expect(nativeSandboxName("a", "x")).not.toBe(nativeSandboxName("b", "x"));
    expect(nativeSandboxName("a", "x")).not.toBe(nativeSandboxName("a", "y"));
  });

  it("truncateUtf8 never splits a codepoint", () => {
    const value = "abc😀def";
    const truncated = truncateUtf8(value, 5);
    expect(utf8Bytes(truncated)).toBeLessThanOrEqual(5);
    expect(truncated.includes("\uFFFD")).toBe(false);
  });

  it("assertSandboxIdentity validates portable slugs", () => {
    expect(() =>
      assertSandboxIdentity({ project: "OK", profile: "default", instance: "main" }),
    ).toThrow(/portable slug/);
    expect(
      assertSandboxIdentity({ project: "demo", profile: "default", instance: "main" }),
    ).toEqual({
      project: "demo",
      profile: "default",
      instance: "main",
    });
  });
});
