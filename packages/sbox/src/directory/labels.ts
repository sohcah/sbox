/**
 * Encode/decode Host mount attachment specs on ownership labels for inspection.
 */

import type { LabelMap } from "../ownership.js";
import { OWNERSHIP_LABEL_KEYS } from "../ownership.js";
import { canonicalMountsFingerprint, type MountAttachmentSpec, type MountKind } from "./types.js";

export function mountsLabelValue(mounts: readonly MountAttachmentSpec[]): string {
  return Buffer.from(JSON.stringify(canonicalMountsFingerprint(mounts)), "utf8").toString(
    "base64url",
  );
}

export function mountsFromLabels(labels: LabelMap | undefined): readonly MountAttachmentSpec[] {
  if (labels === undefined) {
    return [];
  }
  const raw = labels[OWNERSHIP_LABEL_KEYS.mounts];
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: MountAttachmentSpec[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const kind = record["kind"];
      if (
        (record["source"] !== "client" && record["source"] !== "host") ||
        typeof record["path"] !== "string" ||
        typeof record["mount"] !== "string" ||
        typeof record["readonly"] !== "boolean" ||
        (kind !== "file" && kind !== "directory")
      ) {
        continue;
      }
      out.push({
        source: record["source"],
        path: record["path"],
        mount: record["mount"],
        readonly: record["readonly"],
        kind: kind as MountKind,
        ...(typeof record["quotaMiB"] === "number" ? { quotaMiB: record["quotaMiB"] } : {}),
        ...(record["followEscapingSymlinks"] === true ? { followEscapingSymlinks: true } : {}),
        ...(record["mode"] === "copy" ? { mode: "copy" as const } : {}),
      });
    }
    return Object.freeze(canonicalMountsFingerprint(out));
  } catch {
    return [];
  }
}

/** @deprecated Use mountsLabelValue */
export const directoriesLabelValue = mountsLabelValue;
/** @deprecated Use mountsFromLabels */
export const directoriesFromLabels = mountsFromLabels;
