/**
 * Validate and normalize profile Host mount attachments.
 */

import { isAbsoluteGuestPath, isBinarySize, parseBinarySizeToMiB } from "../config/scalars.js";
import type { ConfigurationIssue, HostMountConfig } from "../config/types.js";
import { isAbsoluteOrHomeRelativeHostPath } from "./home-path.js";
import type { MountSource } from "./types.js";

export function normalizeHostMountConfig(
  raw: HostMountConfig,
  pathPrefix: string,
):
  | { readonly ok: true; readonly value: RequiredHostMount }
  | { readonly ok: false; readonly issues: ConfigurationIssue[] } {
  const issues: ConfigurationIssue[] = [];
  const source: MountSource = raw.source ?? "client";
  const readonly = raw.readonly ?? true;
  const mode = raw.mode ?? "bind";

  if (source !== "client" && source !== "host") {
    issues.push({ path: `${pathPrefix}.source`, message: 'Expected "client" or "host".' });
  }
  if (mode !== "bind" && mode !== "copy") {
    issues.push({ path: `${pathPrefix}.mode`, message: 'Expected "bind" or "copy".' });
  }
  if (typeof raw.path !== "string" || raw.path.trim().length === 0) {
    issues.push({ path: `${pathPrefix}.path`, message: "Expected a non-empty path." });
  }
  if (typeof raw.mount !== "string" || !isAbsoluteGuestPath(raw.mount)) {
    issues.push({
      path: `${pathPrefix}.mount`,
      message: "Expected an absolute POSIX guest path.",
    });
  }
  if (source === "host" && typeof raw.path === "string" && raw.path.length > 0) {
    if (!isAbsoluteOrHomeRelativeHostPath(raw.path)) {
      issues.push({
        path: `${pathPrefix}.path`,
        message: 'Host path must be absolute or home-relative (starting with "~/").',
      });
    }
  }
  if (source === "client" && !readonly) {
    issues.push({
      path: `${pathPrefix}.readonly`,
      message: "Client-sourced Host mounts must be read-only.",
    });
  }
  if (mode === "copy" && !readonly) {
    issues.push({
      path: `${pathPrefix}.readonly`,
      message: "Copy mounts are one-shot snapshots and must be read-only.",
    });
  }
  if (mode === "copy" && raw.quota !== undefined) {
    issues.push({
      path: `${pathPrefix}.quota`,
      message: "Quota is only allowed for writable Host bind mounts.",
    });
  }
  if (readonly && raw.quota !== undefined) {
    issues.push({
      path: `${pathPrefix}.quota`,
      message: "Quota is only allowed for writable Host mounts.",
    });
  }
  if (raw.followEscapingSymlinks === true && source !== "client") {
    issues.push({
      path: `${pathPrefix}.followEscapingSymlinks`,
      message: "followEscapingSymlinks is only allowed for Client-sourced Host mounts.",
    });
  }
  let quotaMiB: number | undefined;
  if (raw.quota !== undefined) {
    if (!isBinarySize(raw.quota)) {
      issues.push({
        path: `${pathPrefix}.quota`,
        message: 'Expected a positive binary size such as "512MiB".',
      });
    } else {
      try {
        quotaMiB = parseBinarySizeToMiB(raw.quota, `${pathPrefix}.quota`);
      } catch (error) {
        issues.push({
          path: `${pathPrefix}.quota`,
          message: error instanceof Error ? error.message : "Invalid quota.",
        });
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      path: raw.path.trim(),
      mount: raw.mount,
      source,
      readonly,
      ...(quotaMiB !== undefined ? { quotaMiB } : {}),
      ...(raw.quota !== undefined ? { quota: raw.quota } : {}),
      ...(raw.followEscapingSymlinks === true ? { followEscapingSymlinks: true } : {}),
      ...(mode === "copy" ? { mode: "copy" as const } : {}),
    },
  };
}

export type RequiredHostMount = {
  readonly path: string;
  readonly mount: string;
  readonly source: MountSource;
  readonly readonly: boolean;
  readonly quotaMiB?: number;
  readonly quota?: string;
  readonly followEscapingSymlinks?: boolean;
  readonly mode?: "bind" | "copy";
};

/** @deprecated Use normalizeHostMountConfig */
export const normalizeDirectoryMountConfig = normalizeHostMountConfig;
/** @deprecated Use RequiredHostMount */
export type RequiredDirectoryMount = RequiredHostMount;
