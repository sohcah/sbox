import { chmod, mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverBuildContext } from "../src/image/context.js";
import { computeImageContentIdentity } from "../src/image/identity.js";
import { IMAGE_IDENTITY_ALGORITHM_VERSION } from "../src/image/naming.js";
import { hostDockerPlatform } from "../src/image/platform.js";

async function seedContext(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sbox-ctx-"));
  await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\nCOPY app.txt /app.txt\n");
  await writeFile(join(root, "app.txt"), "payload");
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "config"), "secret-git");
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "x.bin"), "x");
  return root;
}

describe("build context discovery", () => {
  it("applies .dockerignore and excludes .git by default", async () => {
    const root = await seedContext();
    await writeFile(join(root, ".dockerignore"), "ignored\n");
    const discovered = await discoverBuildContext({
      contextRoot: root,
      dockerfile: "Dockerfile",
      includeGit: false,
    });
    const paths = discovered.entries.map((entry) => entry.relativePath);
    expect(paths).toContain("Dockerfile");
    expect(paths).toContain("app.txt");
    expect(paths).not.toContain("ignored/x.bin");
    expect(paths.some((path) => path.startsWith(".git"))).toBe(false);
    expect(discovered.ignoreSource).toBe("dockerignore");
  });

  it("prefers Dockerfile-specific ignore over .dockerignore", async () => {
    const root = await seedContext();
    await writeFile(join(root, ".dockerignore"), "app.txt\n");
    await writeFile(join(root, "Dockerfile.dockerignore"), "ignored\n");
    const discovered = await discoverBuildContext({
      contextRoot: root,
      dockerfile: "Dockerfile",
      includeGit: false,
    });
    const paths = discovered.entries.map((entry) => entry.relativePath);
    expect(paths).toContain("app.txt");
    expect(paths).not.toContain("ignored/x.bin");
    expect(discovered.ignoreSource).toBe("dockerfile-specific");
  });

  it("includes .git when explicitly opted in", async () => {
    const root = await seedContext();
    const discovered = await discoverBuildContext({
      contextRoot: root,
      dockerfile: "Dockerfile",
      includeGit: true,
    });
    expect(discovered.entries.some((entry) => entry.relativePath.startsWith(".git"))).toBe(true);
  });

  it("rejects absolute and escaping symlinks", async () => {
    const root = await seedContext();
    await symlink("/etc/passwd", join(root, "abs-link"));
    await expect(
      discoverBuildContext({ contextRoot: root, dockerfile: "Dockerfile", includeGit: false }),
    ).rejects.toMatchObject({ code: "validation" });

    const root2 = await seedContext();
    await symlink("../outside", join(root2, "escape-link"));
    await expect(
      discoverBuildContext({ contextRoot: root2, dockerfile: "Dockerfile", includeGit: false }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("identity is independent of absolute root and timestamps", async () => {
    const rootA = await seedContext();
    const rootB = await seedContext();
    await utimes(join(rootA, "app.txt"), new Date(1_000_000), new Date(1_000_000));
    await utimes(join(rootB, "app.txt"), new Date(2_000_000), new Date(2_000_000));
    const a = await discoverBuildContext({
      contextRoot: rootA,
      dockerfile: "Dockerfile",
      includeGit: false,
    });
    const b = await discoverBuildContext({
      contextRoot: rootB,
      dockerfile: "Dockerfile",
      includeGit: false,
    });
    const idA = computeImageContentIdentity({
      algorithmVersion: IMAGE_IDENTITY_ALGORITHM_VERSION,
      dockerfileRelativePath: a.dockerfileRelativePath,
      dockerfileContents: a.dockerfileContents,
      platform: hostDockerPlatform(),
      target: "",
      args: {},
      secretIds: [],
      includeGit: false,
      entries: a.entries,
    });
    const idB = computeImageContentIdentity({
      algorithmVersion: IMAGE_IDENTITY_ALGORITHM_VERSION,
      dockerfileRelativePath: b.dockerfileRelativePath,
      dockerfileContents: b.dockerfileContents,
      platform: hostDockerPlatform(),
      target: "",
      args: {},
      secretIds: [],
      includeGit: false,
      entries: b.entries,
    });
    expect(idA.digestHex).toBe(idB.digestHex);
  });

  it.skipIf(process.platform === "win32")(
    "records executable bits in discovered files",
    async () => {
      const root = await seedContext();
      await writeFile(join(root, "run.sh"), "#!/bin/sh\n");
      await chmod(join(root, "run.sh"), 0o755);
      const discovered = await discoverBuildContext({
        contextRoot: root,
        dockerfile: "Dockerfile",
        includeGit: false,
      });
      const script = discovered.entries.find(
        (entry) => entry.kind === "file" && entry.relativePath === "run.sh",
      );
      expect(script?.kind).toBe("file");
      if (script?.kind === "file") {
        expect(script.mode & 0o111).toBeTruthy();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "materializes directory modes deepest-first without swallowing chmod errors",
    async () => {
      const { materializeContextEntries } = await import("../src/image/context.js");
      const { lstat } = await import("node:fs/promises");
      const root = await mkdtemp(join(tmpdir(), "sbox-mat-"));
      const dest = join(root, "out");
      await materializeContextEntries(dest, [
        { kind: "directory", relativePath: "nested", mode: 0o755 },
        { kind: "directory", relativePath: "nested/deep", mode: 0o700 },
        {
          kind: "file",
          relativePath: "nested/deep/file.txt",
          mode: 0o640,
          contents: new TextEncoder().encode("x"),
        },
      ]);
      const deep = await lstat(join(dest, "nested/deep"));
      const file = await lstat(join(dest, "nested/deep/file.txt"));
      expect(deep.mode & 0o777).toBe(0o700);
      expect(file.mode & 0o777).toBe(0o640);
    },
  );
});
