/**
 * Internal ownership adoption: fingerprint labels and native config matching.
 *
 * Not part of the public package declaration graph. Environment values are
 * compared against decoded native configuration here, but are excluded from the
 * persisted fingerprint label (which is publicly visible on inspection).
 */

import { createHash } from "node:crypto";
import type { SandboxIdentity } from "./identity.js";
import {
  OWNERSHIP_LABEL_KEYS,
  MANAGED_LABEL_VALUE,
  inspectOwnershipLabels,
  type LabelMap,
  type OwnershipMatch,
} from "./ownership.js";
import { canonicalNetworkFingerprint, canonicalSecretsFingerprint } from "./network/compile.js";
import type { HostNetworkConfig, SafeRuntimeSecret } from "./network/types.js";

/**
 * Complete Phase 1 immutable creation projection used for ownership/adoption.
 * Optional request fields are resolved to native defaults before comparison.
 */
export interface SandboxImmutableCreation {
  readonly image: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly workdir: string | null;
  readonly user: string | null;
  readonly shell: string | null;
  readonly hostname: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly maxDurationSecs: number | null;
  readonly idleTimeoutSecs: number | null;
  readonly network: HostNetworkConfig;
  readonly secrets: readonly SafeRuntimeSecret[];
}

/**
 * Environment keys the pinned SDK may inject that are not part of the request.
 * Compared narrowly: requested keys must still match exactly when present.
 */
const SDK_INJECTED_ENV_KEYS = new Set(["PATH"]);

export function buildOwnershipLabels(
  identity: SandboxIdentity,
  creation: SandboxImmutableCreation,
): LabelMap {
  return Object.freeze({
    [OWNERSHIP_LABEL_KEYS.managed]: MANAGED_LABEL_VALUE,
    [OWNERSHIP_LABEL_KEYS.project]: identity.project,
    [OWNERSHIP_LABEL_KEYS.instance]: identity.instance,
    [OWNERSHIP_LABEL_KEYS.profile]: identity.profile,
    [OWNERSHIP_LABEL_KEYS.creation]: creationFingerprint(creation),
  });
}

/**
 * Strict ownership check. Extra unrelated labels are allowed.
 * Missing or mismatched reserved labels fail closed.
 */
export function matchOwnershipLabels(
  labels: LabelMap | undefined,
  expected: SandboxIdentity,
  creation: SandboxImmutableCreation,
): OwnershipMatch {
  const inspected = inspectOwnershipLabels(labels);
  if (!inspected.ok) {
    return inspected;
  }
  if (inspected.identity.project !== expected.project) {
    return { ok: false, reason: "Project label does not match." };
  }
  if (inspected.identity.instance !== expected.instance) {
    return { ok: false, reason: "Instance label does not match." };
  }
  if (inspected.identity.profile !== expected.profile) {
    return { ok: false, reason: "Profile label does not match." };
  }
  const expectedFingerprint = creationFingerprint(creation);
  if (inspected.creation !== expectedFingerprint) {
    return { ok: false, reason: "Creation fingerprint label does not match." };
  }
  return inspected;
}

export type NativeCreationEvidence = {
  readonly labels: LabelMap | undefined;
  readonly image: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly workdir: string | null;
  readonly user: string | null;
  readonly shell: string | null;
  readonly hostname: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly maxDurationSecs: number | null;
  readonly idleTimeoutSecs: number | null;
  readonly network: HostNetworkConfig;
  readonly secrets: readonly SafeRuntimeSecret[];
};

/**
 * Full uncertain-create / already-exists adoption check: ownership labels,
 * creation fingerprint, and decoded native immutable configuration.
 */
export function matchOwnedCreation(
  record: NativeCreationEvidence,
  expected: SandboxIdentity,
  creation: SandboxImmutableCreation,
): OwnershipMatch {
  const ownership = matchOwnershipLabels(record.labels, expected, creation);
  if (!ownership.ok) {
    return ownership;
  }
  if (!nativeRecordMatchesCreation(record, creation)) {
    return { ok: false, reason: "Native immutable configuration does not match." };
  }
  return ownership;
}

/**
 * Compare the requested immutable projection against a decoded native record.
 * Fingerprint labels are additional evidence and do not replace this check.
 * Environment is authoritative here and is not part of the persisted fingerprint.
 */
export function nativeRecordMatchesCreation(
  record: {
    readonly image: string;
    readonly cpus: number;
    readonly memoryMiB: number;
    readonly workdir: string | null;
    readonly user: string | null;
    readonly shell: string | null;
    readonly hostname: string | null;
    readonly env: Readonly<Record<string, string>>;
    readonly maxDurationSecs: number | null;
    readonly idleTimeoutSecs: number | null;
    readonly network: HostNetworkConfig;
    readonly secrets: readonly SafeRuntimeSecret[];
  },
  requested: SandboxImmutableCreation,
): boolean {
  if (record.image !== requested.image) {
    return false;
  }
  if (record.cpus !== requested.cpus) {
    return false;
  }
  if (record.memoryMiB !== requested.memoryMiB) {
    return false;
  }
  if (record.workdir !== requested.workdir) {
    return false;
  }
  if (record.user !== requested.user) {
    return false;
  }
  if (record.shell !== requested.shell) {
    return false;
  }
  if (record.hostname !== requested.hostname) {
    return false;
  }
  if (record.maxDurationSecs !== requested.maxDurationSecs) {
    return false;
  }
  if (record.idleTimeoutSecs !== requested.idleTimeoutSecs) {
    return false;
  }
  if (
    JSON.stringify(canonicalNetworkFingerprint(record.network)) !==
    JSON.stringify(canonicalNetworkFingerprint(requested.network))
  ) {
    return false;
  }
  if (
    JSON.stringify(canonicalSecretsFingerprint(record.secrets)) !==
    JSON.stringify(canonicalSecretsFingerprint(requested.secrets))
  ) {
    return false;
  }
  return envMatchesAllowingSdkInjected(requested.env, record.env);
}

function envMatchesAllowingSdkInjected(
  requested: Readonly<Record<string, string>>,
  native: Readonly<Record<string, string>>,
): boolean {
  for (const [key, value] of Object.entries(requested)) {
    if (native[key] !== value) {
      return false;
    }
  }
  for (const key of Object.keys(native)) {
    if (Object.prototype.hasOwnProperty.call(requested, key)) {
      continue;
    }
    if (SDK_INJECTED_ENV_KEYS.has(key)) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Stable fingerprint of non-secret immutable creation fields.
 * Environment and secret values are intentionally excluded.
 */
function creationFingerprint(projection: SandboxImmutableCreation): string {
  const canonical = JSON.stringify({
    image: projection.image,
    cpus: projection.cpus,
    memoryMiB: projection.memoryMiB,
    workdir: projection.workdir,
    user: projection.user,
    shell: projection.shell,
    hostname: projection.hostname,
    maxDurationSecs: projection.maxDurationSecs,
    idleTimeoutSecs: projection.idleTimeoutSecs,
    network: canonicalNetworkFingerprint(projection.network),
    secrets: canonicalSecretsFingerprint(projection.secrets),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}
