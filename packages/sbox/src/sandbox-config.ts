/**
 * Decode pinned microsandbox@0.6.6 SandboxConfig into application-owned fields.
 *
 * Exact shape confirmed via Sandbox.builder(...).build():
 * - image.Oci.reference
 * - resources.cpus / resources.memoryMib
 * - runtime.workdir / user / shell / hostname (nullable)
 * - env: [{ key, value }]
 * - labels: Record<string, string>
 *
 * Do not invent alternate shapes unless documented for this pin.
 * Not part of the public package declaration graph.
 */

import {
  PHASE1_DEFAULT_CPUS,
  PHASE1_DEFAULT_MEMORY_MIB,
  type SandboxImmutableCreation,
} from "./immutable-creation.js";

export interface DecodedSandboxConfig {
  readonly image: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly workdir: string | null;
  readonly user: string | null;
  readonly shell: string | null;
  readonly hostname: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
}

export function decodeSandboxConfig(config: unknown): DecodedSandboxConfig {
  if (config === null || typeof config !== "object") {
    throw new Error("SandboxConfig must be an object.");
  }
  const root = config as Record<string, unknown>;
  const resources = asRecord(root["resources"]);
  const runtime = asRecord(root["runtime"]);

  return {
    image: readOciImageReference(root["image"]),
    cpus: readRequiredPositiveInt(resources?.["cpus"], "resources.cpus", PHASE1_DEFAULT_CPUS),
    memoryMiB: readRequiredPositiveInt(
      resources?.["memoryMib"],
      "resources.memoryMib",
      PHASE1_DEFAULT_MEMORY_MIB,
    ),
    workdir: readNullableString(runtime?.["workdir"]),
    user: readNullableString(runtime?.["user"]),
    shell: readNullableString(runtime?.["shell"]),
    hostname: readNullableString(runtime?.["hostname"]),
    env: readEnvEntries(root["env"]),
    labels: readLabels(root["labels"]),
  };
}

export function projectDecodedConfig(decoded: DecodedSandboxConfig): SandboxImmutableCreation {
  return Object.freeze({
    image: decoded.image,
    cpus: decoded.cpus,
    memoryMiB: decoded.memoryMiB,
    workdir: decoded.workdir,
    user: decoded.user,
    shell: decoded.shell,
    hostname: decoded.hostname,
    env: Object.freeze({ ...decoded.env }),
  });
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
