/**
 * Marked operation workspaces for image builds.
 *
 * Workspaces live under a narrowly scoped sbox-owned root. Cleanup is exact-path
 * only and requires an ownership marker. Stale diagnostics are read-only.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SboxError, throwIfAborted } from "../errors.js";
import type { StaleImageWorkspace } from "./types.js";

export const WORKSPACE_MARKER_NAME = ".sbox-image-workspace";
export const WORKSPACE_MARKER_VALUE = "dev.sohcah.sbox/image-workspace/v1";

export function defaultImageWorkspaceRoot(): string {
  const override = process.env["SBOX_IMAGE_WORKSPACE_ROOT"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  // Prefer a stable user-local location when home is available; fall back to tmp.
  try {
    return join(homedir(), ".sbox", "image-workspaces");
  } catch {
    return join(tmpdir(), "sbox-image-workspaces");
  }
}

export interface ImageWorkspace {
  readonly root: string;
  readonly contextDir: string;
  readonly secretsDir: string;
  readonly exportPath: string;
}

export async function createImageWorkspace(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<ImageWorkspace> {
  throwIfAborted(signal);
  await mkdir(workspaceRoot, { recursive: true });
  const name = `op-${process.pid}-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
  const root = join(workspaceRoot, name);
  await mkdir(root, { recursive: false });
  await writeFile(join(root, WORKSPACE_MARKER_NAME), `${WORKSPACE_MARKER_VALUE}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const contextDir = join(root, "context");
  const secretsDir = join(root, "secrets");
  await mkdir(contextDir, { recursive: true });
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  return {
    root,
    contextDir,
    secretsDir,
    exportPath: join(root, "export.tar"),
  };
}

/**
 * Exact-path cleanup. Refuses to delete paths that lack the ownership marker.
 */
export async function cleanupImageWorkspace(workspaceRootPath: string): Promise<void> {
  const markerPath = join(workspaceRootPath, WORKSPACE_MARKER_NAME);
  let marker: string;
  try {
    marker = await readFile(markerPath, "utf8");
  } catch {
    throw SboxError.ownershipConflict(
      "Refusing to delete an image workspace without a valid ownership marker.",
      { details: { path: workspaceRootPath } },
    );
  }
  if (!marker.startsWith(WORKSPACE_MARKER_VALUE)) {
    throw SboxError.ownershipConflict(
      "Refusing to delete an image workspace with an invalid ownership marker.",
      { details: { path: workspaceRootPath } },
    );
  }
  await rm(workspaceRootPath, { recursive: true, force: true });
}

/** Read-only stale workspace diagnostics. Never mutates. */
export async function listStaleImageWorkspaces(
  workspaceRoot: string = defaultImageWorkspaceRoot(),
): Promise<readonly StaleImageWorkspace[]> {
  let names: string[];
  try {
    names = await readdir(workspaceRoot);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw SboxError.internal("Failed to list image workspaces.", { cause: error });
  }

  const out: StaleImageWorkspace[] = [];
  for (const name of names.toSorted()) {
    const path = join(workspaceRoot, name);
    let markerPresent = false;
    let createdAt: string | undefined;
    try {
      const st = await stat(path);
      if (!st.isDirectory()) {
        continue;
      }
      createdAt = st.birthtime.toISOString();
    } catch {
      continue;
    }
    try {
      const marker = await readFile(join(path, WORKSPACE_MARKER_NAME), "utf8");
      markerPresent = marker.startsWith(WORKSPACE_MARKER_VALUE);
    } catch {
      markerPresent = false;
    }
    out.push({
      path,
      ...(createdAt !== undefined ? { createdAt } : {}),
      markerPresent,
    });
  }
  return out;
}
