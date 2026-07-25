/**
 * Discover sandboxes whose disk mounts are children of a managed base.
 */

import { resolve } from "node:path";
import type { NativeSandboxRecord } from "../native-runtime.js";
import { inspectOwnershipLabels } from "../ownership.js";
import { assertChildQcow2Info, qemuImgInfo, type QemuImgPorts } from "./qemu-img.js";
import { childOverlayPath, defaultVolumeDataRoot, volumePaths } from "./paths.js";
import { isVolumeMaintenanceLabels } from "./naming.js";

export interface VolumeDescendant {
  readonly nativeName: string;
  readonly project: string;
  readonly instance: string;
  readonly profile: string;
  readonly childPath: string;
  readonly guestPath: string;
  readonly status: string;
  readonly maintenance: boolean;
}

export interface ListDescendantsRequest {
  readonly project: string;
  readonly volume: string;
  readonly sizeBytes: number;
  readonly records: readonly NativeSandboxRecord[];
  readonly dataRoot?: string;
  readonly qemuImg?: QemuImgPorts;
  readonly signal?: AbortSignal;
  /** When false, skip qemu-img child validation (listing only). Default true. */
  readonly validateChildren?: boolean;
}

/**
 * Inspect owned sandboxes for child overlays backed by this base.
 * Does not consult a catalog — only native config mounts + qemu-img.
 */
export async function listVolumeDescendants(
  request: ListDescendantsRequest,
): Promise<readonly VolumeDescendant[]> {
  const dataRoot = request.dataRoot ?? defaultVolumeDataRoot();
  const paths = volumePaths(request.project, request.volume, dataRoot);
  const expectedBase = resolve(paths.basePath);
  const validateChildren = request.validateChildren !== false;
  const out: VolumeDescendant[] = [];

  for (const record of request.records) {
    const ownership = inspectOwnershipLabels(record.labels);
    if (!ownership.ok || ownership.identity.project !== request.project) {
      continue;
    }
    for (const mount of record.mounts) {
      const host = resolve(mount.hostPath);
      const expectedChild = resolve(
        childOverlayPath(request.project, request.volume, ownership.identity.instance, dataRoot),
      );
      const isExpectedChild = host === expectedChild;
      const isBaseMount =
        host === expectedBase && isVolumeMaintenanceLabels(record.labels, request.volume);
      if (!isExpectedChild && !isBaseMount) {
        continue;
      }
      if (isExpectedChild && validateChildren) {
        const info = await qemuImgInfo(host, request.qemuImg, request.signal);
        assertChildQcow2Info(info, request.sizeBytes, paths.basePath, host);
      }
      out.push({
        nativeName: record.name,
        project: ownership.identity.project,
        instance: ownership.identity.instance,
        profile: ownership.identity.profile,
        childPath: host,
        guestPath: mount.guestPath,
        status: record.status,
        maintenance: isBaseMount,
      });
    }
  }
  return Object.freeze(out);
}

export function countOrdinaryDescendants(descendants: readonly VolumeDescendant[]): number {
  return descendants.filter((d) => !d.maintenance).length;
}
