/**
 * Encode/decode directory attachment specs on ownership labels for inspection.
 */

import type { LabelMap } from "../ownership.js";
import { OWNERSHIP_LABEL_KEYS } from "../ownership.js";
import { canonicalDirectoriesFingerprint, type DirectoryAttachmentSpec } from "./types.js";

export function directoriesLabelValue(directories: readonly DirectoryAttachmentSpec[]): string {
  return Buffer.from(JSON.stringify(canonicalDirectoriesFingerprint(directories)), "utf8").toString(
    "base64url",
  );
}

export function directoriesFromLabels(
  labels: LabelMap | undefined,
): readonly DirectoryAttachmentSpec[] {
  if (labels === undefined) {
    return [];
  }
  const raw = labels[OWNERSHIP_LABEL_KEYS.directories];
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: DirectoryAttachmentSpec[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (
        (record["source"] !== "client" && record["source"] !== "host") ||
        typeof record["path"] !== "string" ||
        typeof record["mount"] !== "string" ||
        typeof record["readonly"] !== "boolean"
      ) {
        continue;
      }
      out.push({
        source: record["source"],
        path: record["path"],
        mount: record["mount"],
        readonly: record["readonly"],
        ...(typeof record["quotaMiB"] === "number" ? { quotaMiB: record["quotaMiB"] } : {}),
      });
    }
    return Object.freeze(canonicalDirectoriesFingerprint(out));
  } catch {
    return [];
  }
}
