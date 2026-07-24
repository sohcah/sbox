/**
 * Typed version-1 project and user configuration models.
 *
 * The typed in-memory model is primary. YAML is an adapter over these types.
 */

/** Structured external value reference. Literals are plain strings. */
export type ExternalValueRef =
  | { readonly env: string }
  | { readonly file: string }
  | { readonly invocation: string };

export type ConfigValue = string | ExternalValueRef;

/**
 * Phase 6 volume placeholder. Accepted and validated, unused by Phase 2 Host.
 */
export interface VolumeDeclaration {
  /** Logical base size, e.g. "4GiB". */
  readonly size: string;
}

export interface ProfileConfig {
  /** Existing OCI/native image reference. Dockerfile builds arrive in Phase 4. */
  readonly image: string;
  readonly cpus?: number;
  readonly memoryMiB?: number;
  readonly workdir?: string;
  readonly user?: string;
  readonly shell?: string;
  readonly hostname?: string;
  readonly environment?: Readonly<Record<string, ConfigValue>>;
  /** Native maximum lifetime in seconds. */
  readonly maxDurationSecs?: number | null;
  /** Native idle timeout in seconds. */
  readonly idleTimeoutSecs?: number | null;
}

export interface ProjectConfig {
  readonly version: 1;
  /** Stable portable project slug. */
  readonly project: string;
  readonly defaultProfile?: string;
  /** Optional project-selected target name. */
  readonly target?: string;
  /** Reusable volume declarations (Phase 6 placeholders). */
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
        readonly image: string;
        readonly cpus?: number;
        readonly memoryMiB?: number;
        readonly workdir?: string;
        readonly user?: string;
        readonly shell?: string;
        readonly hostname?: string;
        readonly environment: Readonly<Record<string, "literal" | "env" | "file" | "invocation">>;
        readonly maxDurationSecs?: number | null;
        readonly idleTimeoutSecs?: number | null;
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
