import { describe, expect, it } from "vitest";
import {
  parseProjectConfig,
  toSafeProjectConfig,
  tryParseProjectConfig,
} from "../src/config/validate.js";

describe("image/build profile configuration", () => {
  it("accepts image-reference profiles", () => {
    const config = parseProjectConfig({
      version: 1,
      project: "demo",
      profiles: { default: { image: "alpine:3.20" } },
    });
    expect(config.profiles["default"]).toMatchObject({ image: "alpine:3.20" });
    expect(toSafeProjectConfig(config).profiles["default"]?.image).toBe("alpine:3.20");
  });

  it("accepts dockerfile-backed build profiles with defaults", () => {
    const config = parseProjectConfig({
      version: 1,
      project: "demo",
      profiles: {
        built: {
          build: {
            context: ".",
            target: "runtime",
            args: { NODE_ENV: "production", TOKEN: { env: "BUILD_TOKEN" } },
            secrets: { npm: { env: "NPM_TOKEN" } },
            includeGit: true,
          },
        },
      },
    });
    const profile = config.profiles["built"];
    expect(profile?.build?.context).toBe(".");
    expect(profile?.build?.dockerfile).toBeUndefined();
    const safe = toSafeProjectConfig(config).profiles["built"]?.build;
    expect(safe).toMatchObject({
      dockerfile: "Dockerfile",
      target: "runtime",
      includeGit: true,
      args: { NODE_ENV: "literal", TOKEN: "env" },
      secrets: { npm: "env" },
    });
    expect(JSON.stringify(safe)).not.toContain("NPM_TOKEN");
    expect(JSON.stringify(safe)).not.toContain("production");
  });

  it("rejects missing image and build", () => {
    const result = tryParseProjectConfig({
      version: 1,
      project: "demo",
      profiles: { default: { cpus: 1 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.includes("image"))).toBe(true);
      expect(result.issues.some((issue) => issue.path.includes("build"))).toBe(true);
    }
  });

  it("rejects both image and build", () => {
    const result = tryParseProjectConfig({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          build: { context: "." },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => /only one of/.test(issue.message))).toBe(true);
    }
  });

  it("rejects escaping dockerfile paths", () => {
    const result = tryParseProjectConfig({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          build: { context: ".", dockerfile: "../Dockerfile" },
        },
      },
    });
    expect(result.ok).toBe(false);
  });
});
