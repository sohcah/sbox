/**
 * Deterministic project-scoped managed volume paths outside MSB sandbox dirs.
 */

import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { SboxError } from "../errors.js";

export const BASE_QCOW2_NAME = "base.qcow2";
export const CHILDREN_DIR_NAME = "children";
export const LOCK_SOCKET_SUFFIX = ".lock.sock";

export function defaultVolumeDataRoot(): string {
  const override = process.env["SBOX_VOLUME_DATA_ROOT"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  try {
    return join(homedir(), ".sbox", "volumes");
  } catch {
    return join(tmpdir(), "sbox-volumes");
  }
}

export interface VolumePaths {
  readonly dataRoot: string;
  readonly projectRoot: string;
  readonly volumeRoot: string;
  readonly basePath: string;
  /**
   * Stable lock identity (logical path beside the base). The OS listen address
   * is a short hash of this key — see `volumeLockListenPath`.
   */
  readonly lockSocketPath: string;
  readonly childrenRoot: string;
}

export function volumePaths(
  project: string,
  volume: string,
  dataRoot: string = defaultVolumeDataRoot(),
): VolumePaths {
  const root = resolve(dataRoot);
  const projectRoot = projectVolumeRoot(project, root);
  const volumeRoot = join(projectRoot, volume);
  return {
    dataRoot: root,
    projectRoot,
    volumeRoot,
    basePath: join(volumeRoot, BASE_QCOW2_NAME),
    lockSocketPath: join(volumeRoot, `${BASE_QCOW2_NAME}${LOCK_SOCKET_SUFFIX}`),
    childrenRoot: join(volumeRoot, CHILDREN_DIR_NAME),
  };
}

export function projectVolumeRoot(
  project: string,
  dataRoot: string = defaultVolumeDataRoot(),
): string {
  return join(resolve(dataRoot), project);
}

export function childOverlayPath(
  project: string,
  volume: string,
  instance: string,
  dataRoot: string = defaultVolumeDataRoot(),
): string {
  return join(volumePaths(project, volume, dataRoot).childrenRoot, instance, `${volume}.qcow2`);
}

/**
 * True only for the deterministic writable child overlay path — never the base.
 */
export function isManagedChildOverlayPath(
  candidate: string,
  project: string,
  volume: string,
  instance: string,
  dataRoot: string = defaultVolumeDataRoot(),
): boolean {
  return resolve(candidate) === resolve(childOverlayPath(project, volume, instance, dataRoot));
}

/**
 * Fail closed unless candidate is exactly under the managed volume data root.
 */
export function assertManagedHostPath(
  candidate: string,
  dataRoot: string = defaultVolumeDataRoot(),
): string {
  const root = resolve(dataRoot);
  const resolved = resolve(candidate);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw SboxError.ownershipConflict("Host path is outside the managed volume data root.", {
      details: { path: resolved, dataRoot: root },
    });
  }
  return resolved;
}

export function isManagedHostPath(
  candidate: string,
  dataRoot: string = defaultVolumeDataRoot(),
): boolean {
  try {
    assertManagedHostPath(candidate, dataRoot);
    return true;
  } catch {
    return false;
  }
}
