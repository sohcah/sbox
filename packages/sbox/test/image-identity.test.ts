import { describe, expect, it } from "vitest";
import { computeImageContentIdentity, type ImageIdentityModel } from "../src/image/identity.js";
import { IMAGE_IDENTITY_ALGORITHM_VERSION } from "../src/image/naming.js";

function baseModel(overrides: Partial<ImageIdentityModel> = {}): ImageIdentityModel {
  return {
    algorithmVersion: IMAGE_IDENTITY_ALGORITHM_VERSION,
    dockerfileRelativePath: "Dockerfile",
    dockerfileContents: new TextEncoder().encode("FROM alpine:3.20\n"),
    platform: "linux/arm64",
    target: "",
    args: {},
    secretIds: [],
    includeGit: false,
    entries: [
      {
        kind: "file",
        relativePath: "Dockerfile",
        mode: 0o644,
        contents: new TextEncoder().encode("FROM alpine:3.20\n"),
      },
    ],
    ...overrides,
  };
}

describe("image content identity", () => {
  it("is stable across entry order", () => {
    const a = computeImageContentIdentity(
      baseModel({
        entries: [
          { kind: "directory", relativePath: "src", mode: 0o755 },
          {
            kind: "file",
            relativePath: "src/a.txt",
            mode: 0o644,
            contents: new TextEncoder().encode("a"),
          },
          {
            kind: "file",
            relativePath: "Dockerfile",
            mode: 0o644,
            contents: new TextEncoder().encode("FROM alpine:3.20\n"),
          },
        ],
      }),
    );
    const b = computeImageContentIdentity(
      baseModel({
        entries: [
          {
            kind: "file",
            relativePath: "Dockerfile",
            mode: 0o644,
            contents: new TextEncoder().encode("FROM alpine:3.20\n"),
          },
          {
            kind: "file",
            relativePath: "src/a.txt",
            mode: 0o644,
            contents: new TextEncoder().encode("a"),
          },
          { kind: "directory", relativePath: "src", mode: 0o755 },
        ],
      }),
    );
    expect(a.digestHex).toBe(b.digestHex);
    expect(a.nativeReference).toMatch(/^sbox-img:sha256-[0-9a-f]{64}$/);
  });

  it("changes when recipe, platform, target, args, bytes, link, mode, or algorithm change", () => {
    const base = computeImageContentIdentity(baseModel());
    const variants = [
      baseModel({ dockerfileContents: new TextEncoder().encode("FROM alpine:3.19\n") }),
      baseModel({ platform: "linux/amd64" }),
      baseModel({ target: "runtime" }),
      baseModel({ args: { A: "1" } }),
      baseModel({
        entries: [
          {
            kind: "file",
            relativePath: "Dockerfile",
            mode: 0o644,
            contents: new TextEncoder().encode("FROM alpine:3.20\nCHANGED\n"),
          },
        ],
      }),
      baseModel({
        entries: [
          {
            kind: "file",
            relativePath: "Dockerfile",
            mode: 0o755,
            contents: new TextEncoder().encode("FROM alpine:3.20\n"),
          },
        ],
      }),
      baseModel({
        entries: [
          {
            kind: "file",
            relativePath: "Dockerfile",
            mode: 0o644,
            contents: new TextEncoder().encode("FROM alpine:3.20\n"),
          },
          { kind: "symlink", relativePath: "link", target: "Dockerfile" },
        ],
      }),
      baseModel({ algorithmVersion: IMAGE_IDENTITY_ALGORITHM_VERSION + 1 }),
    ];
    for (const variant of variants) {
      expect(computeImageContentIdentity(variant).digestHex).not.toBe(base.digestHex);
    }
  });

  it("does not change when only secret values would differ — only secret ids matter", () => {
    const withSecret = computeImageContentIdentity(baseModel({ secretIds: ["npm"] }));
    const sameIds = computeImageContentIdentity(baseModel({ secretIds: ["npm"] }));
    expect(withSecret.digestHex).toBe(sameIds.digestHex);
    const differentIds = computeImageContentIdentity(baseModel({ secretIds: ["docker"] }));
    expect(differentIds.digestHex).not.toBe(withSecret.digestHex);
  });
});
