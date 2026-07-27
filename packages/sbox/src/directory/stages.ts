/**
 * Materialize and clean Directory stages for remote Client-path mounts.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SboxError, throwIfAborted } from "../errors.js";
import type { SandboxIdentity } from "../identity.js";
import { packHostPath } from "../remote/materialize.js";
import {
  createTransferArchive,
  type TransferArchive,
  type TransferEntry,
} from "../transfer/archive.js";
import { assertBindableDirectory } from "./assert-directory.js";
import type { HostDirectoryMount } from "./types.js";
import {
  defaultDirectoryStageRoot,
  directoryStageGenerationRoot,
  directoryStagePathForMount,
  directoryStageRootForIdentity,
} from "./paths.js";

export async function removeDirectoryStages(
  identity: SandboxIdentity,
  dataRoot: string = defaultDirectoryStageRoot(),
): Promise<void> {
  await rm(directoryStageRootForIdentity(identity, dataRoot), { recursive: true, force: true });
}

export async function removeDirectoryStageGeneration(generationRoot: string): Promise<void> {
  await rm(generationRoot, { recursive: true, force: true });
}

async function extractArchiveToDirectory(
  archive: TransferArchive,
  dest: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of archive.entries) {
    throwIfAborted(signal);
    const path = join(dest, ...entry.path.split("/"));
    if (entry.kind === "directory") {
      await mkdir(path, { recursive: true });
      await chmod(path, entry.mode);
    } else if (entry.kind === "file") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.data);
      await chmod(path, entry.mode);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await symlink(entry.target, path);
    }
  }
}

export type MaterializedDirectoryStages = {
  readonly directories: readonly HostDirectoryMount[];
  /** Isolated create-attempt root; delete only this on create failure. */
  readonly generationRoot: string;
};

/**
 * Materialize client directory archive members (`{index}/…`) into a new
 * generation stage directory. Does not touch other generations for the identity.
 */
export async function materializeClientDirectoryStages(options: {
  readonly identity: SandboxIdentity;
  readonly directories: readonly HostDirectoryMount[];
  readonly archive: TransferArchive;
  readonly dataRoot?: string;
  readonly signal?: AbortSignal;
  readonly generationId?: string;
}): Promise<MaterializedDirectoryStages> {
  const dataRoot = options.dataRoot ?? defaultDirectoryStageRoot();
  const generationId = options.generationId ?? randomUUID();
  const generationRoot = directoryStageGenerationRoot(options.identity, generationId, dataRoot);
  await mkdir(generationRoot, { recursive: true });

  const out: HostDirectoryMount[] = [];
  try {
    for (let i = 0; i < options.directories.length; i += 1) {
      const entry = options.directories[i]!;
      if (entry.source !== "client") {
        out.push(entry);
        continue;
      }
      const stagePath = directoryStagePathForMount(options.identity, generationId, i, dataRoot);
      const prefix = `${i}/`;
      const filteredEntries: TransferEntry[] = options.archive.entries
        .filter((e) => e.path.startsWith(prefix))
        .map((e) => {
          const rel = e.path.slice(prefix.length);
          if (rel.length === 0) {
            throw SboxError.validation("Directory stage archive member path is empty.");
          }
          return { ...e, path: rel } as TransferEntry;
        });
      await extractArchiveToDirectory(
        { version: options.archive.version, entries: filteredEntries },
        stagePath,
        options.signal,
      );
      out.push({ ...entry, bindHostPath: stagePath });
    }
    return Object.freeze({
      directories: Object.freeze(out),
      generationRoot,
    });
  } catch (error) {
    await removeDirectoryStageGeneration(generationRoot);
    throw error;
  }
}

/** Pack client directory mounts into one archive with `{index}/` prefixes. */
export async function packClientDirectoryArchive(
  directories: readonly HostDirectoryMount[],
  options?: { readonly signal?: AbortSignal },
): Promise<TransferArchive> {
  const entries: TransferEntry[] = [];
  for (let i = 0; i < directories.length; i += 1) {
    const entry = directories[i]!;
    if (entry.source !== "client") {
      continue;
    }
    await assertBindableDirectory(entry.path, `directories.${i}.path`);
    const packed = await packHostPath(
      entry.path,
      options?.signal !== undefined ? { signal: options.signal } : {},
    );
    for (const member of packed.entries) {
      entries.push({
        ...member,
        path: `${i}/${member.path}`,
      } as TransferEntry);
    }
  }
  return createTransferArchive(entries);
}
