import { afterEach, describe, expect, it } from "vitest";
import { isSboxError } from "../src/errors.js";
import {
  clearEnsureFormatterImageCoalescing,
  defaultFormatterDockerfilePath,
  ensureFormatterImage,
} from "../src/volume/ensure-formatter.js";
import {
  DEFAULT_VOLUME_FORMATTER_IMAGE,
  volumeFormatterImage,
} from "../src/volume/formatter-image.js";

describe("ensureFormatterImage", () => {
  const previousOverride = process.env["SBOX_VOLUME_FORMATTER_IMAGE"];

  afterEach(() => {
    clearEnsureFormatterImageCoalescing();
    if (previousOverride === undefined) {
      delete process.env["SBOX_VOLUME_FORMATTER_IMAGE"];
    } else {
      process.env["SBOX_VOLUME_FORMATTER_IMAGE"] = previousOverride;
    }
  });

  it("resolves the shipped Dockerfile path", () => {
    expect(defaultFormatterDockerfilePath().replaceAll("\\", "/")).toMatch(
      /\/formatter\/Dockerfile$/,
    );
  });

  it("skips auto-build when SBOX_VOLUME_FORMATTER_IMAGE is set", async () => {
    process.env["SBOX_VOLUME_FORMATTER_IMAGE"] = "custom-formatter:9";
    const calls: string[] = [];
    const result = await ensureFormatterImage(undefined, {
      get: async () => {
        calls.push("get");
        return null;
      },
      runCommand: async () => {
        calls.push("run");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      load: async () => {
        calls.push("load");
      },
    });
    expect(result).toEqual({ image: "custom-formatter:9", built: false });
    expect(calls).toEqual([]);
    expect(volumeFormatterImage()).toBe("custom-formatter:9");
  });

  it("skips build when the default image is already present", async () => {
    delete process.env["SBOX_VOLUME_FORMATTER_IMAGE"];
    const calls: string[] = [];
    const result = await ensureFormatterImage(undefined, {
      get: async (reference) => {
        calls.push(`get:${reference}`);
        return { reference };
      },
      runCommand: async () => {
        calls.push("run");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      load: async () => {
        calls.push("load");
      },
    });
    expect(result).toEqual({ image: DEFAULT_VOLUME_FORMATTER_IMAGE, built: false });
    expect(calls).toEqual([`get:${DEFAULT_VOLUME_FORMATTER_IMAGE}`]);
  });

  it("builds, exports, and loads when the default image is missing", async () => {
    delete process.env["SBOX_VOLUME_FORMATTER_IMAGE"];
    const commands: string[][] = [];
    let present = false;
    const result = await ensureFormatterImage(undefined, {
      get: async () => (present ? { ok: true } : null),
      runCommand: async (request) => {
        commands.push([request.executable, ...request.args]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      load: async (_archive, tag) => {
        expect(tag).toBe(DEFAULT_VOLUME_FORMATTER_IMAGE);
        present = true;
      },
      dockerfilePath: defaultFormatterDockerfilePath(),
      platform: "linux/amd64",
    });
    expect(result).toEqual({ image: DEFAULT_VOLUME_FORMATTER_IMAGE, built: true });
    expect(commands[0]?.[0]).toBe("docker");
    expect(commands[0]?.slice(0, 2)).toEqual(["docker", "build"]);
    expect(commands[1]?.slice(0, 2)).toEqual(["docker", "save"]);
  });

  it("coalesces concurrent first-use builds", async () => {
    delete process.env["SBOX_VOLUME_FORMATTER_IMAGE"];
    let builds = 0;
    let present = false;
    const run = () =>
      ensureFormatterImage(undefined, {
        get: async () => (present ? { ok: true } : null),
        runCommand: async () => {
          builds += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        load: async () => {
          present = true;
        },
        dockerfilePath: defaultFormatterDockerfilePath(),
        platform: "linux/amd64",
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.built).toBe(true);
    expect(b.built).toBe(true);
    // docker build + docker save once (shared), not doubled
    expect(builds).toBe(2);
  });

  it("maps missing Dockerfile to image_unavailable", async () => {
    delete process.env["SBOX_VOLUME_FORMATTER_IMAGE"];
    await expect(
      ensureFormatterImage(undefined, {
        get: async () => null,
        dockerfilePath: "/nonexistent/formatter/Dockerfile",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isSboxError(error)).toBe(true);
      if (!isSboxError(error)) {
        return false;
      }
      expect(error.code).toBe("capability");
      expect(error.details["unavailableReason"]).toBe("image_unavailable");
      return true;
    });
  });
});
