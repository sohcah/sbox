/**
 * Materialize / collect host trees as TransferArchive for remote copy & builds.
 */

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { SboxError, throwIfAborted } from "../errors.js";
import {
  createTransferArchive,
  permissionBits,
  type TransferArchive,
  type TransferEntry,
} from "../transfer/archive.js";
import { assertRelativeTransferPath } from "../transfer/paths.js";

export async function packHostPath(
  hostPath: string,
  options?: { readonly signal?: AbortSignal },
): Promise<TransferArchive> {
  throwIfAborted(options?.signal);
  const root = resolve(hostPath);
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw SboxError.notFound("Host path was not found.", { details: { path: "hostPath" } });
    }
    throw SboxError.validation("Host path is not readable.", {
      cause: error,
      details: { path: "hostPath" },
    });
  });

  const entries: TransferEntry[] = [];
  if (stat.isSymbolicLink()) {
    const target = await readlink(root);
    entries.push({ kind: "symlink", path: "payload", target });
  } else if (stat.isFile()) {
    entries.push({
      kind: "file",
      path: "payload",
      mode: permissionBits(stat.mode),
      data: new Uint8Array(await readFile(root)),
    });
  } else if (stat.isDirectory()) {
    await walkDir(root, "", entries, options?.signal);
  } else {
    throw SboxError.validation("Host path kind is not supported for remote transfer.", {
      details: { path: "hostPath" },
    });
  }
  return createTransferArchive(entries);
}

async function walkDir(
  root: string,
  rel: string,
  entries: TransferEntry[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const abs = rel === "" ? root : join(root, ...rel.split("/"));
  const names = await readdir(abs);
  if (rel !== "") {
    const st = await lstat(abs);
    entries.push({
      kind: "directory",
      path: assertRelativeTransferPath(rel, "archive member path"),
      mode: permissionBits(st.mode),
    });
  }
  for (const name of names) {
    const childRel = rel === "" ? name : `${rel}/${name}`;
    const childAbs = join(root, ...childRel.split("/"));
    const st = await lstat(childAbs);
    if (st.isSymbolicLink()) {
      entries.push({
        kind: "symlink",
        path: assertRelativeTransferPath(childRel, "archive member path"),
        target: await readlink(childAbs),
      });
    } else if (st.isDirectory()) {
      await walkDir(root, childRel, entries, signal);
    } else if (st.isFile()) {
      entries.push({
        kind: "file",
        path: assertRelativeTransferPath(childRel, "archive member path"),
        mode: permissionBits(st.mode),
        data: new Uint8Array(await readFile(childAbs)),
      });
    } else {
      throw SboxError.validation("Special files are not supported in remote transfer.", {
        details: { path: childRel },
      });
    }
  }
}

export async function materializeArchive(
  archive: TransferArchive,
  options?: { readonly signal?: AbortSignal },
): Promise<string> {
  throwIfAborted(options?.signal);
  const dir = await mkdtemp(join(tmpdir(), "sbox-remote-"));
  try {
    for (const entry of archive.entries) {
      throwIfAborted(options?.signal);
      const path = join(dir, ...entry.path.split("/"));
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
    if (archive.entries.length === 1 && archive.entries[0]?.path === "payload") {
      return join(dir, "payload");
    }
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeMaterialized(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  const parent = dirname(path);
  if (parent.includes(`${sep}sbox-remote-`) || /sbox-remote-/.test(parent)) {
    await rm(parent, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function relativeUnder(root: string, candidate: string): string {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel.startsWith("..") || rel === "") {
    throw SboxError.internal("Path escaped materialization root.");
  }
  return rel.split(sep).join("/");
}
