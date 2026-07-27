import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(packageRoot, "../..");

describe("@sohcah/sbox-sandcastle declaration leak guard", () => {
  it("exports package identity without Microsandbox types", async () => {
    const build = spawnSync("pnpm", ["exec", "tsc", "-b", "--pretty", "false"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);

    const indexDts = await readFile(join(packageRoot, "dist/index.d.ts"), "utf8");
    expect(indexDts).not.toMatch(/microsandbox/);
    expect(indexDts).toMatch(/@sohcah\/sbox-sandcastle/);

    const consumerDir = await mkdtemp(join(tmpdir(), "sbox-sandcastle-consumer-"));
    try {
      await writeFile(
        join(consumerDir, "package.json"),
        JSON.stringify({
          name: "sbox-sandcastle-consumer-fixture",
          private: true,
          type: "module",
        }),
        "utf8",
      );
      await mkdir(join(consumerDir, "node_modules/@sohcah"), { recursive: true });
      await rm(join(consumerDir, "node_modules/@sohcah/sbox-sandcastle"), { force: true });
      // Junctions do not need Developer Mode / admin on Windows; plain dir symlinks do.
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await symlink(
        packageRoot,
        join(consumerDir, "node_modules/@sohcah/sbox-sandcastle"),
        linkType,
      );
      await rm(join(consumerDir, "node_modules/@sohcah/sbox"), { force: true });
      await symlink(
        join(workspaceRoot, "packages/sbox"),
        join(consumerDir, "node_modules/@sohcah/sbox"),
        linkType,
      );

      await writeFile(
        join(consumerDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2024",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              verbatimModuleSyntax: true,
              typeRoots: [join(workspaceRoot, "node_modules/@types")],
            },
            include: ["consumer.ts"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        join(consumerDir, "consumer.ts"),
        `
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SBOX_PACKAGE_NAME,
  createSboxSandcastleProvider,
} from "@sohcah/sbox-sandcastle";
export const names = [PACKAGE_NAME, PACKAGE_VERSION, SBOX_PACKAGE_NAME] as const;
export type ProviderFactory = typeof createSboxSandcastleProvider;
`,
        "utf8",
      );

      const typecheck = spawnSync(
        "pnpm",
        ["exec", "tsc", "-p", join(consumerDir, "tsconfig.json"), "--pretty", "false"],
        { cwd: workspaceRoot, encoding: "utf8" },
      );
      expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0);
    } finally {
      await rm(consumerDir, { recursive: true, force: true });
    }
  }, 60_000);
});
