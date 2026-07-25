/**
 * Decode DiskImage mounts from pinned Microsandbox SandboxConfig.
 */

import { SboxError } from "../errors.js";

export interface DecodedDiskMount {
  readonly host: string;
  readonly guest: string;
  readonly format: string;
  readonly fstype: string | null;
  readonly readonly: boolean;
}

export function decodeDiskMounts(config: unknown): readonly DecodedDiskMount[] {
  if (config === null || typeof config !== "object") {
    return [];
  }
  const mounts = (config as Record<string, unknown>)["mounts"];
  if (mounts === undefined) {
    return [];
  }
  if (!Array.isArray(mounts)) {
    throw SboxError.internal("SandboxConfig.mounts must be an array when present.");
  }
  const out: DecodedDiskMount[] = [];
  for (let i = 0; i < mounts.length; i += 1) {
    const entry = mounts[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw SboxError.internal(`SandboxConfig.mounts[${i}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const type = record["type"] ?? record["kind"];
    if (type !== "DiskImage" && type !== "disk") {
      continue;
    }
    const host = record["host"];
    const guest = record["guest"];
    const formatRaw = record["format"];
    if (typeof host !== "string" || host.length === 0) {
      throw SboxError.internal(`SandboxConfig.mounts[${i}].host must be a non-empty string.`);
    }
    if (typeof guest !== "string" || guest.length === 0) {
      throw SboxError.internal(`SandboxConfig.mounts[${i}].guest must be a non-empty string.`);
    }
    // Microsandbox's NapiVolumeMount marks format optional; default qcow2 for managed disks.
    const format = typeof formatRaw === "string" && formatRaw.length > 0 ? formatRaw : "qcow2";
    const fstypeRaw = record["fstype"];
    const fstype =
      fstypeRaw === null || fstypeRaw === undefined
        ? null
        : typeof fstypeRaw === "string"
          ? fstypeRaw
          : null;
    const options = record["options"];
    let readonly = false;
    if (options !== null && typeof options === "object" && !Array.isArray(options)) {
      readonly = (options as Record<string, unknown>)["readonly"] === true;
    }
    out.push({
      host,
      guest,
      format: format.toLowerCase() === "qcow2" ? "qcow2" : format,
      fstype,
      readonly,
    });
  }
  return Object.freeze(out);
}
