/**
 * Bounded, validated transfer archive helpers.
 *
 * Used when recursive transfer needs a portable package. Entries are validated
 * at every trust boundary: no `..`, no absolute member paths, no special files,
 * and symlinks must not escape the archive root.
 */

import { SboxError } from "../errors.js";
import { assertRelativeTransferPath, isSafeSymlinkTarget } from "./paths.js";

export const ARCHIVE_FORMAT_VERSION = 1 as const;

export type TransferEntryKind = "file" | "directory" | "symlink";

export interface TransferFileEntry {
  readonly kind: "file";
  readonly path: string;
  readonly mode: number;
  readonly data: Uint8Array;
}

export interface TransferDirectoryEntry {
  readonly kind: "directory";
  readonly path: string;
  readonly mode: number;
}

export interface TransferSymlinkEntry {
  readonly kind: "symlink";
  readonly path: string;
  readonly target: string;
}

export type TransferEntry = TransferFileEntry | TransferDirectoryEntry | TransferSymlinkEntry;

export interface TransferArchive {
  readonly version: typeof ARCHIVE_FORMAT_VERSION;
  readonly entries: readonly TransferEntry[];
}

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface ArchiveBounds {
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
}

export function createTransferArchive(
  entries: readonly TransferEntry[],
  bounds: ArchiveBounds = {},
): TransferArchive {
  validateEntries(entries, bounds);
  return {
    version: ARCHIVE_FORMAT_VERSION,
    entries: Object.freeze([...entries]),
  };
}

export function validateEntries(
  entries: readonly TransferEntry[],
  bounds: ArchiveBounds = {},
): void {
  const maxEntries = bounds.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = bounds.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (entries.length > maxEntries) {
    throw SboxError.validation("Transfer archive exceeds the entry limit.", {
      details: { maxEntries, entryCount: entries.length },
    });
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = assertRelativeTransferPath(entry.path, "archive member path");
    if (seen.has(path)) {
      throw SboxError.validation("Transfer archive contains duplicate paths.", {
        details: { path: "archive" },
      });
    }
    seen.add(path);

    if (entry.kind === "file") {
      totalBytes += entry.data.byteLength;
      if (totalBytes > maxTotalBytes) {
        throw SboxError.validation("Transfer archive exceeds the byte limit.", {
          details: { maxTotalBytes, totalBytes },
        });
      }
      assertMode(entry.mode);
    } else if (entry.kind === "directory") {
      assertMode(entry.mode);
    } else if (entry.kind === "symlink") {
      if (entry.target.includes("\0")) {
        throw SboxError.validation("Symlink target must not contain NUL.", {
          details: { path: "archive" },
        });
      }
      const linkDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      // Relative archive root is mapped to "/".
      if (!isSafeSymlinkTarget(entry.target, linkDir === "" ? "/" : `/${linkDir}`, "/")) {
        // Escape check against archive-relative resolution under virtual root.
        if (entry.target.startsWith("/") || entry.target.split("/").includes("..")) {
          const escaped = symlinkEscapesArchive(entry.target, linkDir);
          if (escaped) {
            throw SboxError.validation("Symlink target escapes the transfer root.", {
              details: { path: "archive" },
            });
          }
        }
      }
    } else {
      throw SboxError.validation("Transfer archive contains an unsupported entry kind.", {
        details: { path: "archive" },
      });
    }
  }
}

function assertMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw SboxError.validation("Transfer entry mode is invalid.", {
      details: { path: "archive" },
    });
  }
}

function symlinkEscapesArchive(target: string, linkDir: string): boolean {
  if (target.startsWith("/")) {
    return true;
  }
  const base = linkDir === "" ? [] : linkDir.split("/");
  const parts = [...base];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return true;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return false;
}

/** Executable bits from a POSIX mode. */
export function executableBits(mode: number): number {
  return mode & 0o111;
}

/** Permission bits preserved across transfer (no ownership bits). */
export function permissionBits(mode: number): number {
  return mode & 0o777;
}
