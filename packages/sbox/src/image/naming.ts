/**
 * Generated-image naming and reserved ownership evidence.
 *
 * A generated reference name is never ownership evidence by itself.
 *
 * Preferred evidence is OCI config labels. Pinned Microsandbox 0.6.6 drops
 * labels on `msb image load`, but preserves config ENV — so ownership is also
 * stamped into reserved ENV keys that survive that load path.
 */

import { OWNERSHIP_LABEL_KEYS, MANAGED_LABEL_VALUE } from "../ownership.js";
import { SboxError } from "../errors.js";
import { utf8Bytes } from "../identity.js";
import type { ImageContentDigest } from "./types.js";

/** Explicit content-identity algorithm version. Changing this invalidates digests. */
export const IMAGE_IDENTITY_ALGORITHM_VERSION = 1 as const;

/** Microsandbox/OCI reference practical limit used for generated names. */
export const NATIVE_IMAGE_REFERENCE_MAX_BYTES = 255;

export const IMAGE_LABEL_KEYS = Object.freeze({
  managed: OWNERSHIP_LABEL_KEYS.managed,
  imageIdentity: "dev.sohcah.sbox/image-identity",
  imageAlgorithm: "dev.sohcah.sbox/image-algorithm",
} as const);

/**
 * Reserved image-config ENV keys. Used when OCI labels are stripped by the
 * native load path. These appear in the guest environment for generated images.
 */
export const IMAGE_ENV_KEYS = Object.freeze({
  managed: "DEV_SOHCAH_SBOX_MANAGED",
  imageIdentity: "DEV_SOHCAH_SBOX_IMAGE_IDENTITY",
  imageAlgorithm: "DEV_SOHCAH_SBOX_IMAGE_ALGORITHM",
} as const);

const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type { ImageContentDigest };

export function formatImageContentDigest(digestHex: string): ImageContentDigest {
  assertDigestHex(digestHex);
  return `sha256:${digestHex}`;
}

/**
 * Deterministic native Microsandbox reference for a content-addressed image.
 * Format: `sbox-img:sha256-<64-lowercase-hex>`
 */
export function formatNativeImageReference(digestHex: string): string {
  assertDigestHex(digestHex);
  const reference = `sbox-img:sha256-${digestHex}`;
  assertNativeImageReferenceLength(reference);
  return reference;
}

export function parseNativeImageReference(
  reference: string,
): { readonly digestHex: string } | undefined {
  const match = /^sbox-img:sha256-([0-9a-f]{64})$/.exec(reference);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  return { digestHex: match[1] };
}

export function buildImageOwnershipLabels(digestHex: string): Readonly<Record<string, string>> {
  return Object.freeze({
    [IMAGE_LABEL_KEYS.managed]: MANAGED_LABEL_VALUE,
    [IMAGE_LABEL_KEYS.imageIdentity]: formatImageContentDigest(digestHex),
    [IMAGE_LABEL_KEYS.imageAlgorithm]: String(IMAGE_IDENTITY_ALGORITHM_VERSION),
  });
}

export function buildImageOwnershipEnv(digestHex: string): Readonly<Record<string, string>> {
  return Object.freeze({
    [IMAGE_ENV_KEYS.managed]: MANAGED_LABEL_VALUE,
    [IMAGE_ENV_KEYS.imageIdentity]: formatImageContentDigest(digestHex),
    [IMAGE_ENV_KEYS.imageAlgorithm]: String(IMAGE_IDENTITY_ALGORITHM_VERSION),
  });
}

/** Docker `commit --change` directives that stamp labels and ENV ownership. */
export function buildOwnershipDockerChanges(digestHex: string): readonly string[] {
  const env = buildImageOwnershipEnv(digestHex);
  const labels = buildImageOwnershipLabels(digestHex);
  const changes: string[] = [];
  for (const key of Object.keys(env).toSorted()) {
    changes.push(`ENV ${key}=${env[key] ?? ""}`);
  }
  for (const key of Object.keys(labels).toSorted()) {
    changes.push(`LABEL ${key}=${labels[key] ?? ""}`);
  }
  return changes;
}

export type ImageOwnershipMatch =
  | { readonly ok: true; readonly digestHex: string; readonly source: "labels" | "env" }
  | { readonly ok: false; readonly reason: string };

/**
 * Verify ownership using reserved OCI labels and/or reserved config ENV.
 *
 * A matching tag alone is never evidence.
 *
 * Validation rules:
 * - Any reserved label present → the complete label set must match.
 * - Any reserved ENV marker present → the complete ENV set must match.
 * - Contradiction, partial evidence, or mismatch in either present set → conflict.
 * - Labels entirely absent + complete matching ENV → Phase 4 compatibility
 *   fallback (Microsandbox 0.6.6 load drops labels but preserves ENV).
 */
export function inspectImageOwnershipEvidence(
  labels: Readonly<Record<string, string>> | null | undefined,
  env: readonly string[] | Readonly<Record<string, string>> | null | undefined,
  expectedDigestHex: string,
): ImageOwnershipMatch {
  assertDigestHex(expectedDigestHex);
  const labelMap = labels ?? {};
  const envMap = normalizeEnvMap(env);
  const expected = formatImageContentDigest(expectedDigestHex);
  const algorithm = String(IMAGE_IDENTITY_ALGORITHM_VERSION);

  const labelMatch = matchOwnershipMap(labelMap, IMAGE_LABEL_KEYS, expected, algorithm, "label");
  const envMatch = matchOwnershipMap(envMap, IMAGE_ENV_KEYS, expected, algorithm, "env");

  // Present-but-incomplete/mismatched evidence always fails closed — never fall
  // through to the other channel.
  if (!labelMatch.ok && labelMatch.partial) {
    return {
      ok: false,
      reason: labelMatch.reason ?? "Image ownership labels are incomplete or mismatched.",
    };
  }
  if (!envMatch.ok && envMatch.partial) {
    return {
      ok: false,
      reason: envMatch.reason ?? "Image ownership env markers are incomplete or mismatched.",
    };
  }

  if (labelMatch.ok) {
    return { ok: true, digestHex: expectedDigestHex, source: "labels" };
  }
  if (envMatch.ok) {
    // Reached only when no reserved labels are present at all.
    return { ok: true, digestHex: expectedDigestHex, source: "env" };
  }

  return { ok: false, reason: "Image ownership evidence is missing." };
}

/**
 * @deprecated Prefer {@link inspectImageOwnershipEvidence}. Label-only helper
 * retained for narrow call sites that already have a label map.
 */
export function inspectImageOwnershipLabels(
  labels: Readonly<Record<string, string>> | null | undefined,
  expectedDigestHex: string,
): ImageOwnershipMatch {
  return inspectImageOwnershipEvidence(labels, undefined, expectedDigestHex);
}

/** True when no reserved ownership labels or ENV markers are present. */
export function hasNoReservedImageEvidence(
  labels: Readonly<Record<string, string>> | null | undefined,
  env: readonly string[] | Readonly<Record<string, string>> | null | undefined,
): boolean {
  const labelMap = labels ?? {};
  const envMap = normalizeEnvMap(env);
  return (
    labelMap[IMAGE_LABEL_KEYS.managed] === undefined &&
    labelMap[IMAGE_LABEL_KEYS.imageIdentity] === undefined &&
    labelMap[IMAGE_LABEL_KEYS.imageAlgorithm] === undefined &&
    envMap[IMAGE_ENV_KEYS.managed] === undefined &&
    envMap[IMAGE_ENV_KEYS.imageIdentity] === undefined &&
    envMap[IMAGE_ENV_KEYS.imageAlgorithm] === undefined
  );
}

/** @deprecated Prefer {@link hasNoReservedImageEvidence}. */
export function hasNoReservedImageLabels(
  labels: Readonly<Record<string, string>> | null | undefined,
): boolean {
  return hasNoReservedImageEvidence(labels, undefined);
}

export function normalizeEnvMap(
  env: readonly string[] | Readonly<Record<string, string>> | null | undefined,
): Readonly<Record<string, string>> {
  if (env === null || env === undefined) {
    return {};
  }
  const lines: readonly string[] = Array.isArray(env)
    ? env
    : Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const out: Record<string, string> = {};
  for (const entry of lines) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function matchOwnershipMap(
  map: Readonly<Record<string, string>>,
  keys: {
    readonly managed: string;
    readonly imageIdentity: string;
    readonly imageAlgorithm: string;
  },
  expectedIdentity: string,
  expectedAlgorithm: string,
  kind: "label" | "env",
): { ok: true } | { ok: false; partial: boolean; reason?: string } {
  const managed = map[keys.managed];
  const identity = map[keys.imageIdentity];
  const algorithm = map[keys.imageAlgorithm];
  const any = managed !== undefined || identity !== undefined || algorithm !== undefined;
  if (!any) {
    return { ok: false, partial: false };
  }
  if (managed !== MANAGED_LABEL_VALUE) {
    return {
      ok: false,
      partial: true,
      reason: `Managed ownership ${kind} marker is missing or invalid.`,
    };
  }
  if (algorithm !== expectedAlgorithm) {
    return {
      ok: false,
      partial: true,
      reason: `Image identity algorithm ${kind} marker is missing or mismatched.`,
    };
  }
  if (identity !== expectedIdentity) {
    return {
      ok: false,
      partial: true,
      reason: `Image identity ${kind} marker is missing or mismatched.`,
    };
  }
  return { ok: true };
}

function assertDigestHex(digestHex: string): void {
  if (!DIGEST_HEX_PATTERN.test(digestHex)) {
    throw SboxError.internal("Expected a 64-character lowercase hex digest.", {
      details: { digestLength: digestHex.length },
    });
  }
}

function assertNativeImageReferenceLength(reference: string): void {
  const bytes = utf8Bytes(reference);
  if (bytes > NATIVE_IMAGE_REFERENCE_MAX_BYTES) {
    throw SboxError.internal(
      `Generated image reference exceeds ${NATIVE_IMAGE_REFERENCE_MAX_BYTES} UTF-8 bytes.`,
      { details: { bytes, maxBytes: NATIVE_IMAGE_REFERENCE_MAX_BYTES } },
    );
  }
}
