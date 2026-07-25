/**
 * Derive safe volume attachment specs from native disk mounts.
 */

import { basename, resolve } from "node:path";
import type { NativeDiskMount } from "../native-runtime.js";
import type { VolumeAttachmentSpec } from "./types.js";
import { childOverlayPath, defaultVolumeDataRoot, volumePaths } from "./paths.js";
import { isVolumeMaintenanceLabels, VOLUME_LABEL_KEYS } from "./naming.js";
import type { LabelMap } from "../ownership.js";

export function volumeAttachmentsFromMounts(options: {
  readonly project: string;
  readonly instance: string;
  readonly mounts: readonly NativeDiskMount[];
  readonly labels?: LabelMap;
  readonly dataRoot?: string;
}): readonly VolumeAttachmentSpec[] {
  const dataRoot = options.dataRoot ?? defaultVolumeDataRoot();
  const out: VolumeAttachmentSpec[] = [];
  const seen = new Set<string>();

  for (const mount of options.mounts) {
    if (mount.format !== "qcow2") {
      continue;
    }
    const host = resolve(mount.hostPath);
    const maintenanceVolume = options.labels?.[VOLUME_LABEL_KEYS.volume];
    if (
      maintenanceVolume !== undefined &&
      isVolumeMaintenanceLabels(options.labels, maintenanceVolume)
    ) {
      const base = resolve(volumePaths(options.project, maintenanceVolume, dataRoot).basePath);
      if (host === base) {
        const key = `${maintenanceVolume}\0${mount.guestPath}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ volume: maintenanceVolume, path: mount.guestPath });
        }
        continue;
      }
    }

    const file = basename(host);
    if (!file.endsWith(".qcow2")) {
      continue;
    }
    const volume = file.slice(0, -".qcow2".length);
    if (volume.length === 0) {
      continue;
    }
    const expected = resolve(childOverlayPath(options.project, volume, options.instance, dataRoot));
    if (host !== expected) {
      continue;
    }
    const key = `${volume}\0${mount.guestPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ volume, path: mount.guestPath });
  }

  return Object.freeze(
    out.toSorted((a, b) => {
      const byVolume = a.volume.localeCompare(b.volume);
      return byVolume !== 0 ? byVolume : a.path.localeCompare(b.path);
    }),
  );
}
