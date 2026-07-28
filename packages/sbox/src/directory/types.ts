/**
 * Host mount DTOs (create/inspect and fingerprints).
 */

export type MountSource = "client" | "host";

/** Inferred at create from the real bind path (not a YAML field). */
export type MountKind = "file" | "directory";

/**
 * How content is delivered into the guest.
 * - `bind` (default): virtio bind mount (consumes a microVM IRQ).
 * - `copy`: one-shot materialize into the guest rootfs at create (no virtio device).
 */
export type MountMode = "bind" | "copy";

/** Safe / inspection / fingerprint projection (no Mount stage paths). */
export interface MountAttachmentSpec {
  readonly source: MountSource;
  readonly path: string;
  readonly mount: string;
  readonly readonly: boolean;
  readonly kind: MountKind;
  /** Present only when writable and explicitly set. */
  readonly quotaMiB?: number;
  /**
   * When true, Client-mount packing dereferences escaping/absolute symlinks.
   * Omitted when false.
   */
  readonly followEscapingSymlinks?: boolean;
  /** Omitted when `bind` (default) so existing fingerprints stay stable. */
  readonly mode?: MountMode;
}

/**
 * Create-time attachment. `path` is the identity/inspection path.
 * `bindHostPath` overrides the Host filesystem path used for the native bind
 * (Mount stages on remote); when omitted, bind `path`.
 * `kind` may be omitted until Host create resolves it via lstat.
 */
export interface HostMount {
  readonly source: MountSource;
  readonly path: string;
  readonly mount: string;
  readonly readonly: boolean;
  readonly kind?: MountKind;
  readonly quotaMiB?: number;
  readonly followEscapingSymlinks?: boolean;
  readonly mode?: MountMode;
  readonly bindHostPath?: string;
}

export function mountMode(entry: { readonly mode?: MountMode }): MountMode {
  return entry.mode ?? "bind";
}

export function canonicalMountsFingerprint(
  mounts: readonly MountAttachmentSpec[],
): readonly MountAttachmentSpec[] {
  return [...mounts]
    .map((entry) =>
      Object.freeze({
        source: entry.source,
        path: entry.path,
        mount: entry.mount,
        readonly: entry.readonly,
        kind: entry.kind,
        ...(entry.quotaMiB !== undefined ? { quotaMiB: entry.quotaMiB } : {}),
        ...(entry.followEscapingSymlinks === true ? { followEscapingSymlinks: true } : {}),
        ...(entry.mode === "copy" ? { mode: "copy" as const } : {}),
      }),
    )
    .toSorted((a, b) => {
      const byMount = a.mount.localeCompare(b.mount);
      if (byMount !== 0) {
        return byMount;
      }
      return a.path.localeCompare(b.path);
    });
}

/** @deprecated Use MountSource */
export type DirectoryMountSource = MountSource;
/** @deprecated Use MountAttachmentSpec */
export type DirectoryAttachmentSpec = MountAttachmentSpec;
/** @deprecated Use HostMount */
export type HostDirectoryMount = HostMount;
/** @deprecated Use canonicalMountsFingerprint */
export const canonicalDirectoriesFingerprint = canonicalMountsFingerprint;
