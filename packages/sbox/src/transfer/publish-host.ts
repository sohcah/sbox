/**
 * Host-side atomic publication helpers for transfer destinations.
 *
 * Staging always happens beside the final path so rename stays on the same
 * filesystem. The original destination is preserved until publication succeeds.
 *
 * Root directory modes must be applied via `beforeCommit` (after rename, before
 * discarding the backup): chmod'ing a staging directory to a restrictive mode
 * and then renaming it fails with EACCES on Darwin, even though Unix rename is
 * normally gated only by the parent.
 */

import { randomBytes } from "node:crypto";
import type { PathLike } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SboxError } from "../errors.js";

export function stagingNameBeside(destPath: string, kind: "file" | "dir"): string {
  const parent = dirname(destPath);
  const base = basename(destPath) || "root";
  const token = randomBytes(8).toString("hex");
  if (kind === "dir") {
    return join(parent, `.sbox-stage-${base}-${process.pid}-${token}`);
  }
  return join(parent, `.sbox-tmp-${base}-${process.pid}-${token}`);
}

export function backupNameBeside(destPath: string): string {
  const parent = dirname(destPath);
  const base = basename(destPath) || "root";
  const token = randomBytes(8).toString("hex");
  return join(parent, `.sbox-bak-${base}-${process.pid}-${token}`);
}

/**
 * Publish a fully-prepared staging path onto `destPath` via same-FS rename.
 * When `destExists`, moves the live destination aside first and restores it if
 * the staging rename or `beforeCommit` fails.
 *
 * `beforeCommit` runs after the destination is renamed into place but before the
 * previous destination backup is discarded, so callers can apply a final root
 * mode without violating atomic publication.
 */
export async function publishHostPath(args: {
  readonly stagingPath: string;
  readonly destPath: string;
  readonly destExists: boolean;
  readonly remove: (path: string, recursive: boolean) => Promise<void>;
  readonly rename?: (from: PathLike, to: PathLike) => Promise<void>;
  readonly beforeCommit?: (destPath: string) => Promise<void>;
}): Promise<void> {
  const { stagingPath, destPath, destExists, remove } = args;
  const doRename = args.rename ?? rename;
  const beforeCommit = args.beforeCommit;

  if (!destExists) {
    try {
      await doRename(stagingPath, destPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EXDEV") {
        throw SboxError.internal("Transfer staging and destination are on different filesystems.", {
          cause: error,
          details: { path: "hostPath" },
        });
      }
      throw error;
    }
    try {
      await beforeCommit?.(destPath);
    } catch (error) {
      await remove(destPath, true).catch(() => undefined);
      throw error;
    }
    return;
  }

  const backup = backupNameBeside(destPath);
  try {
    await doRename(destPath, backup);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EXDEV") {
      throw SboxError.internal("Transfer staging and destination are on different filesystems.", {
        cause: error,
        details: { path: "hostPath" },
      });
    }
    throw error;
  }

  try {
    await doRename(stagingPath, destPath);
  } catch (error) {
    try {
      await doRename(backup, destPath);
    } catch (restoreError) {
      throw SboxError.internal("Failed to publish transfer and restore the previous destination.", {
        cause: restoreError,
        details: { path: "hostPath" },
      });
    }
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EXDEV") {
      throw SboxError.internal("Transfer staging and destination are on different filesystems.", {
        cause: error,
        details: { path: "hostPath" },
      });
    }
    throw error;
  }

  try {
    await beforeCommit?.(destPath);
  } catch (error) {
    await remove(destPath, true).catch(() => undefined);
    try {
      await doRename(backup, destPath);
    } catch (restoreError) {
      throw SboxError.internal(
        "Failed to apply transfer finalization and restore the previous destination.",
        {
          cause: restoreError,
          details: { path: "hostPath" },
        },
      );
    }
    throw error;
  }

  await remove(backup, true).catch(() => undefined);
}

export async function removePathQuiet(path: string, recursive: boolean): Promise<void> {
  await rm(path, { recursive, force: true });
}
