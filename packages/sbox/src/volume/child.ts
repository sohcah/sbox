/**
 * Direct child QCOW2 overlay create / validate / cleanup.
 */

import { mkdir, rm, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { SboxError, throwIfAborted } from "../errors.js";
import {
  childOverlayPath,
  defaultVolumeDataRoot,
  isManagedChildOverlayPath,
  volumePaths,
} from "./paths.js";
import {
  assertChildQcow2Info,
  qemuImgCreateOverlay,
  qemuImgInfo,
  type QemuImgPorts,
} from "./qemu-img.js";

export interface EnsureChildOverlayRequest {
  readonly project: string;
  readonly volume: string;
  readonly instance: string;
  readonly sizeBytes: number;
  readonly dataRoot?: string;
  readonly qemuImg?: QemuImgPorts;
  readonly signal?: AbortSignal;
}

export async function ensureChildOverlay(request: EnsureChildOverlayRequest): Promise<string> {
  throwIfAborted(request.signal);
  const dataRoot = request.dataRoot ?? defaultVolumeDataRoot();
  const paths = volumePaths(request.project, request.volume, dataRoot);
  const childPath = childOverlayPath(request.project, request.volume, request.instance, dataRoot);

  await mkdir(dirname(childPath), { recursive: true });

  const exists = await pathExists(childPath);
  if (exists) {
    const info = await qemuImgInfo(childPath, request.qemuImg, request.signal);
    assertChildQcow2Info(info, request.sizeBytes, paths.basePath, childPath);
    return childPath;
  }

  await qemuImgCreateOverlay(
    childPath,
    paths.basePath,
    request.sizeBytes,
    request.qemuImg,
    request.signal,
  );
  const info = await qemuImgInfo(childPath, request.qemuImg, request.signal);
  try {
    assertChildQcow2Info(info, request.sizeBytes, paths.basePath, childPath);
  } catch (error) {
    await rm(childPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return childPath;
}

export async function removeChildOverlay(
  project: string,
  volume: string,
  instance: string,
  dataRoot: string = defaultVolumeDataRoot(),
): Promise<void> {
  const childPath = childOverlayPath(project, volume, instance, dataRoot);
  await rm(childPath, { force: true });
  // Best-effort remove empty instance directory (never the volume root / base).
  await rm(dirname(childPath), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Delete a host path only when it is exactly the deterministic child overlay.
 * Never deletes a managed base or volume root.
 */
export async function removeHostOverlayPath(options: {
  readonly hostPath: string;
  readonly project: string;
  readonly volume: string;
  readonly instance: string;
  readonly dataRoot?: string;
}): Promise<void> {
  const dataRoot = options.dataRoot ?? defaultVolumeDataRoot();
  if (
    !isManagedChildOverlayPath(
      options.hostPath,
      options.project,
      options.volume,
      options.instance,
      dataRoot,
    )
  ) {
    return;
  }
  await removeChildOverlay(options.project, options.volume, options.instance, dataRoot);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function validateChildCreateInputs(request: { readonly sizeBytes: number }): void {
  if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 1) {
    throw SboxError.validation("Volume sizeBytes must be a positive safe integer.", {
      details: { path: "sizeBytes" },
    });
  }
}
