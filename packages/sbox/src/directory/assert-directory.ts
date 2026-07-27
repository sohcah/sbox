/**
 * Assert a Host/Client directory root is safe to bind (real directory, not a symlink).
 */

import { lstat } from "node:fs/promises";
import { SboxError } from "../errors.js";

export async function assertBindableDirectory(hostPath: string, detailPath: string): Promise<void> {
  let st;
  try {
    st = await lstat(hostPath);
  } catch {
    throw SboxError.notFound(`Directory mount path was not found.`, {
      details: { path: detailPath, hostPath },
    });
  }
  if (st.isSymbolicLink()) {
    throw SboxError.validation("Directory mount path must not be a symlink.", {
      details: { path: detailPath, hostPath },
    });
  }
  if (!st.isDirectory()) {
    throw SboxError.validation("Directory mount path must be a directory.", {
      details: { path: detailPath, hostPath },
    });
  }
}
