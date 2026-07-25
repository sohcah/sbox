/**
 * Maintenance sandbox identity and reserved volume labels.
 */

import { assertInstanceId, type InstanceId } from "../identity.js";
import { isPortableSlug } from "../identity.js";
import { SboxError } from "../errors.js";
import type { LabelMap } from "../ownership.js";

export const VOLUME_LABEL_KEYS = Object.freeze({
  purpose: "dev.sohcah.sbox/purpose",
  volume: "dev.sohcah.sbox/volume",
} as const);

export const VOLUME_MAINTENANCE_PURPOSE = "volume-maintenance";

const MAINTENANCE_INSTANCE_PREFIX = "vmaint-";

/**
 * Deterministic portable instance id for a volume maintenance sandbox.
 */
export function maintenanceInstanceId(volume: string): InstanceId {
  if (!isPortableSlug(volume)) {
    throw SboxError.validation("Invalid volume slug for maintenance instance.", {
      details: { volume },
    });
  }
  const instance = `${MAINTENANCE_INSTANCE_PREFIX}${volume}`;
  if (!isPortableSlug(instance)) {
    throw SboxError.validation("Maintenance instance id is not a portable slug.", {
      details: { instance, volume },
    });
  }
  return assertInstanceId(instance);
}

export function isMaintenanceInstanceId(instance: string, volume: string): boolean {
  return instance === `${MAINTENANCE_INSTANCE_PREFIX}${volume}`;
}

export function buildVolumeMaintenanceLabels(volume: string): LabelMap {
  return Object.freeze({
    [VOLUME_LABEL_KEYS.purpose]: VOLUME_MAINTENANCE_PURPOSE,
    [VOLUME_LABEL_KEYS.volume]: volume,
  });
}

export function isVolumeMaintenanceLabels(labels: LabelMap | undefined, volume: string): boolean {
  if (labels === undefined) {
    return false;
  }
  return (
    labels[VOLUME_LABEL_KEYS.purpose] === VOLUME_MAINTENANCE_PURPOSE &&
    labels[VOLUME_LABEL_KEYS.volume] === volume
  );
}
