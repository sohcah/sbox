/**
 * Local host↔guest transfer over Microsandbox single-file primitives plus
 * narrow agent FS helpers for symlink/mode preservation.
 *
 * Trees are prevalidated, staged beside the final destination on the same
 * filesystem, then published by rename/swap. Destinations are not mutated until
 * staging completes; `overwrite: "replace"` replaces rather than merges.
 */

import { chmod, lstat, mkdir, mkdtemp, readlink, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Sandbox } from "microsandbox";
import { SboxError, throwIfAborted } from "./errors.js";
import { agentReadLink, agentSetMode, agentSymlink } from "./internal/agent-fs.js";
import { mapNativeError } from "./microsandbox-runtime.js";
import { withConnectedSandbox } from "./local-process.js";
import { permissionBits } from "./transfer/archive.js";
import {
  assertGuestAbsolutePath,
  assertStandaloneSymlinkTarget,
  assertSymlinkTargetInsideRoot,
  posixDirname,
} from "./transfer/paths.js";
import { publishHostPath, removePathQuiet, stagingNameBeside } from "./transfer/publish-host.js";
import type { HostCopyOptions } from "./transfer/types.js";

/** Writable private mode used while staging directory trees. */
const STAGING_DIR_MODE = 0o700;

export async function copyHostToGuest(
  nativeName: string,
  hostPath: string,
  guestPath: string,
  options: HostCopyOptions = {},
): Promise<void> {
  throwIfAborted(options.signal);
  const absHost = resolve(hostPath);
  const absGuest = assertGuestAbsolutePath(guestPath, "guestPath");
  const overwrite = options.overwrite ?? "error";

  const hostStat = await lstat(absHost).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw SboxError.notFound("Host path was not found.", { details: { path: "hostPath" } });
    }
    throw SboxError.validation("Host path is not readable.", {
      cause: error,
      details: { path: "hostPath" },
    });
  });

  rejectSpecialHost(hostStat);

  return withConnectedSandbox(nativeName, async (sandbox) => {
    throwIfAborted(options.signal);
    if (hostStat.isSymbolicLink()) {
      const target = await readlink(absHost);
      assertStandaloneSymlinkTarget(target, absGuest, "guestPath");
      await ensureGuestParent(sandbox, absGuest);
      await publishGuestSymlink(
        nativeName,
        sandbox,
        absGuest,
        target,
        posixDirname(absGuest),
        overwrite,
      );
      return;
    }
    if (hostStat.isFile()) {
      await copyFileHostToGuest(nativeName, sandbox, absHost, absGuest, hostStat.mode, overwrite);
      return;
    }
    if (hostStat.isDirectory()) {
      await copyDirHostToGuest(nativeName, sandbox, absHost, absGuest, overwrite, options.signal);
      return;
    }
    throw SboxError.validation("Host path type is not supported for transfer.", {
      details: { path: "hostPath" },
    });
  });
}

export async function copyGuestToHost(
  nativeName: string,
  guestPath: string,
  hostPath: string,
  options: HostCopyOptions = {},
): Promise<void> {
  throwIfAborted(options.signal);
  const absHost = resolve(hostPath);
  const absGuest = assertGuestAbsolutePath(guestPath, "guestPath");
  const overwrite = options.overwrite ?? "error";

  return withConnectedSandbox(nativeName, async (sandbox) => {
    throwIfAborted(options.signal);
    const fs = sandbox.fs();
    let meta;
    try {
      meta = await fs.stat(absGuest);
    } catch (error) {
      throw mapNativeError(error);
    }

    if (meta.kind === "other") {
      throw SboxError.validation("Guest path type is not supported for transfer.", {
        details: { path: "guestPath" },
      });
    }

    if (meta.kind === "symlink") {
      const target = await agentReadLink(nativeName, absGuest);
      assertStandaloneSymlinkTarget(target, absGuest, "guestPath");
      await publishHostSymlink(absHost, target, overwrite);
      return;
    }
    if (meta.kind === "file") {
      await copyFileGuestToHost(sandbox, absGuest, absHost, meta.mode, overwrite);
      return;
    }
    if (meta.kind === "directory") {
      await copyDirGuestToHost(
        nativeName,
        sandbox,
        absGuest,
        absHost,
        absGuest,
        overwrite,
        options.signal,
      );
      return;
    }
    throw SboxError.validation("Guest path type is not supported for transfer.", {
      details: { path: "guestPath" },
    });
  });
}

function rejectSpecialHost(stat: {
  isFIFO(): boolean;
  isSocket(): boolean;
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
}): void {
  if (stat.isFIFO() || stat.isSocket() || stat.isCharacterDevice() || stat.isBlockDevice()) {
    throw SboxError.validation("Special files are not supported for transfer.", {
      details: { path: "hostPath" },
    });
  }
}

async function copyFileHostToGuest(
  nativeName: string,
  sandbox: Sandbox,
  hostPath: string,
  guestPath: string,
  mode: number,
  overwrite: "error" | "replace",
): Promise<void> {
  const fs = sandbox.fs();
  const exists = await fs.exists(guestPath);
  if (exists) {
    const existing = await fs.stat(guestPath);
    if (existing.kind === "directory") {
      throw SboxError.validation("Cannot overwrite a guest directory with a file.", {
        details: { path: "guestPath" },
      });
    }
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Guest destination already exists.", {
        details: { path: "guestPath" },
      });
    }
  }
  await ensureGuestParent(sandbox, guestPath);
  const staging = guestStagingPath(guestPath, "file");
  try {
    await fs.copyFromHost(hostPath, staging);
    await agentSetMode(nativeName, staging, permissionBits(mode), false);
    await publishGuestPath(sandbox, staging, guestPath, exists && overwrite === "replace");
  } catch (error) {
    try {
      if (await fs.exists(staging)) {
        await fs.remove(staging);
      }
    } catch {
      // Best-effort staging cleanup.
    }
    if (error instanceof SboxError) {
      throw error;
    }
    throw mapNativeError(error);
  }
}

async function copyDirHostToGuest(
  nativeName: string,
  sandbox: Sandbox,
  hostRoot: string,
  guestRoot: string,
  overwrite: "error" | "replace",
  signal: AbortSignal | undefined,
): Promise<void> {
  const fs = sandbox.fs();
  const exists = await fs.exists(guestRoot);
  if (exists) {
    const existing = await fs.stat(guestRoot);
    if (existing.kind !== "directory") {
      throw SboxError.validation("Cannot overwrite a guest file with a directory.", {
        details: { path: "guestPath" },
      });
    }
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Guest destination already exists.", {
        details: { path: "guestPath" },
      });
    }
  }

  // Prevalidate the complete source tree before any guest mutation.
  await prevalidateHostTree(hostRoot, guestRoot, guestRoot, signal);

  await ensureGuestParent(sandbox, guestRoot);
  const stagingRoot = guestStagingPath(guestRoot, "dir");
  const rootStat = await lstat(hostRoot);
  try {
    await fs.mkdir(stagingRoot);
    await agentSetMode(nativeName, stagingRoot, STAGING_DIR_MODE, false);
    await materializeHostTreeIntoGuest(nativeName, sandbox, hostRoot, stagingRoot, signal);
    // Keep the staged root writable through rename (Darwin denies renaming a
    // directory after a restrictive chmod). Apply the final root mode in
    // beforeCommit so failure restores any previous destination.
    await publishGuestPath(sandbox, stagingRoot, guestRoot, exists, async (published) => {
      await agentSetMode(nativeName, published, permissionBits(rootStat.mode), false);
    });
  } catch (error) {
    try {
      if (await fs.exists(stagingRoot)) {
        await fs.remove(stagingRoot);
      }
    } catch {
      // Best-effort staging cleanup.
    }
    throw error;
  }
}

async function prevalidateHostTree(
  hostRoot: string,
  guestRoot: string,
  transferRoot: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(hostRoot, { withFileTypes: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    const hostChild = join(hostRoot, entry.name);
    const guestChild = guestRoot === "/" ? `/${entry.name}` : `${guestRoot}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      const target = await readlink(hostChild);
      assertSymlinkTargetInsideRoot(target, guestRoot, transferRoot, "hostPath");
      continue;
    }
    if (entry.isFile()) {
      const st = await lstat(hostChild);
      rejectSpecialHost(st);
      continue;
    }
    if (entry.isDirectory()) {
      await prevalidateHostTree(hostChild, guestChild, transferRoot, signal);
      continue;
    }
    throw SboxError.validation("Special files are not supported for transfer.", {
      details: { path: "hostPath" },
    });
  }
}

async function materializeHostTreeIntoGuest(
  nativeName: string,
  sandbox: Sandbox,
  hostRoot: string,
  stagingRoot: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const fs = sandbox.fs();
  const entries = await readdir(hostRoot, { withFileTypes: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    const hostChild = join(hostRoot, entry.name);
    const stagingChild = stagingRoot === "/" ? `/${entry.name}` : `${stagingRoot}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      const target = await readlink(hostChild);
      await agentSymlink(nativeName, target, stagingChild);
      continue;
    }
    if (entry.isFile()) {
      const st = await lstat(hostChild);
      await fs.copyFromHost(hostChild, stagingChild);
      await agentSetMode(nativeName, stagingChild, permissionBits(st.mode), false);
      continue;
    }
    if (entry.isDirectory()) {
      const st = await lstat(hostChild);
      await fs.mkdir(stagingChild);
      await agentSetMode(nativeName, stagingChild, STAGING_DIR_MODE, false);
      await materializeHostTreeIntoGuest(nativeName, sandbox, hostChild, stagingChild, signal);
      await agentSetMode(nativeName, stagingChild, permissionBits(st.mode), false);
    }
  }
}

async function copyFileGuestToHost(
  sandbox: Sandbox,
  guestPath: string,
  hostPath: string,
  mode: number,
  overwrite: "error" | "replace",
): Promise<void> {
  let hostExists = false;
  try {
    const st = await lstat(hostPath);
    hostExists = true;
    if (st.isDirectory()) {
      throw SboxError.validation("Cannot overwrite a host directory with a file.", {
        details: { path: "hostPath" },
      });
    }
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Host destination already exists.", {
        details: { path: "hostPath" },
      });
    }
  } catch (error) {
    if (error instanceof SboxError) {
      throw error;
    }
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw SboxError.validation("Host destination is not accessible.", {
        cause: error,
        details: { path: "hostPath" },
      });
    }
  }

  await mkdir(dirname(hostPath), { recursive: true });
  const staging = stagingNameBeside(hostPath, "file");
  try {
    await sandbox.fs().copyToHost(guestPath, staging);
    await chmod(staging, permissionBits(mode));
    await publishHostPath({
      stagingPath: staging,
      destPath: hostPath,
      destExists: hostExists,
      remove: removePathQuiet,
    });
  } catch (error) {
    await removePathQuiet(staging, false).catch(() => undefined);
    if (error instanceof SboxError) {
      throw error;
    }
    throw mapNativeError(error);
  }
}

async function copyDirGuestToHost(
  nativeName: string,
  sandbox: Sandbox,
  guestRoot: string,
  hostRoot: string,
  transferRoot: string,
  overwrite: "error" | "replace",
  signal: AbortSignal | undefined,
): Promise<void> {
  let hostExists = false;
  try {
    const st = await lstat(hostRoot);
    hostExists = true;
    if (!st.isDirectory()) {
      throw SboxError.validation("Cannot overwrite a host file with a directory.", {
        details: { path: "hostPath" },
      });
    }
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Host destination already exists.", {
        details: { path: "hostPath" },
      });
    }
  } catch (error) {
    if (error instanceof SboxError) {
      throw error;
    }
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw SboxError.validation("Host destination is not accessible.", {
        cause: error,
        details: { path: "hostPath" },
      });
    }
  }

  // Prevalidate guest tree before touching the host destination.
  await prevalidateGuestTree(nativeName, sandbox, guestRoot, transferRoot, signal);

  const parent = dirname(hostRoot);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(join(parent, `.sbox-stage-${process.pid}-`));

  try {
    await materializeGuestTreeOntoHost(nativeName, sandbox, guestRoot, stagingRoot, signal);
    let rootMeta;
    try {
      rootMeta = await sandbox.fs().stat(guestRoot);
    } catch (error) {
      throw mapNativeError(error);
    }
    // Keep the staged root writable through rename (Darwin denies renaming a
    // directory after a restrictive chmod). Apply the final root mode in
    // beforeCommit so failure restores any previous destination.
    await publishHostPath({
      stagingPath: stagingRoot,
      destPath: hostRoot,
      destExists: hostExists,
      remove: removePathQuiet,
      beforeCommit: async (published) => {
        await chmod(published, permissionBits(rootMeta.mode));
      },
    });
  } catch (error) {
    await removePathQuiet(stagingRoot, true).catch(() => undefined);
    throw error;
  }
}

async function prevalidateGuestTree(
  nativeName: string,
  sandbox: Sandbox,
  guestRoot: string,
  transferRoot: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const entries = await sandbox.fs().list(guestRoot);
  for (const entry of entries) {
    throwIfAborted(signal);
    const name = basenamePosix(entry.path);
    const guestChild = guestRoot === "/" ? `/${name}` : `${guestRoot}/${name}`;
    if (entry.kind === "other") {
      throw SboxError.validation("Special files are not supported for transfer.", {
        details: { path: "guestPath" },
      });
    }
    if (entry.kind === "symlink") {
      const target = await agentReadLink(nativeName, guestChild);
      assertSymlinkTargetInsideRoot(target, guestRoot, transferRoot, "guestPath");
      continue;
    }
    if (entry.kind === "directory") {
      await prevalidateGuestTree(nativeName, sandbox, guestChild, transferRoot, signal);
    }
  }
}

async function materializeGuestTreeOntoHost(
  nativeName: string,
  sandbox: Sandbox,
  guestRoot: string,
  hostRoot: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await mkdir(hostRoot, { recursive: true });
  await chmod(hostRoot, STAGING_DIR_MODE);
  const entries = await sandbox.fs().list(guestRoot);
  for (const entry of entries) {
    throwIfAborted(signal);
    const name = basenamePosix(entry.path);
    const guestChild = guestRoot === "/" ? `/${name}` : `${guestRoot}/${name}`;
    const hostChild = join(hostRoot, name);

    if (entry.kind === "symlink") {
      const target = await agentReadLink(nativeName, guestChild);
      await writeHostSymlinkFresh(hostChild, target);
      continue;
    }
    if (entry.kind === "file") {
      const staging = stagingNameBeside(hostChild, "file");
      try {
        await sandbox.fs().copyToHost(guestChild, staging);
        await chmod(staging, permissionBits(entry.mode));
        await rename(staging, hostChild);
      } catch (error) {
        await removePathQuiet(staging, false).catch(() => undefined);
        throw mapNativeError(error);
      }
      continue;
    }
    if (entry.kind === "directory") {
      await mkdir(hostChild, { recursive: true });
      await chmod(hostChild, STAGING_DIR_MODE);
      await materializeGuestTreeOntoHost(nativeName, sandbox, guestChild, hostChild, signal);
      await chmod(hostChild, permissionBits(entry.mode));
    }
  }
}

async function publishGuestPath(
  sandbox: Sandbox,
  stagingPath: string,
  destPath: string,
  destExists: boolean,
  beforeCommit?: (destPath: string) => Promise<void>,
): Promise<void> {
  const fs = sandbox.fs();
  if (!destExists) {
    await fs.rename(stagingPath, destPath);
    try {
      await beforeCommit?.(destPath);
    } catch (error) {
      try {
        if (await fs.exists(destPath)) {
          await fs.remove(destPath);
        }
      } catch {
        // Best-effort rollback of the unpublished destination.
      }
      throw error;
    }
    return;
  }

  const backup = guestBackupPath(destPath);
  await fs.rename(destPath, backup);
  try {
    await fs.rename(stagingPath, destPath);
  } catch (error) {
    try {
      await fs.rename(backup, destPath);
    } catch {
      throw SboxError.internal("Failed to publish transfer and restore the previous destination.", {
        cause: error,
        details: { path: "guestPath" },
      });
    }
    throw mapNativeError(error);
  }
  try {
    await beforeCommit?.(destPath);
  } catch (error) {
    try {
      if (await fs.exists(destPath)) {
        await fs.remove(destPath);
      }
    } catch {
      // Continue to restore the previous destination.
    }
    try {
      await fs.rename(backup, destPath);
    } catch (restoreError) {
      throw SboxError.internal(
        "Failed to apply transfer finalization and restore the previous destination.",
        {
          cause: restoreError,
          details: { path: "guestPath" },
        },
      );
    }
    throw error;
  }
  try {
    await fs.remove(backup);
  } catch {
    // Best-effort backup cleanup after successful publish.
  }
}

function guestStagingPath(destPath: string, kind: "file" | "dir"): string {
  const parent = posixDirname(destPath);
  const base = basenamePosix(destPath) || "root";
  const token = randomBytes(8).toString("hex");
  const name =
    kind === "dir"
      ? `.sbox-stage-${base}-${process.pid}-${token}`
      : `.sbox-tmp-${base}-${process.pid}-${token}`;
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function guestBackupPath(destPath: string): string {
  const parent = posixDirname(destPath);
  const base = basenamePosix(destPath) || "root";
  const token = randomBytes(8).toString("hex");
  const name = `.sbox-bak-${base}-${process.pid}-${token}`;
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

async function ensureGuestParent(sandbox: Sandbox, guestPath: string): Promise<void> {
  const parent = posixDirname(guestPath);
  if (parent === "/" || parent === ".") {
    return;
  }
  const fs = sandbox.fs();
  if (!(await fs.exists(parent))) {
    await ensureGuestParent(sandbox, parent);
    await fs.mkdir(parent);
  }
}

function basenamePosix(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

async function publishGuestSymlink(
  nativeName: string,
  sandbox: Sandbox,
  guestPath: string,
  target: string,
  root: string,
  overwrite: "error" | "replace",
): Promise<void> {
  assertSymlinkTargetInsideRoot(target, posixDirname(guestPath), root, "guestPath");
  const fs = sandbox.fs();
  const exists = await fs.exists(guestPath);
  if (exists) {
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Guest destination already exists.", {
        details: { path: "guestPath" },
      });
    }
    const existing = await fs.stat(guestPath);
    if (existing.kind === "directory") {
      throw SboxError.validation("Cannot overwrite a guest directory with a symlink.", {
        details: { path: "guestPath" },
      });
    }
  }
  await ensureGuestParent(sandbox, guestPath);
  const staging = guestStagingPath(guestPath, "file");
  try {
    await agentSymlink(nativeName, target, staging);
    await publishGuestPath(sandbox, staging, guestPath, exists);
  } catch (error) {
    try {
      if (await fs.exists(staging)) {
        await fs.remove(staging);
      }
    } catch {
      // Ignore.
    }
    throw error;
  }
}

async function publishHostSymlink(
  hostPath: string,
  target: string,
  overwrite: "error" | "replace",
): Promise<void> {
  let hostExists = false;
  try {
    const st = await lstat(hostPath);
    hostExists = true;
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Host destination already exists.", {
        details: { path: "hostPath" },
      });
    }
    if (st.isDirectory()) {
      throw SboxError.validation("Cannot overwrite a host directory with a symlink.", {
        details: { path: "hostPath" },
      });
    }
  } catch (error) {
    if (error instanceof SboxError) {
      throw error;
    }
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw SboxError.validation("Host destination is not accessible.", {
        cause: error,
        details: { path: "hostPath" },
      });
    }
  }

  await mkdir(dirname(hostPath), { recursive: true });
  const staging = stagingNameBeside(hostPath, "file");
  try {
    await writeHostSymlinkFresh(staging, target);
    await publishHostPath({
      stagingPath: staging,
      destPath: hostPath,
      destExists: hostExists,
      remove: removePathQuiet,
    });
  } catch (error) {
    await removePathQuiet(staging, false).catch(() => undefined);
    throw error;
  }
}

async function writeHostSymlinkFresh(hostPath: string, target: string): Promise<void> {
  const { symlink } = await import("node:fs/promises");
  await symlink(target, hostPath);
}
