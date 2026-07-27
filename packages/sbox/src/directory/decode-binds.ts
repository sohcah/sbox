/**
 * Decode Bind mounts from pinned Microsandbox SandboxConfig.
 */

import { SboxError } from "../errors.js";
import type { NativeBindMount } from "../native-runtime.js";

export function decodeBindMounts(config: unknown): readonly NativeBindMount[] {
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
  const out: NativeBindMount[] = [];
  for (let i = 0; i < mounts.length; i += 1) {
    const entry = mounts[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw SboxError.internal(`SandboxConfig.mounts[${i}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const type = record["type"] ?? record["kind"];
    if (type !== "Bind" && type !== "bind") {
      continue;
    }
    const host = record["host"];
    const guest = record["guest"];
    if (typeof host !== "string" || host.length === 0) {
      throw SboxError.internal(`SandboxConfig.mounts[${i}].host must be a non-empty string.`);
    }
    if (typeof guest !== "string" || guest.length === 0) {
      throw SboxError.internal(`SandboxConfig.mounts[${i}].guest must be a non-empty string.`);
    }
    let readonly = false;
    const options = record["options"];
    if (options !== null && typeof options === "object" && !Array.isArray(options)) {
      readonly = (options as Record<string, unknown>)["readonly"] === true;
    } else if (record["readonly"] === true) {
      readonly = true;
    }
    const quotaRaw = record["quotaMib"] ?? record["quotaMiB"];
    let quotaMiB: number | undefined;
    if (typeof quotaRaw === "number" && Number.isInteger(quotaRaw) && quotaRaw > 0) {
      quotaMiB = quotaRaw;
    } else if (quotaRaw !== null && quotaRaw !== undefined) {
      throw SboxError.internal(
        `SandboxConfig.mounts[${i}].quotaMib must be a positive integer or null.`,
      );
    }
    out.push({
      guestPath: guest,
      hostPath: host,
      readonly,
      ...(quotaMiB !== undefined ? { quotaMiB } : {}),
    });
  }
  return Object.freeze(out);
}

/** Guest path / mode surface used for native ownership matching (not host paths). */
export function canonicalBindMountFingerprint(binds: readonly NativeBindMount[]): readonly {
  readonly guestPath: string;
  readonly readonly: boolean;
  readonly quotaMiB?: number;
}[] {
  return Object.freeze(
    [...binds]
      .map((mount) =>
        Object.freeze({
          guestPath: mount.guestPath,
          readonly: mount.readonly,
          ...(mount.quotaMiB !== undefined ? { quotaMiB: mount.quotaMiB } : {}),
        }),
      )
      .toSorted((a, b) => a.guestPath.localeCompare(b.guestPath)),
  );
}

export function bindMountsMatchHostMounts(
  bindMounts: readonly NativeBindMount[],
  mounts: readonly {
    readonly mount: string;
    readonly readonly: boolean;
    readonly quotaMiB?: number;
  }[],
): boolean {
  const expected = canonicalBindMountFingerprint(
    mounts.map((entry) => ({
      guestPath: entry.mount,
      hostPath: "",
      readonly: entry.readonly,
      ...(entry.quotaMiB !== undefined ? { quotaMiB: entry.quotaMiB } : {}),
    })),
  );
  const actual = canonicalBindMountFingerprint(bindMounts);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** @deprecated Use bindMountsMatchHostMounts */
export const bindMountsMatchDirectories = bindMountsMatchHostMounts;
