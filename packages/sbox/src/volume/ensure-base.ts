/**
 * Ensure a managed base QCOW2 exists (create under lock when missing).
 */

import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { SboxError, throwIfAborted } from "../errors.js";
import { formatAndPublishBase, type FormatBasePorts } from "./format-base.js";
import { withVolumeLock } from "./lock.js";
import { assertBaseQcow2Info, qemuImgInfo, requireQemuImg, type QemuImgPorts } from "./qemu-img.js";
import { defaultVolumeDataRoot, volumePaths } from "./paths.js";

export interface EnsureBaseRequest {
  readonly project: string;
  readonly volume: string;
  readonly sizeBytes: number;
  readonly dataRoot?: string;
  readonly signal?: AbortSignal;
}

export interface EnsureBasePorts extends FormatBasePorts {
  readonly qemuImg?: QemuImgPorts;
  /** Invoked while holding the base lock, before ensure/create. */
  readonly beforeEnsure?: () => Promise<void>;
}

export async function ensureVolumeBase(
  request: EnsureBaseRequest,
  ports: EnsureBasePorts,
): Promise<{ readonly basePath: string; readonly created: boolean }> {
  throwIfAborted(request.signal);
  validateSize(request.sizeBytes);
  await requireQemuImg(ports.qemuImg, request.signal);
  const dataRoot = request.dataRoot ?? defaultVolumeDataRoot();
  const paths = volumePaths(request.project, request.volume, dataRoot);
  await mkdir(paths.volumeRoot, { recursive: true });

  return withVolumeLock(
    paths.lockSocketPath,
    async () => {
      if (ports.beforeEnsure !== undefined) {
        await ports.beforeEnsure();
      }
      return ensureVolumeBaseLocked(request, ports, paths);
    },
    request.signal !== undefined ? { signal: request.signal } : {},
  );
}

/**
 * Ensure base while the caller already holds the per-base lock.
 */
export async function ensureVolumeBaseLocked(
  request: EnsureBaseRequest,
  ports: Pick<EnsureBasePorts, "runtime" | "execInSandbox" | "qemuImg">,
  paths = volumePaths(request.project, request.volume, request.dataRoot ?? defaultVolumeDataRoot()),
): Promise<{ readonly basePath: string; readonly created: boolean }> {
  throwIfAborted(request.signal);
  validateSize(request.sizeBytes);
  await mkdir(paths.volumeRoot, { recursive: true });

  if (await pathExists(paths.basePath)) {
    const info = await qemuImgInfo(paths.basePath, ports.qemuImg, request.signal);
    assertBaseQcow2Info(info, request.sizeBytes, paths.basePath);
    return { basePath: paths.basePath, created: false };
  }
  await formatAndPublishBase(
    {
      volumeRoot: paths.volumeRoot,
      basePath: paths.basePath,
      sizeBytes: request.sizeBytes,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    },
    ports,
  );
  return { basePath: paths.basePath, created: true };
}

function validateSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw SboxError.validation("Volume sizeBytes must be a positive safe integer.", {
      details: { path: "sizeBytes" },
    });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
