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
  realpath,
  rm,
  stat,
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
import { assertRelativeTransferPath, isSafeSymlinkTarget } from "../transfer/paths.js";

export type PackHostPathOptions = {
  readonly signal?: AbortSignal;
  /**
   * When true, absolute or transfer-root-escaping symlinks are dereferenced and
   * their target content is packed (files/dirs) instead of preserved as links.
   * Safe relative links inside the root are still preserved.
   */
  readonly followEscapingSymlinks?: boolean;
};

export async function packHostPath(
  hostPath: string,
  options?: PackHostPathOptions,
): Promise<TransferArchive> {
  throwIfAborted(options?.signal);
  const root = resolve(hostPath);
  const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw SboxError.notFound("Host path was not found.", { details: { path: "hostPath" } });
    }
    throw SboxError.validation("Host path is not readable.", {
      cause: error,
      details: { path: "hostPath" },
    });
  });

  const entries: TransferEntry[] = [];
  const follow = options?.followEscapingSymlinks === true;
  const visited = new Set<string>();

  if (rootStat.isSymbolicLink()) {
    if (follow) {
      await packFollowedSymlink(root, "payload", entries, options?.signal, visited);
    } else {
      const target = await readlink(root);
      entries.push({ kind: "symlink", path: "payload", target });
    }
  } else if (rootStat.isFile()) {
    entries.push({
      kind: "file",
      path: "payload",
      mode: permissionBits(rootStat.mode),
      data: new Uint8Array(await readFile(root)),
    });
  } else if (rootStat.isDirectory()) {
    await walkRootDir(root, entries, options?.signal, follow, visited);
  } else {
    throw SboxError.validation("Host path kind is not supported for remote transfer.", {
      details: { path: "hostPath" },
    });
  }
  return createTransferArchive(entries);
}

async function walkRootDir(
  root: string,
  entries: TransferEntry[],
  signal: AbortSignal | undefined,
  followEscapingSymlinks: boolean,
  visited: Set<string>,
): Promise<void> {
  throwIfAborted(signal);
  const names = await readdir(root);
  for (const name of names) {
    await packPathEntry(join(root, name), name, entries, signal, followEscapingSymlinks, visited);
  }
}

/**
 * Walk an already-resolved directory whose content is placed at `archiveRel`
 * (used after following an escaping symlink to a directory).
 */
async function walkResolvedDir(
  realDir: string,
  archiveRel: string,
  entries: TransferEntry[],
  signal: AbortSignal | undefined,
  followEscapingSymlinks: boolean,
  visited: Set<string>,
): Promise<void> {
  throwIfAborted(signal);
  const names = await readdir(realDir);
  for (const name of names) {
    const childAbs = join(realDir, name);
    const childRel = `${archiveRel}/${name}`;
    await packPathEntry(childAbs, childRel, entries, signal, followEscapingSymlinks, visited);
  }
}

async function packPathEntry(
  absPath: string,
  archiveRel: string,
  entries: TransferEntry[],
  signal: AbortSignal | undefined,
  followEscapingSymlinks: boolean,
  visited: Set<string>,
): Promise<void> {
  throwIfAborted(signal);
  const st = await lstat(absPath);
  if (st.isSymbolicLink()) {
    const target = await readlink(absPath);
    const linkDir = archiveRel.includes("/")
      ? archiveRel.slice(0, archiveRel.lastIndexOf("/"))
      : "";
    const linkDirPosix = linkDir === "" ? "/" : `/${linkDir}`;
    if (isSafeSymlinkTarget(target, linkDirPosix, "/")) {
      entries.push({
        kind: "symlink",
        path: assertRelativeTransferPath(archiveRel, "archive member path"),
        target,
      });
      return;
    }
    if (followEscapingSymlinks) {
      await packFollowedSymlink(absPath, archiveRel, entries, signal, visited);
      return;
    }
    entries.push({
      kind: "symlink",
      path: assertRelativeTransferPath(archiveRel, "archive member path"),
      target,
    });
    return;
  }
  if (st.isDirectory()) {
    // walkDir expects join(root, rel) === absPath; use absPath as root with empty-relative walk
    // via walkResolvedDir after recording the directory entry.
    entries.push({
      kind: "directory",
      path: assertRelativeTransferPath(archiveRel, "archive member path"),
      mode: permissionBits(st.mode),
    });
    await walkResolvedDir(absPath, archiveRel, entries, signal, followEscapingSymlinks, visited);
    return;
  }
  if (st.isFile()) {
    entries.push({
      kind: "file",
      path: assertRelativeTransferPath(archiveRel, "archive member path"),
      mode: permissionBits(st.mode),
      data: new Uint8Array(await readFile(absPath)),
    });
    return;
  }
  throw SboxError.validation("Special files are not supported in remote transfer.", {
    details: { path: archiveRel },
  });
}

async function packFollowedSymlink(
  linkPath: string,
  archiveRel: string,
  entries: TransferEntry[],
  signal: AbortSignal | undefined,
  visited: Set<string>,
): Promise<void> {
  throwIfAborted(signal);
  let resolved: string;
  try {
    resolved = await realpath(linkPath);
  } catch (error) {
    throw SboxError.validation("Escaping symlink target could not be resolved.", {
      cause: error,
      details: { path: archiveRel },
    });
  }
  if (visited.has(resolved)) {
    throw SboxError.validation("Symlink cycle detected while following escaping links.", {
      details: { path: archiveRel },
    });
  }
  visited.add(resolved);

  const st = await stat(linkPath).catch((error: NodeJS.ErrnoException) => {
    throw SboxError.validation("Escaping symlink target is not readable.", {
      cause: error,
      details: { path: archiveRel },
    });
  });

  if (st.isFile()) {
    entries.push({
      kind: "file",
      path: assertRelativeTransferPath(archiveRel, "archive member path"),
      mode: permissionBits(st.mode),
      data: new Uint8Array(await readFile(resolved)),
    });
    return;
  }
  if (st.isDirectory()) {
    entries.push({
      kind: "directory",
      path: assertRelativeTransferPath(archiveRel, "archive member path"),
      mode: permissionBits(st.mode),
    });
    // Nested escaping links under the followed tree are also dereferenced.
    await walkResolvedDir(resolved, archiveRel, entries, signal, true, visited);
    return;
  }
  throw SboxError.validation("Escaping symlink target kind is not supported for transfer.", {
    details: { path: archiveRel },
  });
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
