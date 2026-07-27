import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(packageRoot, "../..");

/** Forbidden Microsandbox references in published declaration text. */
export function findMicrosandboxDeclarationLeaks(declarationText: string): string[] {
  const patterns: Array<{ name: string; regex: RegExp }> = [
    { name: 'from "microsandbox"', regex: /from ["']microsandbox["']/ },
    { name: "microsandbox/ path", regex: /microsandbox\// },
    { name: 'import("microsandbox")', regex: /import\(["']microsandbox["']\)/ },
  ];
  return patterns.filter((entry) => entry.regex.test(declarationText)).map((entry) => entry.name);
}

async function collectReachableDts(
  entryDts: string,
  packageDist: string,
): Promise<Map<string, string>> {
  const visited = new Map<string, string>();
  const queue = [entryDts];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) {
      continue;
    }
    const text = await readFile(current, "utf8");
    visited.set(current, text);
    for (const match of text.matchAll(/from ["'](\.[^"']+)["']/g)) {
      const spec = match[1]!;
      const resolved = join(
        dirname(current),
        spec.endsWith(".js") ? spec.replace(/\.js$/, ".d.ts") : `${spec}.d.ts`,
      );
      if (resolved.startsWith(packageDist) && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return visited;
}

describe("declaration leak guard", () => {
  it('fails on inline import("microsandbox") fixtures using the shared guard', () => {
    const fixture = `export type Leak = import("microsandbox").Sandbox;\n`;
    expect(findMicrosandboxDeclarationLeaks(fixture)).toEqual(['import("microsandbox")']);
  });

  it("builds declarations without Microsandbox types or internal config helpers", async () => {
    const build = spawnSync("pnpm", ["exec", "tsc", "-b", "--pretty", "false"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);

    const dist = join(packageRoot, "dist");
    const indexDts = join(dist, "index.d.ts");
    const reachable = await collectReachableDts(indexDts, dist);
    const combined = [...reachable.values()].join("\n");

    expect(findMicrosandboxDeclarationLeaks(combined)).toEqual([]);
    expect(combined).not.toMatch(/\bFakeHost\b/);
    expect(combined).not.toMatch(/\bMemoryNativeRuntime\b/);
    expect(combined).not.toMatch(/\bcreateLocalHostInternal\b/);
    expect(combined).not.toMatch(/\bNativeRuntime\b/);
    expect(combined).not.toMatch(/\blocal-host-internal\b/);
    expect(combined).not.toMatch(/SandboxAlreadyExistsError|SandboxNotFoundError|NapiSandbox/);
    expect(combined).not.toMatch(/\bDecodedSandboxConfig\b/);
    expect(combined).not.toMatch(/\bImmutableCreationProjection\b/);
    expect(combined).not.toMatch(/\bdecodeSandboxConfig\b/);
    expect(combined).not.toMatch(/\bcreationFingerprint\b/);
    expect(combined).not.toMatch(/\bprojectCreateRequest\b/);
    expect(combined).not.toMatch(/\bimmutableCreationEquals\b/);
    expect(combined).not.toMatch(/\bPHASE1_DEFAULT_CPUS\b/);
    expect(combined).not.toMatch(/\bsandbox-config\b/);
    expect(combined).not.toMatch(/\bimmutable-creation\b/);
    expect(combined).not.toMatch(/\bmicrosandbox-runtime\b/);
    expect(combined).not.toMatch(/\bownership-adoption\b/);
    expect(combined).not.toMatch(/\bmatchOwnedCreation\b/);
    expect(combined).not.toMatch(/\bnativeRecordMatchesCreation\b/);
    expect(combined).not.toMatch(/\bNativeCreationEvidence\b/);
    expect(combined).not.toMatch(/\bSandboxImmutableCreation\b/);
    expect(combined).not.toMatch(/\bbuildOwnershipLabels\b/);
    expect(combined).not.toMatch(/\bmatchOwnershipLabels\b/);
    expect(combined).not.toMatch(/\bHostSboxClient\b/);
    expect(combined).not.toMatch(/\bHostSandboxHandle\b/);
    expect(combined).not.toMatch(/\bhandle-impl\b/);
    expect(combined).not.toMatch(/\bprojectConfigSchema\b/);
    expect(combined).not.toMatch(/\byamlProjectInputSchema\b/);
    expect(combined).not.toMatch(/\bnormalizeYamlProjectInput\b/);
    expect(combined).not.toMatch(/\bresolveCreateIntent\b/);
    expect(combined).not.toMatch(/\breportCreationDrift\b/);
    expect(combined).not.toMatch(/\bimmutableCreationDriftFields\b/);
    expect(combined).not.toMatch(/\bconfig\/schema\b/);
    expect(combined).not.toMatch(/\bresolveTarget\b/);
    expect(combined).not.toMatch(/\brequireLocalTarget\b/);
    expect(combined).not.toMatch(/\bResolvedRemoteTarget\b/);
    expect(combined).not.toMatch(/\bResolvedLocalTarget\b/);
    expect(combined).not.toMatch(/\bselectTargetName\b/);
    expect(combined).not.toMatch(/\bassertLocalTarget\b/);
    expect(combined).not.toMatch(/\bExternalResolutionContext\b/);
    expect(combined).not.toMatch(/\bresolveExternalValue\b/);
    expect(combined).not.toMatch(/\bresolveEnvironmentMap\b/);
    expect(combined).not.toMatch(/\bplatformUserConfigPath\b/);
    expect(combined).not.toMatch(/\bparseBinarySizeToMiB\b/);
    expect(combined).not.toMatch(/\brunCli\b/);
    expect(combined).not.toMatch(/\bCliIo\b/);
    expect(combined).not.toMatch(/\bCliContext\b/);
    expect(combined).not.toMatch(/readonly token: string/);
    expect(combined).not.toMatch(/\bagent-protocol\b/);
    expect(combined).not.toMatch(/\bAGENT_PROTOCOL_VERSION\b/);
    expect(combined).not.toMatch(/\bencodeEnvelope\b/);
    expect(combined).not.toMatch(/\bencodeExecRequest\b/);
    expect(combined).not.toMatch(/\bMSG_EXEC_REQUEST\b/);
    expect(combined).not.toMatch(/\bagent-pty\b/);
    expect(combined).not.toMatch(/\bagent-fs\b/);
    expect(combined).not.toMatch(/\bstartAgentPty\b/);
    expect(combined).not.toMatch(/\bFakeSandboxFilesystem\b/);
    expect(combined).not.toMatch(/\bdefaultFakeExec\b/);
    expect(combined).not.toMatch(/\bfake-process\b/);
    expect(combined).not.toMatch(/\blocal-process\b/);
    expect(combined).not.toMatch(/\blocal-transfer\b/);
    expect(combined).not.toMatch(/\bnative-images\b/);
    expect(combined).not.toMatch(/\bEnsureImagePorts\b/);
    expect(combined).not.toMatch(/\bNativeImageEvidence\b/);
    expect(combined).not.toMatch(/\brunExactCommand\b/);
    expect(combined).not.toMatch(/\bcomputeGeneratedImageIdentity\b/);
    expect(combined).not.toMatch(/\bcomputeImageContentIdentity\b/);
    expect(combined).not.toMatch(/\binspectImageOwnershipLabels\b/);
    expect(combined).not.toMatch(/\bbuildImageOwnershipLabels\b/);
    expect(combined).not.toMatch(/\bhostDockerPlatform\b/);
    expect(combined).not.toMatch(/\bdiscoverBuildContext\b/);
    expect(combined).not.toMatch(/\bmaterializeContextEntries\b/);
    expect(combined).not.toMatch(/\bformatNativeImageReference\b/);
    expect(combined).not.toMatch(/\bIMAGE_IDENTITY_ALGORITHM_VERSION\b/);
    expect(combined).not.toMatch(/\bIMAGE_LABEL_KEYS\b/);
    expect(combined).not.toMatch(/\bclearEnsureImageCoalescing\b/);
    expect(combined).not.toMatch(/\bARCHIVE_FORMAT_VERSION\b/);
    expect(combined).not.toMatch(/\bcreateTransferArchive\b/);
    expect(combined).not.toMatch(/\bvalidateEntries\b/);
    expect(combined).not.toMatch(/\bTransferArchive\b/);
    expect(combined).not.toMatch(/\bTransferEntry\b/);
    expect(combined).not.toMatch(/\bassertRelativeTransferPath\b/);
    expect(combined).not.toMatch(/\bisSafeSymlinkTarget\b/);
    expect(combined).not.toMatch(/\bBoundedAsyncQueue\b/);
    expect(combined).not.toMatch(/\bpublishHostPath\b/);
    expect(combined).not.toMatch(/\bcreateSdkProcessSession\b/);
    expect(combined).not.toMatch(/\bcreateAgentPtySession\b/);

    const consumerDir = await mkdtemp(join(tmpdir(), "sbox-consumer-"));
    try {
      await writeFile(
        join(consumerDir, "package.json"),
        JSON.stringify({
          name: "sbox-consumer-fixture",
          private: true,
          type: "module",
        }),
        "utf8",
      );
      await mkdir(join(consumerDir, "node_modules/@sohcah"), { recursive: true });
      await rm(join(consumerDir, "node_modules/@sohcah/sbox"), { force: true });
      const { symlink } = await import("node:fs/promises");
      // Junctions do not need Developer Mode / admin on Windows; plain dir symlinks do.
      await symlink(
        packageRoot,
        join(consumerDir, "node_modules/@sohcah/sbox"),
        process.platform === "win32" ? "junction" : "dir",
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
              exactOptionalPropertyTypes: true,
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
  SboxError,
  assertSandboxIdentity,
  createLocalHost,
  createSboxClient,
  nativeSandboxName,
  parseProjectConfig,
  type Host,
  type SandboxInspection,
  type ProcessResult,
  type ProcessEvent,
  type SboxClient,
} from "@sohcah/sbox";

export async function smoke(): Promise<SandboxInspection> {
  const host: Host = createLocalHost();
  const client: SboxClient = createSboxClient({
    project: parseProjectConfig({
      version: 1,
      project: "demo",
      profiles: { default: { image: "alpine:3.20" } },
    }),
    host,
    ownsHost: false,
  });
  const identity = assertSandboxIdentity({
    project: "demo",
    profile: "default",
    instance: "main",
  });
  void nativeSandboxName(identity.project, identity.instance);
  void PACKAGE_NAME;
  if (SboxError.notFound("x") instanceof SboxError) {
    // ok
  }
  void client;
  return host.inspect(identity);
}

export type Result = ProcessResult;
export type Event = ProcessEvent;
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

describe("package map sources", () => {
  it("packs with resolvable or embedded map sources", async () => {
    const packDir = await mkdtemp(join(tmpdir(), "sbox-pack-"));
    try {
      const pack = spawnSync("pnpm", ["pack", "--pack-destination", packDir], {
        cwd: packageRoot,
        encoding: "utf8",
      });
      expect(pack.status, pack.stderr || pack.stdout).toBe(0);
      const tarball = (await readdir(packDir)).find((name) => name.endsWith(".tgz"));
      expect(tarball).toBeTypeOf("string");
      const extractDir = join(packDir, "extract");
      await mkdir(extractDir);
      const extract = spawnSync("tar", ["-xzf", join(packDir, tarball!), "-C", extractDir], {
        encoding: "utf8",
      });
      expect(extract.status, extract.stderr).toBe(0);
      const packedRoot = join(extractDir, "package");
      const distFiles = await walk(join(packedRoot, "dist"));
      const mapFiles = distFiles.filter((path) => path.endsWith(".map"));
      for (const mapFile of mapFiles) {
        const map = JSON.parse(await readFile(mapFile, "utf8")) as {
          sources?: string[];
          sourcesContent?: Array<string | null>;
        };
        const embedded =
          Array.isArray(map.sourcesContent) &&
          map.sourcesContent.length > 0 &&
          map.sourcesContent.every((entry) => typeof entry === "string");
        if (embedded) {
          continue;
        }
        for (const source of map.sources ?? []) {
          const resolved = join(dirname(mapFile), source);
          await expect(readFile(resolved, "utf8")).resolves.toBeTypeOf("string");
        }
      }
      // No declaration maps with dangling ../src links.
      expect(mapFiles.some((path) => path.endsWith(".d.ts.map"))).toBe(false);
      void relative;
    } finally {
      await rm(packDir, { recursive: true, force: true });
    }
  }, 60_000);
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(path)));
    } else {
      out.push(path);
    }
  }
  return out;
}
