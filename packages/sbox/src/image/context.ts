/**
 * Docker-compatible build-context discovery.
 *
 * Applies `.dockerignore` / Dockerfile-specific ignore files, default `.git`
 * exclusion (with explicit opt-in), and rejects escaping/absolute symlinks and
 * special files. Symlinks are recorded, not followed.
 */

import { lstat, open, readFile, readlink, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { SboxError, throwIfAborted } from "../errors.js";
import { compareRelativePaths, permissionBits, type ContextEntry } from "./identity.js";

export interface DiscoverContextOptions {
  readonly contextRoot: string;
  /** Dockerfile path relative to context (POSIX). */
  readonly dockerfile: string;
  readonly includeGit: boolean;
  readonly signal?: AbortSignal;
}

export interface DiscoveredBuildContext {
  readonly contextRoot: string;
  readonly dockerfileRelativePath: string;
  readonly dockerfileContents: Uint8Array;
  readonly entries: readonly ContextEntry[];
  readonly ignoreSource: "dockerfile-specific" | "dockerignore" | "none";
}

export async function discoverBuildContext(
  options: DiscoverContextOptions,
): Promise<DiscoveredBuildContext> {
  throwIfAborted(options.signal);
  const contextRoot = resolve(options.contextRoot);
  const dockerfileRelativePath = normalizePosixRelative(options.dockerfile);
  assertInsideContext(contextRoot, join(contextRoot, ...dockerfileRelativePath.split("/")));

  const dockerfileAbs = join(contextRoot, ...dockerfileRelativePath.split("/"));
  let dockerfileStat;
  try {
    dockerfileStat = await lstat(dockerfileAbs);
  } catch (error) {
    throw SboxError.validation("Dockerfile was not found inside the build context.", {
      cause: error,
      details: { path: "build.dockerfile" },
    });
  }
  if (!dockerfileStat.isFile()) {
    throw SboxError.validation("Dockerfile path must be a regular file.", {
      details: { path: "build.dockerfile" },
    });
  }

  const ignoreLoaded = await loadIgnoreRules(contextRoot, dockerfileRelativePath);
  const ig = ignore().add(ignoreLoaded.patterns);
  if (!options.includeGit) {
    ig.add([".git", ".git/**"]);
  }

  const entries: ContextEntry[] = [];
  await walkContext(contextRoot, "", ig, entries, options.signal);

  // Dockerfile must remain selected even if ignore patterns would exclude it.
  const dockerfileEntry = entries.find(
    (entry) => entry.kind === "file" && entry.relativePath === dockerfileRelativePath,
  );
  if (dockerfileEntry === undefined) {
    const contents = new Uint8Array(await readFile(dockerfileAbs));
    entries.push({
      kind: "file",
      relativePath: dockerfileRelativePath,
      mode: permissionBits(dockerfileStat.mode),
      contents,
    });
  }

  entries.sort((left, right) => compareRelativePaths(left.relativePath, right.relativePath));

  const dockerfileContents =
    dockerfileEntry !== undefined && dockerfileEntry.kind === "file"
      ? dockerfileEntry.contents
      : new Uint8Array(await readFile(dockerfileAbs));

  return {
    contextRoot,
    dockerfileRelativePath,
    dockerfileContents,
    entries,
    ignoreSource: ignoreLoaded.source,
  };
}

async function loadIgnoreRules(
  contextRoot: string,
  dockerfileRelativePath: string,
): Promise<{
  readonly patterns: readonly string[];
  readonly source: "dockerfile-specific" | "dockerignore" | "none";
}> {
  const specificName = `${dockerfileRelativePath}.dockerignore`;
  const specificAbs = join(contextRoot, ...specificName.split("/"));
  const specific = await readIgnoreFile(specificAbs);
  if (specific !== undefined) {
    return { patterns: specific, source: "dockerfile-specific" };
  }
  const generic = await readIgnoreFile(join(contextRoot, ".dockerignore"));
  if (generic !== undefined) {
    return { patterns: generic, source: "dockerignore" };
  }
  return { patterns: [], source: "none" };
}

async function readIgnoreFile(path: string): Promise<readonly string[] | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return undefined;
    }
    throw SboxError.validation("Failed to read dockerignore file.", {
      cause: error,
      details: { path: "build.context" },
    });
  }
}

async function walkContext(
  absoluteDir: string,
  relativeDir: string,
  ig: ignore.Ignore,
  entries: ContextEntry[],
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  let dirents;
  try {
    dirents = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    throw SboxError.validation("Failed to read build context directory.", {
      cause: error,
      details: { path: "build.context" },
    });
  }

  // Deterministic enumeration order.
  dirents.sort((left, right) => compareRelativePaths(left.name, right.name));

  for (const dirent of dirents) {
    throwIfAborted(signal);
    const name = dirent.name;
    const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`;
    const absolutePath = join(absoluteDir, name);

    // ignore matches paths relative to context; directories use trailing slash convention optionally.
    if (ig.ignores(relativePath) || (dirent.isDirectory() && ig.ignores(`${relativePath}/`))) {
      continue;
    }

    let stat;
    try {
      stat = await lstat(absolutePath);
    } catch (error) {
      throw SboxError.validation("Failed to stat build context entry.", {
        cause: error,
        details: { path: "build.context" },
      });
    }

    if (stat.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      assertSafeSymlinkTarget(relativePath, target);
      entries.push({
        kind: "symlink",
        relativePath,
        target,
      });
      continue;
    }

    if (stat.isDirectory()) {
      entries.push({
        kind: "directory",
        relativePath,
        mode: permissionBits(stat.mode),
      });
      await walkContext(absolutePath, relativePath, ig, entries, signal);
      continue;
    }

    if (stat.isFile()) {
      const contents = await readFileLimited(absolutePath, signal);
      entries.push({
        kind: "file",
        relativePath,
        mode: permissionBits(stat.mode),
        contents,
      });
      continue;
    }

    throw SboxError.validation(
      "Build context contains an unsupported special file (device, socket, FIFO, or other).",
      {
        details: { path: "build.context", relativePath },
      },
    );
  }
}

async function readFileLimited(path: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
  throwIfAborted(signal);
  // Stream through open/readFile — Node readFile is fine for unit contexts.
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw SboxError.validation("Build context path is not a regular file.", {
        details: { path: "build.context" },
      });
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return new Uint8Array(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

export function assertSafeSymlinkTarget(relativePath: string, target: string): void {
  if (target.length === 0) {
    throw SboxError.validation("Build context symlink target is empty.", {
      details: { path: "build.context", relativePath },
    });
  }
  if (target.includes("\0")) {
    throw SboxError.validation("Build context symlink target contains a NUL byte.", {
      details: { path: "build.context", relativePath },
    });
  }
  // Absolute links (POSIX or Windows) are rejected for portable transfer of context.
  if (
    target.startsWith("/") ||
    target.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(target) ||
    target.startsWith("\\\\")
  ) {
    throw SboxError.validation("Build context symlink target must be relative.", {
      details: { path: "build.context", relativePath },
    });
  }
  const parts = target.replace(/\\/g, "/").split("/");
  let depth = relativePath.split("/").length - 1;
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      depth -= 1;
      if (depth < 0) {
        throw SboxError.validation("Build context symlink escapes the context root.", {
          details: { path: "build.context", relativePath },
        });
      }
      continue;
    }
    depth += 1;
  }
}

export function normalizePosixRelative(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw SboxError.validation("Expected a normalized relative POSIX path inside the context.", {
      details: { path: "build.dockerfile" },
    });
  }
  return normalized;
}

export function assertInsideContext(contextRoot: string, candidate: string): void {
  const root = resolve(contextRoot);
  const abs = resolve(candidate);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith("..")) {
    if (abs !== root && (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(".."))) {
      throw SboxError.validation("Path escapes the build context root.", {
        details: { path: "build.context" },
      });
    }
  }
  if (rel.startsWith(`..${sep}`) || rel === "..") {
    throw SboxError.validation("Path escapes the build context root.", {
      details: { path: "build.context" },
    });
  }
}

/** Materialize discovered entries under a destination directory (for Docker). */
export async function materializeContextEntries(
  destinationRoot: string,
  entries: readonly ContextEntry[],
  signal?: AbortSignal,
): Promise<void> {
  const { mkdir, symlink, writeFile, chmod } = await import("node:fs/promises");
  const directories: Array<{ relativePath: string; mode: number }> = [];

  // Create tree first so restrictive parent modes do not block children.
  for (const entry of entries) {
    throwIfAborted(signal);
    const dest = join(destinationRoot, ...entry.relativePath.split("/"));
    switch (entry.kind) {
      case "directory": {
        await mkdir(dest, { recursive: true });
        directories.push({ relativePath: entry.relativePath, mode: entry.mode });
        break;
      }
      case "file": {
        await mkdir(join(dest, ".."), { recursive: true });
        await writeFile(dest, entry.contents);
        try {
          await chmod(dest, entry.mode);
        } catch (error) {
          throw SboxError.internal("Failed to apply file mode while materializing build context.", {
            cause: error,
            details: { relativePath: entry.relativePath },
          });
        }
        break;
      }
      case "symlink": {
        await mkdir(join(dest, ".."), { recursive: true });
        await symlink(entry.target, dest);
        break;
      }
    }
  }

  // Apply directory modes deepest-first after children exist.
  directories.sort((left, right) => {
    const depth = right.relativePath.split("/").length - left.relativePath.split("/").length;
    if (depth !== 0) {
      return depth;
    }
    return compareRelativePaths(right.relativePath, left.relativePath);
  });
  for (const entry of directories) {
    throwIfAborted(signal);
    const dest = join(destinationRoot, ...entry.relativePath.split("/"));
    try {
      await chmod(dest, entry.mode);
    } catch (error) {
      throw SboxError.internal(
        "Failed to apply directory mode while materializing build context.",
        {
          cause: error,
          details: { relativePath: entry.relativePath },
        },
      );
    }
  }
}
