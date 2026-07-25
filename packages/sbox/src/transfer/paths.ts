/**
 * Transfer path validation shared by host and guest trust boundaries.
 */

import { SboxError } from "../errors.js";

const NUL = "\0";

export function assertRelativeTransferPath(path: string, label: string): string {
  if (path.length === 0) {
    throw SboxError.validation(`${label} must not be empty.`, {
      details: { path: label },
    });
  }
  if (path.includes(NUL)) {
    throw SboxError.validation(`${label} must not contain NUL.`, {
      details: { path: label },
    });
  }
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    throw SboxError.validation(`${label} must be a relative path.`, {
      details: { path: label },
    });
  }
  const parts = path.replaceAll("\\", "/").split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw SboxError.validation(`${label} must not contain empty, '.', or '..' segments.`, {
        details: { path: label },
      });
    }
  }
  return parts.join("/");
}

export function assertGuestAbsolutePath(path: string, label: string): string {
  if (path.length === 0) {
    throw SboxError.validation(`${label} must not be empty.`, {
      details: { path: label },
    });
  }
  if (path.includes(NUL)) {
    throw SboxError.validation(`${label} must not contain NUL.`, {
      details: { path: label },
    });
  }
  if (!path.startsWith("/")) {
    throw SboxError.validation(`${label} must be an absolute guest path.`, {
      details: { path: label },
    });
  }
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "..") {
      throw SboxError.validation(`${label} must not contain '..' segments.`, {
        details: { path: label },
      });
    }
  }
  return path;
}

export function joinGuestPath(base: string, relative: string): string {
  const normalizedBase = base.endsWith("/") && base !== "/" ? base.slice(0, -1) : base;
  const rel = assertRelativeTransferPath(relative, "archive member path");
  if (normalizedBase === "/") {
    return `/${rel}`;
  }
  return `${normalizedBase}/${rel}`;
}

export function isSafeSymlinkTarget(target: string, linkDir: string, root: string): boolean {
  if (target.includes(NUL)) {
    return false;
  }
  // Absolute targets are not portable across host/guest filesystem namespaces.
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\")) {
    return false;
  }
  const resolved = resolvePosixRelative(linkDir, target);
  return isPathInsideRoot(resolved, root);
}

/**
 * Standalone symlink transfers use the link's parent directory as the
 * containment root. Relative targets like `sibling` are allowed; absolute
 * targets and `../escape` are rejected so published links stay meaningful
 * across the host/guest boundary.
 */
export function assertStandaloneSymlinkTarget(
  target: string,
  linkPath: string,
  detailPath: string,
): void {
  const parent = posixDirname(linkPath);
  assertSymlinkTargetInsideRoot(target, parent, parent, detailPath);
}

export function assertSymlinkTargetInsideRoot(
  target: string,
  linkDir: string,
  root: string,
  detailPath: string,
): void {
  if (target.includes(NUL)) {
    throw SboxError.validation("Symlink target must not contain NUL.", {
      details: { path: detailPath },
    });
  }
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\")) {
    throw SboxError.validation(
      "Absolute symlink targets are not supported for portable transfer.",
      { details: { path: detailPath } },
    );
  }
  if (!isSafeSymlinkTarget(target, linkDir, root)) {
    throw SboxError.validation("Symlink target escapes the transfer root.", {
      details: { path: detailPath },
    });
  }
}

export function posixDirname(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) {
    return "/";
  }
  return path.slice(0, idx);
}

function resolvePosixRelative(baseDir: string, relative: string): string {
  const start = baseDir === "/" ? [] : baseDir.split("/").filter(Boolean);
  const parts = [...start];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return "/..";
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function isPathInsideRoot(path: string, root: string): boolean {
  if (path.split("/").includes("..")) {
    return false;
  }
  const normalizedRoot = root === "/" ? "/" : root.replace(/\/+$/, "");
  if (normalizedRoot === "/") {
    return path.startsWith("/");
  }
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}
