/**
 * Immutable creation projection helpers.
 *
 * Internal to Host adapters. Not part of the public package declaration graph.
 */

import type { SandboxImmutableCreation } from "./ownership-adoption.js";
import { SboxError } from "./errors.js";
import { canonicalNetworkFingerprint, canonicalSecretsFingerprint } from "./network/compile.js";
import {
  defaultNetworkConfig,
  toSafeRuntimeSecret,
  type HostNetworkConfig,
  type ResolvedRuntimeSecret,
  type SafeRuntimeSecret,
} from "./network/types.js";
import type { HostVolumeAttachment, VolumeAttachmentSpec } from "./volume/types.js";
import { canonicalVolumesFingerprint } from "./ownership-adoption.js";
import {
  canonicalMountsFingerprint,
  type HostMount,
  type MountAttachmentSpec,
} from "./directory/types.js";

/** SDK defaults observed from microsandbox@0.6.6 minimal builder.build(). */
export const PHASE1_DEFAULT_CPUS = 1;
export const PHASE1_DEFAULT_MEMORY_MIB = 512;

export type { SandboxImmutableCreation };

/** @internal Alias used by Host adapters. */
export type ImmutableCreationProjection = SandboxImmutableCreation;

export function projectCreateRequest(request: {
  readonly image: string;
  readonly cpus?: number;
  readonly memoryMiB?: number;
  readonly tmpMiB?: number;
  readonly rootMiB?: number;
  readonly workdir?: string;
  readonly user?: string;
  readonly shell?: string;
  readonly hostname?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxDurationSecs?: number | null;
  readonly idleTimeoutSecs?: number | null;
  readonly network?: HostNetworkConfig;
  readonly secrets?: readonly ResolvedRuntimeSecret[];
  readonly volumes?: readonly HostVolumeAttachment[] | readonly VolumeAttachmentSpec[];
  readonly mounts?: readonly HostMount[] | readonly MountAttachmentSpec[];
}): SandboxImmutableCreation {
  const secrets: readonly SafeRuntimeSecret[] = Object.freeze(
    (request.secrets ?? []).map((secret) =>
      toSafeRuntimeSecret({
        env: secret.env,
        placeholder: secret.placeholder,
        destinations: secret.destinations,
      }),
    ),
  );
  const volumes: readonly VolumeAttachmentSpec[] = Object.freeze(
    (request.volumes ?? []).map((attachment) =>
      Object.freeze({ volume: attachment.volume, path: attachment.path }),
    ),
  );
  const mounts: readonly MountAttachmentSpec[] = Object.freeze(
    canonicalMountsFingerprint(
      (request.mounts ?? []).map((entry, index) => {
        if (entry.kind !== "file" && entry.kind !== "directory") {
          throw SboxError.validation("Host mount kind must be resolved before projection.", {
            details: { path: `mounts.${index}.kind` },
          });
        }
        return {
          source: entry.source,
          path: entry.path,
          mount: entry.mount,
          readonly: entry.readonly,
          kind: entry.kind,
          ...(entry.quotaMiB !== undefined ? { quotaMiB: entry.quotaMiB } : {}),
          ...(entry.followEscapingSymlinks === true ? { followEscapingSymlinks: true } : {}),
          ...(entry.mode === "copy" ? { mode: "copy" as const } : {}),
        };
      }),
    ),
  );
  return Object.freeze({
    image: request.image,
    cpus: request.cpus ?? PHASE1_DEFAULT_CPUS,
    memoryMiB: request.memoryMiB ?? PHASE1_DEFAULT_MEMORY_MIB,
    tmpMiB: request.tmpMiB ?? null,
    rootMiB: request.rootMiB ?? null,
    workdir: request.workdir ?? null,
    user: request.user ?? null,
    shell: request.shell ?? null,
    hostname: request.hostname ?? null,
    env: Object.freeze(request.env === undefined ? {} : { ...request.env }),
    maxDurationSecs: request.maxDurationSecs ?? null,
    idleTimeoutSecs: request.idleTimeoutSecs ?? null,
    network: request.network ?? defaultNetworkConfig(),
    secrets,
    volumes,
    mounts,
  });
}

export function immutableCreationEquals(
  left: SandboxImmutableCreation,
  right: SandboxImmutableCreation,
): boolean {
  return (
    left.image === right.image &&
    left.cpus === right.cpus &&
    left.memoryMiB === right.memoryMiB &&
    left.tmpMiB === right.tmpMiB &&
    left.rootMiB === right.rootMiB &&
    left.workdir === right.workdir &&
    left.user === right.user &&
    left.shell === right.shell &&
    left.hostname === right.hostname &&
    left.maxDurationSecs === right.maxDurationSecs &&
    left.idleTimeoutSecs === right.idleTimeoutSecs &&
    envRecordsEqual(left.env, right.env) &&
    JSON.stringify(canonicalNetworkFingerprint(left.network)) ===
      JSON.stringify(canonicalNetworkFingerprint(right.network)) &&
    JSON.stringify(canonicalSecretsFingerprint(left.secrets)) ===
      JSON.stringify(canonicalSecretsFingerprint(right.secrets)) &&
    JSON.stringify(canonicalVolumesFingerprint(left.volumes)) ===
      JSON.stringify(canonicalVolumesFingerprint(right.volumes)) &&
    JSON.stringify(canonicalMountsFingerprint(left.mounts)) ===
      JSON.stringify(canonicalMountsFingerprint(right.mounts))
  );
}

/**
 * Safe field names that differ between two immutable projections.
 * Environment values are never returned—only the aggregate `environment` marker.
 */
export function immutableCreationDriftFields(
  expected: SandboxImmutableCreation,
  actual: SandboxImmutableCreation,
): readonly string[] {
  const fields: string[] = [];
  if (expected.image !== actual.image) {
    fields.push("image");
  }
  if (expected.cpus !== actual.cpus) {
    fields.push("cpus");
  }
  if (expected.memoryMiB !== actual.memoryMiB) {
    fields.push("memoryMiB");
  }
  if (expected.tmpMiB !== actual.tmpMiB) {
    fields.push("tmpMiB");
  }
  if (expected.rootMiB !== actual.rootMiB) {
    fields.push("rootMiB");
  }
  if (expected.workdir !== actual.workdir) {
    fields.push("workdir");
  }
  if (expected.user !== actual.user) {
    fields.push("user");
  }
  if (expected.shell !== actual.shell) {
    fields.push("shell");
  }
  if (expected.hostname !== actual.hostname) {
    fields.push("hostname");
  }
  if (expected.maxDurationSecs !== actual.maxDurationSecs) {
    fields.push("maxDurationSecs");
  }
  if (expected.idleTimeoutSecs !== actual.idleTimeoutSecs) {
    fields.push("idleTimeoutSecs");
  }
  if (!envRecordsEqual(expected.env, actual.env)) {
    fields.push("environment");
  }
  if (
    JSON.stringify(canonicalNetworkFingerprint(expected.network)) !==
    JSON.stringify(canonicalNetworkFingerprint(actual.network))
  ) {
    fields.push("network");
  }
  if (
    JSON.stringify(canonicalSecretsFingerprint(expected.secrets)) !==
    JSON.stringify(canonicalSecretsFingerprint(actual.secrets))
  ) {
    fields.push("secrets");
  }
  if (
    JSON.stringify(canonicalVolumesFingerprint(expected.volumes)) !==
    JSON.stringify(canonicalVolumesFingerprint(actual.volumes))
  ) {
    fields.push("volumes");
  }
  if (
    JSON.stringify(canonicalMountsFingerprint(expected.mounts)) !==
    JSON.stringify(canonicalMountsFingerprint(actual.mounts))
  ) {
    fields.push("mounts");
  }
  return fields;
}

function envRecordsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}
