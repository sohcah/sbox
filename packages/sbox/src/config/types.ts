/**
 * Typed version-1 project and user configuration models.
 *
 * The typed in-memory model is primary. YAML is an adapter over these types.
 */

import type {
  NetworkConfig,
  RuntimeSecretConfig,
  SafeNetworkConfig,
  SafeRuntimeSecret,
} from "../network/types.js";

/** Structured external value reference. Literals are plain strings. */
export type ExternalValueRef =
  | { readonly env: string }
  | { readonly file: string }
  | { readonly invocation: string };

export type ConfigValue = string | ExternalValueRef;

/** Project-scoped managed QCOW2/ext4 base declaration. */
export interface VolumeDeclaration {
  /** Logical base size, e.g. "4GiB". */
  readonly size: string;
}

/** Profile attachment of a declared project volume at a guest mount path. */
export interface VolumeAttachment {
  /** Project volume slug. */
  readonly volume: string;
  /** Absolute guest mount path. */
  readonly path: string;
}

/** Profile Host mount (Client or Host file/directory into the guest). */
export interface HostMountConfig {
  /** Client or Host filesystem path (see `source`). */
  readonly path: string;
  /** Absolute guest mount path. */
  readonly mount: string;
  /** Default `client`. */
  readonly source?: "client" | "host";
  /** Default `true`. Writable only when `source: host` with `mode: bind`. */
  readonly readonly?: boolean;
  /** Binary size string; optional for writable Host bind mounts (MSB protective default). */
  readonly quota?: string;
  /**
   * Client mounts only. When true, remote packing dereferences escaping/absolute
   * symlinks into real file/dir content. Default false.
   */
  readonly followEscapingSymlinks?: boolean;
  /**
   * Default `bind` (virtio). `copy` materializes once into the guest rootfs at
   * create without a virtio device (avoids microVM IRQ limits).
   */
  readonly mode?: "bind" | "copy";
}

/** @deprecated Use HostMountConfig */
export type DirectoryMountConfig = HostMountConfig;

/** Safe projection of a Host mount. */
export interface SafeHostMount {
  readonly path: string;
  readonly mount: string;
  readonly source: "client" | "host";
  readonly readonly: boolean;
  readonly quota?: string;
  readonly followEscapingSymlinks?: boolean;
  readonly mode?: "bind" | "copy";
}

/** @deprecated Use SafeHostMount */
export type SafeDirectoryMount = SafeHostMount;

/**
 * Dockerfile-backed build definition. Mutually exclusive with `image`.
 * Paths are config-relative until resolved against the config directory.
 */
export interface ImageBuildConfig {
  /** Build context root (directory). */
  readonly context: string;
  /**
   * Dockerfile path relative to context. Defaults to `Dockerfile`.
   * Must stay inside the context (no absolute path, no `..`).
   */
  readonly dockerfile?: string;
  /** Optional Docker build target stage. */
  readonly target?: string;
  /** Ordinary build arguments (not secrets). */
  readonly args?: Readonly<Record<string, ConfigValue>>;
  /**
   * BuildKit secrets keyed by secret id. Values resolve from external refs only;
   * resolved secret values never enter safe DTOs or identity.
   */
  readonly secrets?: Readonly<Record<string, ExternalValueRef>>;
  /** When true, `.git` may be included if not otherwise ignored. Default false. */
  readonly includeGit?: boolean;
}

export interface ProfileCommon {
  readonly cpus?: number;
  readonly memoryMiB?: number;
  /** Guest `/tmp` tmpfs size in MiB. Omit to keep Microsandbox's default. */
  readonly tmpMiB?: number;
  /** OCI writable overlay upper size in MiB. Omit to keep Microsandbox's default. */
  readonly rootMiB?: number;
  readonly workdir?: string;
  readonly user?: string;
  readonly shell?: string;
  readonly hostname?: string;
  readonly environment?: Readonly<Record<string, ConfigValue>>;
  /** Native maximum lifetime in seconds. */
  readonly maxDurationSecs?: number | null;
  /** Native idle timeout in seconds. */
  readonly idleTimeoutSecs?: number | null;
  /** Curated network policy. Omit for default-deny with no extra allow/publish. */
  readonly network?: NetworkConfig;
  /**
   * Curated Microsandbox secret interception. Values are external refs only.
   * Destinations do not grant network access.
   */
  readonly secrets?: readonly RuntimeSecretConfig[];
  /** Attachments of project-declared volumes (ordinary sandboxes get child overlays). */
  readonly volumes?: readonly VolumeAttachment[];
  /** Host mounts (Client/Host files or directories into the guest). */
  readonly mounts?: readonly HostMountConfig[];
}

/** Existing OCI/native image reference profile. */
export type ImageReferenceProfile = ProfileCommon & {
  readonly image: string;
  readonly build?: undefined;
};

/** Dockerfile-backed build profile. */
export type ImageBuildProfile = ProfileCommon & {
  readonly build: ImageBuildConfig;
  readonly image?: undefined;
};

export type ProfileConfig = ImageReferenceProfile | ImageBuildProfile;

export interface ProjectConfig {
  readonly version: 1;
  /** Stable portable project slug. */
  readonly project: string;
  readonly defaultProfile?: string;
  /** Optional project-selected target name. */
  readonly target?: string;
  /** Reusable managed QCOW2 volume declarations. */
  readonly volumes?: Readonly<Record<string, VolumeDeclaration>>;
  readonly profiles: Readonly<Record<string, ProfileConfig>>;
}

export type LocalTargetConfig = {
  readonly kind: "local";
};

export type RemoteTargetConfig = {
  readonly kind: "remote";
  readonly url: string;
  readonly token: ExternalValueRef;
};

export type TargetConfig = LocalTargetConfig | RemoteTargetConfig;

export interface UserConfig {
  readonly version: 1;
  readonly defaultTarget?: string;
  readonly targets: Readonly<Record<string, TargetConfig>>;
}

export interface ConfigurationIssue {
  readonly path: string;
  readonly message: string;
}

/** Redacted projection of a build definition (no secret/arg values). */
export interface SafeImageBuildConfig {
  readonly context: string;
  readonly dockerfile: string;
  readonly target?: string;
  readonly args: Readonly<Record<string, "literal" | "env" | "file" | "invocation">>;
  readonly secrets: Readonly<Record<string, "env" | "file" | "invocation">>;
  readonly includeGit: boolean;
}

/** Redacted, inspection-safe projection of a validated project config. */
export interface SafeProjectConfig {
  readonly version: 1;
  readonly project: string;
  readonly defaultProfile?: string;
  readonly target?: string;
  readonly volumes: Readonly<Record<string, VolumeDeclaration>>;
  readonly profiles: Readonly<
    Record<
      string,
      {
        readonly image?: string;
        readonly build?: SafeImageBuildConfig;
        readonly cpus?: number;
        readonly memoryMiB?: number;
        readonly tmpMiB?: number;
        readonly rootMiB?: number;
        readonly workdir?: string;
        readonly user?: string;
        readonly shell?: string;
        readonly hostname?: string;
        readonly environment: Readonly<Record<string, "literal" | "env" | "file" | "invocation">>;
        readonly maxDurationSecs?: number | null;
        readonly idleTimeoutSecs?: number | null;
        readonly network?: SafeNetworkConfig;
        readonly secrets?: readonly SafeRuntimeSecret[];
        readonly volumes?: readonly VolumeAttachment[];
        readonly mounts?: readonly SafeHostMount[];
      }
    >
  >;
}

export interface SafeUserConfig {
  readonly version: 1;
  readonly defaultTarget?: string;
  readonly targets: Readonly<
    Record<
      string,
      | { readonly kind: "local" }
      | {
          readonly kind: "remote";
          readonly url: string;
          readonly token: "env" | "file" | "invocation";
        }
    >
  >;
}

export function isBuildProfile(profile: ProfileConfig): profile is ImageBuildProfile {
  return profile.build !== undefined;
}

export function isImageReferenceProfile(profile: ProfileConfig): profile is ImageReferenceProfile {
  return typeof profile.image === "string";
}
