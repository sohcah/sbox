/**
 * Crashed-maintenance recovery and exclusive base maintenance helpers.
 *
 * Live (running/draining) maintenance sessions fail closed as busy.
 * Only terminal leftover maintenance sandboxes are recovered.
 */

import { SboxError } from "../errors.js";
import {
  assertSandboxIdentity,
  nativeSandboxName,
  type ProjectId,
  type ProfileId,
} from "../identity.js";
import type { NativeRuntime, NativeSandboxRecord } from "../native-runtime.js";
import { buildOwnershipLabels, type SandboxImmutableCreation } from "../ownership-adoption.js";
import { inspectOwnershipLabels } from "../ownership.js";
import {
  buildVolumeMaintenanceLabels,
  isVolumeMaintenanceLabels,
  maintenanceInstanceId,
} from "./naming.js";
import type { VolumeDescendant } from "./descendants.js";

export function maintenanceIdentity(
  project: ProjectId,
  profile: ProfileId,
  volume: string,
): ReturnType<typeof assertSandboxIdentity> {
  return assertSandboxIdentity({
    project,
    profile,
    instance: maintenanceInstanceId(volume),
  });
}

export function maintenanceNativeName(project: ProjectId, volume: string): string {
  return nativeSandboxName(project, maintenanceInstanceId(volume));
}

export function buildMaintenanceOwnershipLabels(
  identity: ReturnType<typeof assertSandboxIdentity>,
  creation: SandboxImmutableCreation,
  volume: string,
): Record<string, string> {
  return {
    ...buildOwnershipLabels(identity, creation),
    ...buildVolumeMaintenanceLabels(volume),
  };
}

function isLiveNativeStatus(status: string): boolean {
  return status === "running" || status === "draining";
}

/**
 * While holding the base lock: recover a matching *terminal* maintenance
 * sandbox, or fail closed on live sessions / mismatched identities.
 */
export async function recoverCrashedMaintenance(options: {
  readonly runtime: NativeRuntime;
  readonly project: ProjectId;
  readonly volume: string;
  readonly expectedNativeName: string;
}): Promise<void> {
  let record: NativeSandboxRecord | undefined;
  try {
    record = await options.runtime.get(options.expectedNativeName);
  } catch (error) {
    if (error instanceof SboxError && error.code === "not_found") {
      return;
    }
    throw error;
  }

  const ownership = inspectOwnershipLabels(record.labels);
  if (!ownership.ok) {
    throw SboxError.busy(
      "Native sandbox occupies the maintenance identity without valid sbox ownership.",
      { details: { nativeName: options.expectedNativeName, reason: ownership.reason } },
    );
  }
  if (!isVolumeMaintenanceLabels(record.labels, options.volume)) {
    throw SboxError.busy(
      "Native sandbox occupies the maintenance identity without volume-maintenance labels.",
      { details: { nativeName: options.expectedNativeName } },
    );
  }
  if (ownership.identity.project !== options.project) {
    throw SboxError.busy("Maintenance identity is owned by a different project.", {
      details: { nativeName: options.expectedNativeName },
    });
  }

  // Live maintenance is exclusive — never tear it down for ordinary create/up.
  if (isLiveNativeStatus(record.status)) {
    throw SboxError.busy(
      `Volume ${options.volume} has an active maintenance sandbox; finish or remove it before continuing.`,
      {
        details: {
          nativeName: options.expectedNativeName,
          state: record.status,
          volume: options.volume,
        },
      },
    );
  }

  // Terminal leftover (stopped/crashed/unknown): detach/consume then remove.
  try {
    await options.runtime.stopLiveThenFreshGet(options.expectedNativeName);
  } catch {
    // Already stopped is fine; unresolved contention fails on remove below.
  }

  try {
    await options.runtime.remove(options.expectedNativeName);
  } catch (error) {
    throw SboxError.busy(
      "Could not remove a leftover volume maintenance sandbox; retry after native disk locks clear.",
      { cause: error, details: { nativeName: options.expectedNativeName } },
    );
  }
}

export function assertNoOrdinaryDescendants(
  volume: string,
  descendants: readonly VolumeDescendant[],
): void {
  const ordinary = descendants.filter((d) => !d.maintenance);
  if (ordinary.length > 0) {
    throw SboxError.busy(
      `Volume ${volume} has ${ordinary.length} descendant sandbox overlay(s); remove them before maintenance or base removal.`,
      {
        details: {
          volume,
          descendants: ordinary.map((d) => ({
            instance: d.instance,
            nativeName: d.nativeName,
            status: d.status,
          })),
        },
      },
    );
  }
}
