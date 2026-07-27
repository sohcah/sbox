/**
 * HostCreateRequest directory mount invariants (trust boundary).
 */

import { isAbsoluteGuestPath } from "../config/scalars.js";
import { SboxError } from "../errors.js";
import { isAbsoluteOrHomeRelativeHostPath } from "./home-path.js";
import type { HostDirectoryMount } from "./types.js";

/**
 * Enforce product invariants on every create request (local and remote decode).
 * Does not check filesystem existence — that remains create-time bind prep.
 */
export function assertHostDirectoryMounts(
  directories: readonly HostDirectoryMount[] | undefined,
  volumes?: readonly { readonly path: string }[],
): void {
  if (directories === undefined || directories.length === 0) {
    return;
  }

  const seen = new Set<string>();
  for (const attachment of volumes ?? []) {
    seen.add(attachment.path);
  }

  for (let i = 0; i < directories.length; i += 1) {
    const entry = directories[i]!;
    const prefix = `directories.${i}`;

    if (entry.source !== "client" && entry.source !== "host") {
      throw SboxError.validation('Directory mount source must be "client" or "host".', {
        details: { path: `${prefix}.source` },
      });
    }
    if (typeof entry.path !== "string" || entry.path.trim().length === 0) {
      throw SboxError.validation("Directory mount path is required.", {
        details: { path: `${prefix}.path` },
      });
    }
    if (typeof entry.mount !== "string" || !isAbsoluteGuestPath(entry.mount)) {
      throw SboxError.validation("Directory mount guest path must be an absolute POSIX path.", {
        details: { path: `${prefix}.mount` },
      });
    }
    if (seen.has(entry.mount)) {
      throw SboxError.validation(
        `Guest path "${entry.mount}" is already used by a volume or directory mount.`,
        { details: { path: `${prefix}.mount` } },
      );
    }
    seen.add(entry.mount);

    if (entry.source === "host" && !isAbsoluteOrHomeRelativeHostPath(entry.path)) {
      throw SboxError.validation(
        'Host path must be absolute or home-relative (starting with "~/").',
        {
          details: { path: `${prefix}.path` },
        },
      );
    }
    if (entry.source === "client" && !entry.readonly) {
      throw SboxError.validation("Client-sourced directory mounts must be read-only.", {
        details: { path: `${prefix}.readonly` },
      });
    }
    if (entry.readonly && entry.quotaMiB !== undefined) {
      throw SboxError.validation("Quota is only allowed for writable Host directory mounts.", {
        details: { path: `${prefix}.quotaMiB` },
      });
    }
    if (!entry.readonly && entry.quotaMiB === undefined) {
      throw SboxError.validation("Writable Host directory mounts require an explicit quota.", {
        details: { path: `${prefix}.quotaMiB` },
      });
    }
    if (entry.quotaMiB !== undefined && (!Number.isInteger(entry.quotaMiB) || entry.quotaMiB < 1)) {
      throw SboxError.validation("Directory mount quotaMiB must be a positive integer.", {
        details: { path: `${prefix}.quotaMiB` },
      });
    }
  }
}
