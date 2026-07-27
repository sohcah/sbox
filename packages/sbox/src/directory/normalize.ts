/**
 * Validate and normalize profile directory mount attachments.
 */

import { isAbsoluteGuestPath, isBinarySize, parseBinarySizeToMiB } from "../config/scalars.js";
import type { ConfigurationIssue, DirectoryMountConfig } from "../config/types.js";
import type { DirectoryMountSource } from "./types.js";

export function normalizeDirectoryMountConfig(
  raw: DirectoryMountConfig,
  pathPrefix: string,
):
  | { readonly ok: true; readonly value: RequiredDirectoryMount }
  | { readonly ok: false; readonly issues: ConfigurationIssue[] } {
  const issues: ConfigurationIssue[] = [];
  const source: DirectoryMountSource = raw.source ?? "client";
  const readonly = raw.readonly ?? true;

  if (source !== "client" && source !== "host") {
    issues.push({ path: `${pathPrefix}.source`, message: 'Expected "client" or "host".' });
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
    if (!raw.path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(raw.path)) {
      issues.push({
        path: `${pathPrefix}.path`,
        message: "Host path must be absolute.",
      });
    }
  }
  if (source === "client" && !readonly) {
    issues.push({
      path: `${pathPrefix}.readonly`,
      message: "Client-sourced directory mounts must be read-only.",
    });
  }
  if (readonly && raw.quota !== undefined) {
    issues.push({
      path: `${pathPrefix}.quota`,
      message: "Quota is only allowed for writable Host directory mounts.",
    });
  }
  if (!readonly && raw.quota === undefined) {
    issues.push({
      path: `${pathPrefix}.quota`,
      message: "Writable Host directory mounts require an explicit quota.",
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
    },
  };
}

export type RequiredDirectoryMount = {
  readonly path: string;
  readonly mount: string;
  readonly source: DirectoryMountSource;
  readonly readonly: boolean;
  readonly quotaMiB?: number;
  readonly quota?: string;
};
