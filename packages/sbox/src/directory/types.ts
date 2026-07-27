/**
 * Host mount DTOs (create/inspect and fingerprints).
 */

export type MountSource = "client" | "host";

/** Inferred at create from the real bind path (not a YAML field). */
export type MountKind = "file" | "directory";

/** Safe / inspection / fingerprint projection (no Mount stage paths). */
export interface MountAttachmentSpec {
  readonly source: MountSource;
  readonly path: string;
  readonly mount: string;
  readonly readonly: boolean;
  readonly kind: MountKind;
  /** Present only when writable and explicitly set. */
  readonly quotaMiB?: number;
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
  readonly bindHostPath?: string;
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
