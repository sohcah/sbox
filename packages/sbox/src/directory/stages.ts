/**
 * Materialize and clean Mount stages for remote Client-path mounts.
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
import { assertBindablePath } from "./assert-directory.js";
import type { HostMount, MountKind } from "./types.js";
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

export type MaterializedMountStages = {
  readonly mounts: readonly HostMount[];
  /** Isolated create-attempt root; delete only this on create failure. */
  readonly generationRoot: string;
};

/**
 * Materialize client mount archive members (`{index}/…`) into a new
 * generation stage directory. Does not touch other generations for the identity.
 */
export async function materializeClientMountStages(options: {
  readonly identity: SandboxIdentity;
  readonly mounts: readonly HostMount[];
  readonly archive: TransferArchive;
  readonly dataRoot?: string;
  readonly signal?: AbortSignal;
  readonly generationId?: string;
}): Promise<MaterializedMountStages> {
  const dataRoot = options.dataRoot ?? defaultDirectoryStageRoot();
  const generationId = options.generationId ?? randomUUID();
  const generationRoot = directoryStageGenerationRoot(options.identity, generationId, dataRoot);
  await mkdir(generationRoot, { recursive: true });

  const out: HostMount[] = [];
  try {
    for (let i = 0; i < options.mounts.length; i += 1) {
      const entry = options.mounts[i]!;
      if (entry.source !== "client") {
        out.push(entry);
        continue;
      }
      const kind = entry.kind;
      if (kind !== "file" && kind !== "directory") {
        throw SboxError.validation('Client Host mounts require kind "file" or "directory".', {
          details: { path: `mounts.${i}.kind` },
        });
      }
      const stagePath = directoryStagePathForMount(options.identity, generationId, i, dataRoot);
      const prefix = `${i}/`;
      const filteredEntries: TransferEntry[] = options.archive.entries
        .filter((e) => e.path.startsWith(prefix))
        .map((e) => {
          const rel = e.path.slice(prefix.length);
          if (rel.length === 0) {
            throw SboxError.validation("Mount stage archive member path is empty.");
          }
          return { ...e, path: rel } as TransferEntry;
        });

      if (kind === "file") {
        await materializeClientFileStage(filteredEntries, stagePath, options.signal);
        out.push({ ...entry, kind, bindHostPath: stagePath });
      } else {
        await extractArchiveToDirectory(
          { version: options.archive.version, entries: filteredEntries },
          stagePath,
          options.signal,
        );
        out.push({ ...entry, kind, bindHostPath: stagePath });
      }
    }
    return Object.freeze({
      mounts: Object.freeze(out),
      generationRoot,
    });
  } catch (error) {
    await removeDirectoryStageGeneration(generationRoot);
    throw error;
  }
}

async function materializeClientFileStage(
  entries: readonly TransferEntry[],
  stageFilePath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const files = entries.filter((e) => e.kind === "file");
  if (files.length !== 1 || entries.length !== 1) {
    throw SboxError.validation("Client file mount archive must contain exactly one file member.");
  }
  const file = files[0]!;
  if (file.kind !== "file") {
    throw SboxError.validation("Client file mount archive member must be a file.");
  }
  await mkdir(dirname(stageFilePath), { recursive: true });
  await writeFile(stageFilePath, file.data);
  await chmod(stageFilePath, file.mode);
}

/** Pack client Host mounts into one archive with `{index}/` prefixes. */
export async function packClientMountArchive(
  mounts: readonly HostMount[],
  options?: { readonly signal?: AbortSignal },
): Promise<{ readonly archive: TransferArchive; readonly mounts: readonly HostMount[] }> {
  const entries: TransferEntry[] = [];
  const resolved: HostMount[] = [];
  for (let i = 0; i < mounts.length; i += 1) {
    const entry = mounts[i]!;
    if (entry.source !== "client") {
      resolved.push(entry);
      continue;
    }
    const kind = await assertBindablePath(entry.path, `mounts.${i}.path`);
    if (entry.kind !== undefined && entry.kind !== kind) {
      throw SboxError.validation(
        `Host mount kind mismatch (declared ${entry.kind}, found ${kind}).`,
        { details: { path: `mounts.${i}.kind` } },
      );
    }
    resolved.push({ ...entry, kind });
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
  return {
    archive: createTransferArchive(entries),
    mounts: Object.freeze(resolved),
  };
}

/** @deprecated Use materializeClientMountStages */
export async function materializeClientDirectoryStages(options: {
  readonly identity: SandboxIdentity;
  readonly directories: readonly HostMount[];
  readonly archive: TransferArchive;
  readonly dataRoot?: string;
  readonly signal?: AbortSignal;
  readonly generationId?: string;
}): Promise<{ readonly directories: readonly HostMount[]; readonly generationRoot: string }> {
  const result = await materializeClientMountStages({
    identity: options.identity,
    mounts: options.directories,
    archive: options.archive,
    ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.generationId !== undefined ? { generationId: options.generationId } : {}),
  });
  return { directories: result.mounts, generationRoot: result.generationRoot };
}

/** @deprecated Use packClientMountArchive */
export async function packClientDirectoryArchive(
  directories: readonly HostMount[],
  options?: { readonly signal?: AbortSignal },
): Promise<TransferArchive> {
  const packed = await packClientMountArchive(directories, options);
  return packed.archive;
}

export type MaterializedDirectoryStages = MaterializedMountStages;

export type { MountKind };
