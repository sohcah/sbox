/**
 * Decode pinned microsandbox@0.6.6 SandboxConfig into application-owned fields.
 *
 * Exact shape confirmed via Sandbox.builder(...).build():
 * - image.Oci.reference
 * - resources.cpus / resources.memoryMib
 * - runtime.workdir / user / shell / hostname (nullable)
 * - lifecycle.maxDurationSecs / idleTimeoutSecs (nullable)
 * - env: [{ key, value }]
 * - labels: Record<string, string>
 * - network: enabled/policy/ports/secrets (Phase 5)
 *
 * Do not invent alternate shapes unless documented for this pin.
 * Not part of the public package declaration graph.
 */

import { PHASE1_DEFAULT_CPUS, PHASE1_DEFAULT_MEMORY_MIB } from "./immutable-creation.js";
import { decodeNetworkEvidence, hostNetworkFromEvidence } from "./network/decode.js";
import type { HostNetworkConfig, SafeRuntimeSecret } from "./network/types.js";
import { decodeBindMounts } from "./directory/decode-binds.js";
import type { NativeBindMount } from "./native-runtime.js";
import { decodeDiskMounts } from "./volume/mounts.js";

export interface DecodedSandboxConfig {
  readonly image: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  /** Size of `/tmp` tmpfs when present in mounts; otherwise null. */
  readonly tmpMiB: number | null;
  /** OCI overlay upper size from image.Oci.upperSizeMib when present; otherwise null. */
  readonly rootMiB: number | null;
  readonly workdir: string | null;
  readonly user: string | null;
  readonly shell: string | null;
  readonly hostname: string | null;
  readonly maxDurationSecs: number | null;
  readonly idleTimeoutSecs: number | null;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly network: HostNetworkConfig;
  readonly secrets: readonly SafeRuntimeSecret[];
  readonly mounts: readonly {
    readonly guestPath: string;
    readonly hostPath: string;
    readonly format: string;
    readonly fstype: string | null;
  }[];
  readonly bindMounts: readonly NativeBindMount[];
}

export function decodeSandboxConfig(config: unknown): DecodedSandboxConfig {
  if (config === null || typeof config !== "object") {
    throw new Error("SandboxConfig must be an object.");
  }
  const root = config as Record<string, unknown>;
  const resources = asRecord(root["resources"]);
  const runtime = asRecord(root["runtime"]);
  const lifecycle = asRecord(root["lifecycle"]);
  const networkEvidence = decodeNetworkEvidence(config);

  return {
    image: readOciImageReference(root["image"]),
    cpus: readRequiredPositiveInt(resources?.["cpus"], "resources.cpus", PHASE1_DEFAULT_CPUS),
    memoryMiB: readRequiredPositiveInt(
      resources?.["memoryMib"],
      "resources.memoryMib",
      PHASE1_DEFAULT_MEMORY_MIB,
    ),
    tmpMiB: decodeTmpfsSizeMiB(config, "/tmp"),
    rootMiB: decodeOciUpperSizeMiB(root["image"]),
    workdir: readNullableString(runtime?.["workdir"]),
    user: readNullableString(runtime?.["user"]),
    shell: readNullableString(runtime?.["shell"]),
    hostname: readNullableString(runtime?.["hostname"]),
    maxDurationSecs: readNullablePositiveInt(
      lifecycle?.["maxDurationSecs"],
      "lifecycle.maxDurationSecs",
    ),
    idleTimeoutSecs: readNullablePositiveInt(
      lifecycle?.["idleTimeoutSecs"],
      "lifecycle.idleTimeoutSecs",
    ),
    env: readEnvEntries(root["env"]),
    labels: readLabels(root["labels"]),
    network: hostNetworkFromEvidence(networkEvidence),
    secrets: networkEvidence.secrets,
    mounts: decodeDiskMounts(config).map((mount) =>
      Object.freeze({
        guestPath: mount.guest,
        hostPath: mount.host,
        format: mount.format,
        fstype: mount.fstype,
      }),
    ),
    bindMounts: decodeBindMounts(config),
  };
}

/**
 * Best-effort label peek independent of network/image decode.
 * Returns undefined when labels are absent or not a string map.
 */
export function peekSandboxConfigLabels(
  config: unknown,
): Readonly<Record<string, string>> | undefined {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const raw = (config as Record<string, unknown>)["labels"];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return undefined;
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function readOciImageReference(image: unknown): string {
  if (image === null || typeof image !== "object") {
    throw new Error("SandboxConfig.image must be an object.");
  }
  const record = image as Record<string, unknown>;
  const oci = record["Oci"];
  if (oci === null || typeof oci !== "object") {
    throw new Error("SandboxConfig.image.Oci must be an object for OCI references.");
  }
  const reference = (oci as Record<string, unknown>)["reference"];
  if (typeof reference !== "string" || reference.length === 0) {
    throw new Error("SandboxConfig.image.Oci.reference must be a non-empty string.");
  }
  return reference;
}

/** Read OCI overlay upper size from SandboxConfig.image.Oci when present. */
function decodeOciUpperSizeMiB(image: unknown): number | null {
  if (image === null || typeof image !== "object") {
    return null;
  }
  const oci = (image as Record<string, unknown>)["Oci"];
  if (oci === null || typeof oci !== "object") {
    return null;
  }
  const size =
    (oci as Record<string, unknown>)["upperSizeMib"] ??
    (oci as Record<string, unknown>)["upperSizeMiB"];
  if (typeof size === "number" && Number.isInteger(size) && size > 0) {
    return size;
  }
  return null;
}

/** Read `/tmp` (or other guest) tmpfs size from SandboxConfig mounts when present. */
function decodeTmpfsSizeMiB(config: unknown, guestPath: string): number | null {
  if (config === null || typeof config !== "object") {
    return null;
  }
  const mounts = (config as Record<string, unknown>)["mounts"];
  if (!Array.isArray(mounts)) {
    return null;
  }
  for (const entry of mounts) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const type = record["type"] ?? record["kind"];
    if (type !== "Tmpfs" && type !== "tmpfs") {
      continue;
    }
    if (record["guest"] !== guestPath) {
      continue;
    }
    const size = record["sizeMib"] ?? record["sizeMiB"];
    if (typeof size === "number" && Number.isInteger(size) && size > 0) {
      return size;
    }
    return null;
  }
  return null;
}

function readLabels(raw: unknown): Readonly<Record<string, string>> {
  if (raw === undefined || raw === null) {
    return Object.freeze({});
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("SandboxConfig.labels must be an object.");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`SandboxConfig.labels[${key}] must be a string.`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function readEnvEntries(raw: unknown): Readonly<Record<string, string>> {
  if (raw === undefined || raw === null) {
    return Object.freeze({});
  }
  if (!Array.isArray(raw)) {
    throw new Error("SandboxConfig.env must be an array of { key, value }.");
  }
  const out: Record<string, string> = {};
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      throw new Error("SandboxConfig.env entries must be objects.");
    }
    const record = entry as Record<string, unknown>;
    const key = record["key"];
    const value = record["value"];
    if (typeof key !== "string" || typeof value !== "string") {
      throw new Error("SandboxConfig.env entries must have string key and value.");
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a plain object.");
  }
  return value as Record<string, unknown>;
}

function readNullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Expected a string or null.");
  }
  return value;
}

function readRequiredPositiveInt(value: unknown, path: string, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return value;
}

function readNullablePositiveInt(value: unknown, path: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer or null.`);
  }
  return value;
}
