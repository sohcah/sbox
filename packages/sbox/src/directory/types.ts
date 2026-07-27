/**
 * Host directory mount DTOs (create/inspect and fingerprints).
 */

export type DirectoryMountSource = "client" | "host";

/** Safe / inspection / fingerprint projection (no Directory stage paths). */
export interface DirectoryAttachmentSpec {
  readonly source: DirectoryMountSource;
  readonly path: string;
  readonly mount: string;
  readonly readonly: boolean;
  /** Present only when writable. */
  readonly quotaMiB?: number;
}

/**
 * Create-time attachment. `path` is the identity/inspection path.
 * `bindHostPath` overrides the Host filesystem path used for the native bind
 * (Directory stages on remote); when omitted, bind `path`.
 */
export interface HostDirectoryMount extends DirectoryAttachmentSpec {
  readonly bindHostPath?: string;
}

export function canonicalDirectoriesFingerprint(
  directories: readonly DirectoryAttachmentSpec[],
): readonly DirectoryAttachmentSpec[] {
  return [...directories]
    .map((entry) =>
      Object.freeze({
        source: entry.source,
        path: entry.path,
        mount: entry.mount,
        readonly: entry.readonly,
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
