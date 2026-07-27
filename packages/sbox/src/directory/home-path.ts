/**
 * Expand a leading `~/` (or `~\`) to the process home directory.
 *
 * Only the lone-home forms `~`, `~/…`, and `~\…` are expanded — `~user/…` is left alone.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function isHomeRelativePath(path: string): boolean {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

export function isAbsoluteHostPath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path);
}

/** Absolute Host path, or home-relative form expanded on the Host. */
export function isAbsoluteOrHomeRelativeHostPath(path: string): boolean {
  return isAbsoluteHostPath(path) || isHomeRelativePath(path);
}

export function expandHomePrefix(path: string, home: string = homedir()): string {
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(home, path.slice(2));
  }
  return path;
}
