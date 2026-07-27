/**
 * Assert a Host/Client path is safe to bind (real file or directory, not a symlink).
 */

import { lstat } from "node:fs/promises";
import { SboxError } from "../errors.js";
import type { MountKind } from "./types.js";

export async function assertBindablePath(hostPath: string, detailPath: string): Promise<MountKind> {
  let st;
  try {
    st = await lstat(hostPath);
  } catch {
    throw SboxError.notFound(`Host mount path was not found.`, {
      details: { path: detailPath, hostPath },
    });
  }
  if (st.isSymbolicLink()) {
    throw SboxError.validation("Host mount path must not be a symlink.", {
      details: { path: detailPath, hostPath },
    });
  }
  if (st.isDirectory()) {
    return "directory";
  }
  if (st.isFile()) {
    return "file";
  }
  throw SboxError.validation("Host mount path must be a file or directory.", {
    details: { path: detailPath, hostPath },
  });
}

/** @deprecated Use assertBindablePath */
export async function assertBindableDirectory(hostPath: string, detailPath: string): Promise<void> {
  const kind = await assertBindablePath(hostPath, detailPath);
  if (kind !== "directory") {
    throw SboxError.validation("Host mount path must be a directory.", {
      details: { path: detailPath, hostPath },
    });
  }
}
