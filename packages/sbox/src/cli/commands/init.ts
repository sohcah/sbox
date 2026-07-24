import { mkdir, writeFile, access, unlink, rename } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { assertProjectId } from "../../identity.js";
import { loadProjectConfigFromYaml } from "../../config/yaml.js";
import { SboxError } from "../../errors.js";
import type { CliContext } from "../context.js";
import { writeResult } from "../context.js";
import { cliErrorResult, formatCliResult, type CliResult } from "../format.js";
import { EXIT_SUCCESS, exitCodeForError } from "../exit-codes.js";

function starterYaml(project: string): string {
  // Project is a validated portable slug, safe to embed without quoting.
  return `version: 1
project: ${project}
defaultProfile: default
profiles:
  default:
    image: alpine:3.20
    cpus: 1
    memory: 512MiB
    workdir: /root
    user: root
    shell: /bin/sh
`;
}

export async function runInit(
  ctx: CliContext,
  args: { readonly force?: boolean; readonly project?: string },
): Promise<number> {
  const command = "init";
  const path = join(ctx.io.cwd, "sbox.yaml");
  try {
    const project =
      args.project !== undefined ? assertProjectId(args.project, "project") : "example";

    const exists = await pathExists(path);
    if (exists && args.force !== true) {
      throw SboxError.alreadyExists(`Refusing to overwrite existing ${path}. Use --force.`, {
        details: { path },
      });
    }
    await mkdir(ctx.io.cwd, { recursive: true });
    const body = starterYaml(project);
    // Ensure the generated document is immediately valid under the same schema.
    loadProjectConfigFromYaml(body);
    await publishTextFile(path, body);
    const result: CliResult = {
      ok: true,
      command,
      data: { path, created: true, project },
    };
    writeResult(ctx, formatCliResult(result, ctx.format));
    return EXIT_SUCCESS;
  } catch (error) {
    writeResult(ctx, formatCliResult(cliErrorResult(command, error), ctx.format));
    return exitCodeForError(error);
  }
}

/**
 * Write via a same-directory temp file then rename so `--force` never leaves a
 * half-written destination, and failures before rename preserve any original.
 */
async function publishTextFile(path: string, body: string): Promise<void> {
  const tempPath = join(dirname(path), `.sbox-init-${randomBytes(16).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, body, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Best-effort temp cleanup only; never unlink the published path.
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
