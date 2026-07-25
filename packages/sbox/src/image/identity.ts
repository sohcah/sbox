/**
 * Deterministic content-addressed image identity.
 *
 * Identity excludes absolute host paths, timestamps, secret values, Docker
 * progress, process IDs, and directory enumeration order.
 */

import { createHash, type Hash } from "node:crypto";
import { SboxError } from "../errors.js";
import {
  formatImageContentDigest,
  formatNativeImageReference,
  IMAGE_IDENTITY_ALGORITHM_VERSION,
  type ImageContentDigest,
} from "./naming.js";

export type ContextEntryKind = "file" | "directory" | "symlink";

export type ContextFileEntry = {
  readonly kind: "file";
  readonly relativePath: string;
  /** Permission bits included in identity (`mode & 0o777`). */
  readonly mode: number;
  readonly contents: Uint8Array;
};

export type ContextDirectoryEntry = {
  readonly kind: "directory";
  readonly relativePath: string;
  readonly mode: number;
};

export type ContextSymlinkEntry = {
  readonly kind: "symlink";
  readonly relativePath: string;
  /** Raw readlink target (not resolved). Must be a safe relative target. */
  readonly target: string;
};

export type ContextEntry = ContextFileEntry | ContextDirectoryEntry | ContextSymlinkEntry;

export interface ImageIdentityModel {
  readonly algorithmVersion: number;
  readonly dockerfileRelativePath: string;
  readonly dockerfileContents: Uint8Array;
  readonly platform: string;
  readonly target: string;
  readonly args: Readonly<Record<string, string>>;
  /** Declared secret ids only — never secret values. */
  readonly secretIds: readonly string[];
  readonly includeGit: boolean;
  readonly entries: readonly ContextEntry[];
}

export interface ImageContentIdentity {
  readonly algorithmVersion: typeof IMAGE_IDENTITY_ALGORITHM_VERSION;
  readonly digestHex: string;
  readonly contentIdentity: ImageContentDigest;
  readonly nativeReference: string;
}

const encoder = new TextEncoder();

export function compareRelativePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function permissionBits(mode: number): number {
  return mode & 0o777;
}

export function computeImageContentIdentity(model: ImageIdentityModel): ImageContentIdentity {
  const hash = createHash("sha256");
  writeField(hash, "sbox-image-identity", "version", String(model.algorithmVersion));
  writeField(hash, "dockerfile", model.dockerfileRelativePath);
  writeField(hash, "dockerfile-bytes", String(model.dockerfileContents.byteLength));
  hash.update(model.dockerfileContents);
  writeNull(hash);
  writeField(hash, "platform", model.platform);
  writeField(hash, "target", model.target);
  writeField(hash, "include-git", model.includeGit ? "1" : "0");

  const argKeys = Object.keys(model.args).toSorted(compareRelativePaths);
  for (const key of argKeys) {
    writeField(hash, "build-arg", key, model.args[key] ?? "");
  }
  writeField(hash, "build-args-end");

  for (const secretId of [...model.secretIds].toSorted(compareRelativePaths)) {
    writeField(hash, "build-secret-id", secretId);
  }
  writeField(hash, "build-secrets-end");

  const entries = [...model.entries].toSorted((left, right) =>
    compareRelativePaths(left.relativePath, right.relativePath),
  );
  for (const entry of entries) {
    switch (entry.kind) {
      case "file": {
        writeField(
          hash,
          "file",
          entry.relativePath,
          modeOctal(entry.mode),
          String(entry.contents.byteLength),
        );
        hash.update(entry.contents);
        writeNull(hash);
        break;
      }
      case "directory": {
        writeField(hash, "directory", entry.relativePath, modeOctal(entry.mode));
        break;
      }
      case "symlink": {
        writeField(hash, "symlink", entry.relativePath, entry.target);
        break;
      }
      default: {
        const exhaustive: never = entry;
        throw SboxError.internal("Unknown context entry kind.", {
          details: { entry: exhaustive },
        });
      }
    }
  }
  writeField(hash, "entries-end");

  const digestHex = hash.digest("hex");
  return {
    algorithmVersion: IMAGE_IDENTITY_ALGORITHM_VERSION,
    digestHex,
    contentIdentity: formatImageContentDigest(digestHex),
    nativeReference: formatNativeImageReference(digestHex),
  };
}

function modeOctal(mode: number): string {
  return permissionBits(mode).toString(8).padStart(3, "0");
}

function writeNull(hash: Hash): void {
  hash.update(new Uint8Array([0]));
}

function writeField(hash: Hash, ...parts: readonly string[]): void {
  for (const part of parts) {
    const bytes = encoder.encode(part);
    hash.update(encoder.encode(`${bytes.byteLength}:`));
    hash.update(bytes);
  }
  writeNull(hash);
}
