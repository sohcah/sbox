/**
 * Wire codec for TransferArchive (JSON + base64 file payloads).
 */

import { SboxError } from "../errors.js";
import {
  createTransferArchive,
  type TransferArchive,
  type TransferEntry,
} from "../transfer/archive.js";
import { base64ToBytes, bytesToBase64 } from "./bytes.js";

interface WireFile {
  readonly kind: "file";
  readonly path: string;
  readonly mode: number;
  readonly data: string;
}

interface WireDirectory {
  readonly kind: "directory";
  readonly path: string;
  readonly mode: number;
}

interface WireSymlink {
  readonly kind: "symlink";
  readonly path: string;
  readonly target: string;
}

type WireEntry = WireFile | WireDirectory | WireSymlink;

interface WireArchive {
  readonly version: 1;
  readonly entries: readonly WireEntry[];
}

export function encodeTransferArchive(archive: TransferArchive): Buffer {
  const wire: WireArchive = {
    version: 1,
    entries: archive.entries.map((entry): WireEntry => {
      if (entry.kind === "file") {
        return {
          kind: "file",
          path: entry.path,
          mode: entry.mode,
          data: bytesToBase64(entry.data),
        };
      }
      if (entry.kind === "directory") {
        return { kind: "directory", path: entry.path, mode: entry.mode };
      }
      return { kind: "symlink", path: entry.path, target: entry.target };
    }),
  };
  return Buffer.from(JSON.stringify(wire), "utf8");
}

export function decodeTransferArchive(buffer: Buffer): TransferArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw SboxError.validation("Transfer archive JSON was malformed.", { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw SboxError.validation("Transfer archive shape is invalid.");
  }
  const entries: TransferEntry[] = [];
  for (const entry of (parsed as WireArchive).entries) {
    if (entry.kind === "file") {
      entries.push({
        kind: "file",
        path: entry.path,
        mode: entry.mode,
        data: base64ToBytes(entry.data),
      });
      continue;
    }
    if (entry.kind === "directory") {
      entries.push({ kind: "directory", path: entry.path, mode: entry.mode });
      continue;
    }
    if (entry.kind === "symlink") {
      entries.push({ kind: "symlink", path: entry.path, target: entry.target });
      continue;
    }
    throw SboxError.validation("Transfer archive contains an unsupported entry kind.");
  }
  return createTransferArchive(entries);
}
