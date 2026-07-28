/**
 * Resolve a selected profile into a Host create request after external refs.
 */

import { resolve } from "node:path";
import { assertProjectId, assertSandboxIdentity, type SandboxIdentity } from "../identity.js";
import type { HostCreateRequest, SandboxInspection } from "../types.js";
import type {
  ConfigurationIssue,
  ImageBuildConfig,
  ProfileConfig,
  ProjectConfig,
} from "../config/types.js";
import { isBuildProfile } from "../config/types.js";
import {
  resolveEnvironmentMap,
  resolveExternalValue,
  throwMissingExternalReferences,
  type ExternalResolutionContext,
} from "../config/external.js";
import { resolveInstanceId, selectProfile } from "../config/profile.js";
import {
  immutableCreationDriftFields,
  projectCreateRequest,
  type SandboxImmutableCreation,
} from "../immutable-creation.js";
import { OWNERSHIP_LABEL_KEYS } from "../ownership.js";
import { buildOwnershipLabels } from "../ownership-adoption.js";
import { SboxError } from "../errors.js";
import type { ImageIdentityInputs } from "../image/compute.js";
import type { HostEnsureImageRequest } from "../image/types.js";
import { hostDockerPlatform } from "../image/platform.js";
import { normalizePosixRelative } from "../image/context.js";
import { throwAccumulatedValidation } from "../config/validate.js";
import { parseBinarySizeToBytes, parseBinarySizeToMiB } from "../config/scalars.js";
import { normalizeHostMountConfig } from "../directory/normalize.js";
import { expandHomePrefix, isHomeRelativePath } from "../directory/home-path.js";
import { assertBindablePath } from "../directory/assert-directory.js";
import type { HostMount, MountAttachmentSpec, MountKind } from "../directory/types.js";
import { canonicalMountsFingerprint } from "../directory/types.js";
import {
  mergeNetworkConfigs,
  normalizeAllowRule,
  type RawNetworkAllowRule,
} from "../network/normalize.js";
import {
  defaultNetworkConfig,
  type HostNetworkConfig,
  type NetworkAllowRule,
  type PublishedPortSpec,
  type ResolvedRuntimeSecret,
  type RuntimeSecretConfig,
} from "../network/types.js";
import {
  defaultPlaceholder,
  validateHostNetworkConfig,
  validateResolvedRuntimeSecrets,
} from "../network/validate.js";
import type { HostVolumeAttachment } from "../volume/types.js";

export interface ResolveCreateInput {
  readonly project: ProjectConfig;
  readonly profile?: string;
  readonly instance?: string;
  readonly external: ExternalResolutionContext;
  /** Invocation environment overlays merged after profile environment. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Required when the selected profile is Dockerfile-backed: the exact native
   * image reference produced by `ensureImage`.
   */
  readonly resolvedImage?: string;
  /** Extra outbound allow rules merged onto the profile network. */
  readonly networkAllow?: readonly NetworkAllowRule[] | readonly RawNetworkAllowRule[];
  /** Extra published ports merged onto the profile network. */
  readonly networkPublish?: readonly PublishedPortSpec[];
  /** Extra runtime secrets merged after profile secrets. */
  readonly secrets?: readonly RuntimeSecretConfig[];
}

export interface ResolvedCreateIntent {
  readonly identity: SandboxIdentity;
  readonly request: HostCreateRequest;
  readonly projected: SandboxImmutableCreation;
}

export async function resolveCreateIntent(
  input: ResolveCreateInput,
): Promise<ResolvedCreateIntent> {
  const selected = selectProfile(input.project, input.profile);
  const instance = resolveInstanceId(selected.name, input.instance);
  const identity = assertSandboxIdentity({
    project: assertProjectId(input.project.project),
    profile: selected.name,
    instance,
  });

  const resolvedEnv = await resolveEnvironmentMap(
    selected.profile.environment,
    input.external,
    `profiles.${selected.name}.environment`,
  );
  if (!resolvedEnv.ok) {
    throwMissingExternalReferences(resolvedEnv.issues);
  }

  const env = Object.freeze({
    ...resolvedEnv.values,
    ...input.env,
  });

  const network = mergeProfileNetwork(
    selected.profile,
    selected.name,
    input.networkAllow,
    input.networkPublish,
  );

  const secretsResult = await resolveRuntimeSecrets(
    [...(selected.profile.secrets ?? []), ...(input.secrets ?? [])],
    `profiles.${selected.name}.secrets`,
    input.external,
  );
  if (!secretsResult.ok) {
    throwMissingExternalReferences(secretsResult.issues);
  }

  const networkIssues = validateHostNetworkConfig(network);
  const secretIssues = validateResolvedRuntimeSecrets(secretsResult.values);
  const issues = [...networkIssues, ...secretIssues];
  if (issues.length > 0) {
    throwAccumulatedValidation(issues, "Sandbox network/secret validation failed.");
  }

  const image = resolveProfileImage(selected.profile, selected.name, input.resolvedImage);
  const volumes = resolveProfileVolumes(input.project, selected.profile, selected.name);
  const mounts = await resolveProfileMounts(
    selected.profile,
    selected.name,
    input.external.configDirectory,
  );
  const request = profileToCreateRequest(
    identity,
    selected.profile,
    env,
    image,
    network,
    secretsResult.values,
    volumes,
    mounts,
  );
  // Projection requires kind. Host create resolves any remaining kinds; for Client
  // drift we only fingerprint mounts whose kind is already known.
  const mountsWithKind = mounts.filter(
    (entry): entry is HostMount & { readonly kind: MountKind } =>
      entry.kind === "file" || entry.kind === "directory",
  );
  const projected = projectCreateRequest({
    ...request,
    mounts: mountsWithKind,
  });
  return { identity, request, projected };
}

function resolveProfileVolumes(
  project: ProjectConfig,
  profile: ProfileConfig,
  profileName: string,
): readonly HostVolumeAttachment[] {
  const attachments = profile.volumes ?? [];
  if (attachments.length === 0) {
    return [];
  }
  const declared = project.volumes ?? {};
  const out: HostVolumeAttachment[] = [];
  const issues: ConfigurationIssue[] = [];
  for (let i = 0; i < attachments.length; i += 1) {
    const attachment = attachments[i]!;
    const path = `profiles.${profileName}.volumes.${i}`;
    const declaration = declared[attachment.volume];
    if (declaration === undefined) {
      issues.push({
        path: `${path}.volume`,
        message: `Volume "${attachment.volume}" is not declared in project volumes.`,
      });
      continue;
    }
    try {
      out.push({
        volume: attachment.volume,
        path: attachment.path,
        sizeBytes: parseBinarySizeToBytes(declaration.size, `volumes.${attachment.volume}.size`),
      });
    } catch (error) {
      if (error instanceof SboxError && error.code === "validation") {
        issues.push({
          path: `volumes.${attachment.volume}.size`,
          message: error.message,
        });
      } else {
        throw error;
      }
    }
  }
  if (issues.length > 0) {
    throwAccumulatedValidation(issues, "Sandbox volume validation failed.");
  }
  return Object.freeze(out);
}

async function resolveProfileMounts(
  profile: ProfileConfig,
  profileName: string,
  configDirectory: string,
): Promise<readonly HostMount[]> {
  const attachments = profile.mounts ?? [];
  if (attachments.length === 0) {
    return [];
  }
  const out: HostMount[] = [];
  const issues: ConfigurationIssue[] = [];
  const seenMounts = new Set<string>((profile.volumes ?? []).map((v) => v.path));
  for (let i = 0; i < attachments.length; i += 1) {
    const pathPrefix = `profiles.${profileName}.mounts.${i}`;
    const normalized = normalizeHostMountConfig(attachments[i]!, pathPrefix);
    if (!normalized.ok) {
      issues.push(...normalized.issues);
      continue;
    }
    const entry = normalized.value;
    if (seenMounts.has(entry.mount)) {
      issues.push({
        path: `${pathPrefix}.mount`,
        message: `Guest path "${entry.mount}" is already used by a volume or Host mount.`,
      });
      continue;
    }
    seenMounts.add(entry.mount);
    const resolvedPath =
      entry.source === "client" ? resolveClientMountPath(configDirectory, entry.path) : entry.path;
    let quotaMiB = entry.quotaMiB;
    if (!entry.readonly && entry.quota !== undefined && quotaMiB === undefined) {
      try {
        quotaMiB = parseBinarySizeToMiB(entry.quota, `${pathPrefix}.quota`);
      } catch (error) {
        issues.push({
          path: `${pathPrefix}.quota`,
          message: error instanceof Error ? error.message : "Invalid quota.",
        });
        continue;
      }
    }
    let kind: MountKind | undefined;
    if (entry.source === "client") {
      try {
        kind = await assertBindablePath(resolvedPath, `${pathPrefix}.path`);
      } catch (error) {
        if (
          error instanceof SboxError &&
          (error.code === "validation" || error.code === "not_found")
        ) {
          issues.push({
            path: `${pathPrefix}.path`,
            message: error.message,
          });
          continue;
        }
        throw error;
      }
    } else {
      // LocalHost: resolve kind early when the Host path is visible here.
      // Remote Host: path may not exist on the Client; kind is inferred at create.
      try {
        kind = await assertBindablePath(expandHomePrefix(resolvedPath), `${pathPrefix}.path`);
      } catch {
        kind = undefined;
      }
    }
    out.push({
      source: entry.source,
      path: resolvedPath,
      mount: entry.mount,
      readonly: entry.readonly,
      ...(kind !== undefined ? { kind } : {}),
      ...(quotaMiB !== undefined ? { quotaMiB } : {}),
      ...(entry.followEscapingSymlinks === true ? { followEscapingSymlinks: true } : {}),
    });
  }
  if (issues.length > 0) {
    throwAccumulatedValidation(issues, "Sandbox Host mount validation failed.");
  }
  return Object.freeze(out);
}

/** Client paths: `~/…` → home; otherwise relative to project config directory. */
function resolveClientMountPath(configDirectory: string, path: string): string {
  if (isHomeRelativePath(path)) {
    return expandHomePrefix(path);
  }
  return resolve(configDirectory, path);
}

function mergeProfileNetwork(
  profile: ProfileConfig,
  profileName: string,
  networkAllow: ResolveCreateInput["networkAllow"],
  networkPublish: ResolveCreateInput["networkPublish"],
): HostNetworkConfig {
  const base = profile.network ?? defaultNetworkConfig();
  const extraAllow = (networkAllow ?? []).map((rule) =>
    normalizeAllowRule(rule as RawNetworkAllowRule | NetworkAllowRule),
  );
  const extraPublish = [...(networkPublish ?? [])];
  try {
    return mergeNetworkConfigs(base, extraAllow, extraPublish);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Cannot add network allow rules or published ports when mode is disabled.";
    throwAccumulatedValidation(
      [
        {
          path: `profiles.${profileName}.network`,
          message,
        },
      ],
      "Sandbox network/secret validation failed.",
    );
  }
}

async function resolveRuntimeSecrets(
  configs: readonly RuntimeSecretConfig[],
  pathPrefix: string,
  external: ExternalResolutionContext,
): Promise<
  | { readonly ok: true; readonly values: readonly ResolvedRuntimeSecret[] }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] }
> {
  const values: ResolvedRuntimeSecret[] = [];
  const issues: ConfigurationIssue[] = [];
  for (let i = 0; i < configs.length; i += 1) {
    const secret = configs[i]!;
    const path = `${pathPrefix}.${i}`;
    const resolved = await resolveExternalValue(secret.value, `${path}.value`, external);
    if (!resolved.ok) {
      issues.push(resolved.issue);
      continue;
    }
    values.push(
      Object.freeze({
        env: secret.env,
        value: resolved.value,
        placeholder: secret.placeholder ?? defaultPlaceholder(secret.env),
        destinations: Object.freeze([...secret.destinations]),
      }),
    );
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, values: Object.freeze(values) };
}

function resolveProfileImage(
  profile: ProfileConfig,
  profileName: string,
  resolvedImage: string | undefined,
): string {
  if (isBuildProfile(profile)) {
    if (resolvedImage === undefined || resolvedImage.trim().length === 0) {
      throw SboxError.internal(
        `Build profile ${profileName} requires a resolved image before create.`,
      );
    }
    return resolvedImage;
  }
  return profile.image;
}

export function profileToCreateRequest(
  identity: SandboxIdentity,
  profile: ProfileConfig,
  env: Readonly<Record<string, string>>,
  image: string,
  network: HostNetworkConfig,
  secrets: readonly ResolvedRuntimeSecret[],
  volumes: readonly HostVolumeAttachment[],
  mounts: readonly HostMount[] = [],
): HostCreateRequest {
  return {
    identity,
    image,
    ...(profile.cpus !== undefined ? { cpus: profile.cpus } : {}),
    ...(profile.memoryMiB !== undefined ? { memoryMiB: profile.memoryMiB } : {}),
    ...(profile.workdir !== undefined ? { workdir: profile.workdir } : {}),
    ...(profile.user !== undefined ? { user: profile.user } : {}),
    ...(profile.shell !== undefined ? { shell: profile.shell } : {}),
    ...(profile.hostname !== undefined ? { hostname: profile.hostname } : {}),
    ...(profile.maxDurationSecs !== undefined ? { maxDurationSecs: profile.maxDurationSecs } : {}),
    ...(profile.idleTimeoutSecs !== undefined ? { idleTimeoutSecs: profile.idleTimeoutSecs } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    network,
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(volumes.length > 0 ? { volumes } : {}),
    ...(mounts.length > 0 ? { mounts } : {}),
  };
}

export interface ResolveEnsureImageInput {
  readonly project: ProjectConfig;
  readonly profile?: string;
  readonly external: ExternalResolutionContext;
  readonly force?: boolean;
  readonly platform?: string;
}

/**
 * Resolve identity inputs for a build profile without resolving secret values
 * or invoking Docker / Microsandbox.
 */
export async function resolveImageIdentityInputs(
  input: ResolveEnsureImageInput,
): Promise<{ readonly profileName: string; readonly inputs: ImageIdentityInputs }> {
  const selected = selectProfile(input.project, input.profile);
  if (!isBuildProfile(selected.profile)) {
    throw SboxError.validation(
      `Profile ${selected.name} uses an existing image reference; there is nothing to build.`,
      { details: { path: `profiles.${selected.name}.image` } },
    );
  }
  const build = selected.profile.build;
  const pathPrefix = `profiles.${selected.name}.build`;
  const contextRoot = resolve(input.external.configDirectory, build.context);
  const dockerfile = normalizePosixRelative(build.dockerfile ?? "Dockerfile");

  const argsResult = await resolveBuildArgs(build, pathPrefix, input.external);
  if (!argsResult.ok) {
    throwMissingExternalReferences(argsResult.issues);
  }

  return {
    profileName: selected.name,
    inputs: {
      contextRoot,
      dockerfile,
      platform: input.platform ?? hostDockerPlatform(),
      ...(build.target !== undefined ? { target: build.target } : {}),
      args: argsResult.values,
      secretIds: Object.keys(build.secrets ?? {}),
      includeGit: build.includeGit === true,
    },
  };
}

export async function resolveEnsureImageRequest(
  input: ResolveEnsureImageInput,
): Promise<{ readonly profileName: string; readonly request: HostEnsureImageRequest }> {
  const identity = await resolveImageIdentityInputs(input);
  const selected = selectProfile(input.project, input.profile);
  if (!isBuildProfile(selected.profile)) {
    throw SboxError.validation(
      `Profile ${selected.name} uses an existing image reference; there is nothing to build.`,
      { details: { path: `profiles.${selected.name}.image` } },
    );
  }
  const build = selected.profile.build;
  const pathPrefix = `profiles.${selected.name}.build`;
  const secretsResult = await resolveBuildSecrets(build, pathPrefix, input.external);
  if (!secretsResult.ok) {
    throwMissingExternalReferences(secretsResult.issues);
  }

  return {
    profileName: identity.profileName,
    request: {
      contextRoot: identity.inputs.contextRoot,
      dockerfile: identity.inputs.dockerfile,
      platform: identity.inputs.platform,
      ...(identity.inputs.target !== undefined ? { target: identity.inputs.target } : {}),
      args: identity.inputs.args,
      secrets: secretsResult.values,
      includeGit: identity.inputs.includeGit,
      ...(input.force === true ? { force: true } : {}),
    },
  };
}

async function resolveBuildArgs(
  build: ImageBuildConfig,
  pathPrefix: string,
  external: ExternalResolutionContext,
): Promise<
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] }
> {
  const values: Record<string, string> = {};
  const issues: ConfigurationIssue[] = [];
  for (const [key, value] of Object.entries(build.args ?? {})) {
    const path = `${pathPrefix}.args.${key}`;
    if (typeof value === "string") {
      values[key] = value;
      continue;
    }
    const resolved = await resolveExternalValue(value, path, external);
    if (!resolved.ok) {
      issues.push(resolved.issue);
    } else {
      values[key] = resolved.value;
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, values };
}

async function resolveBuildSecrets(
  build: ImageBuildConfig,
  pathPrefix: string,
  external: ExternalResolutionContext,
): Promise<
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] }
> {
  const values: Record<string, string> = {};
  const issues: ConfigurationIssue[] = [];
  for (const [id, ref] of Object.entries(build.secrets ?? {})) {
    const path = `${pathPrefix}.secrets.${id}`;
    const resolved = await resolveExternalValue(ref, path, external);
    if (!resolved.ok) {
      issues.push(resolved.issue);
    } else {
      values[id] = resolved.value;
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, values };
}

/**
 * Compare an existing inspection against desired immutable creation settings
 * that are safely visible on inspection (not environment values).
 *
 * `requestMounts` supplies the full create-time mount list (kinds may be unset for
 * remote Host paths). Inspection kinds are reused for matching attachments.
 */
export function reportCreationDrift(
  identity: SandboxIdentity,
  expected: SandboxImmutableCreation,
  inspection: SandboxInspection,
  requestMounts?: readonly HostMount[],
): void {
  const actual = projectCreateRequest({
    image: inspection.creation.image,
    cpus: inspection.creation.cpus,
    memoryMiB: inspection.creation.memoryMiB,
    ...(inspection.creation.workdir !== undefined ? { workdir: inspection.creation.workdir } : {}),
    ...(inspection.creation.user !== undefined ? { user: inspection.creation.user } : {}),
    ...(inspection.creation.shell !== undefined ? { shell: inspection.creation.shell } : {}),
    ...(inspection.creation.hostname !== undefined
      ? { hostname: inspection.creation.hostname }
      : {}),
    ...(inspection.creation.maxDurationSecs !== undefined
      ? { maxDurationSecs: inspection.creation.maxDurationSecs }
      : {}),
    ...(inspection.creation.idleTimeoutSecs !== undefined
      ? { idleTimeoutSecs: inspection.creation.idleTimeoutSecs }
      : {}),
    network: {
      mode: inspection.creation.network.mode,
      allow: inspection.creation.network.allow,
      publish: inspection.creation.network.publish,
    },
    secrets: inspection.creation.secrets.map((secret) => ({
      env: secret.env,
      placeholder: secret.placeholder,
      destinations: secret.destinations,
      value: "",
    })),
    volumes: inspection.creation.volumes,
    mounts: inspection.creation.mounts,
  });

  const expectedMounts = reconcileMountKindsForDrift(
    requestMounts ?? expected.mounts,
    actual.mounts,
  );
  const expectedVisible: SandboxImmutableCreation = Object.freeze({
    ...expected,
    env: Object.freeze({}),
    mounts: expectedMounts,
  });
  const fields = immutableCreationDriftFields(expectedVisible, actual).filter((field) => {
    if (field === "environment") {
      return false;
    }
    // Omitted profile fields mean unspecified; native may surface image defaults.
    if (field === "workdir" && expected.workdir == null) {
      return false;
    }
    if (field === "user" && expected.user == null) {
      return false;
    }
    if (field === "shell" && expected.shell == null) {
      return false;
    }
    if (field === "hostname" && expected.hostname == null) {
      return false;
    }
    return true;
  });

  // Env values stay off the inspection surface; fingerprint still needs key names.
  const expectedFingerprint = buildOwnershipLabels(identity, {
    ...expected,
    mounts: expectedMounts,
  })[OWNERSHIP_LABEL_KEYS.creation];
  const actualFingerprint = inspection.labels[OWNERSHIP_LABEL_KEYS.creation];
  if (expectedFingerprint !== actualFingerprint && fields.length === 0) {
    throw SboxError.ownershipConflict(
      `Sandbox ${identity.project}/${identity.instance} exists with different creation settings; use recreate.`,
      {
        details: {
          project: identity.project,
          profile: identity.profile,
          instance: identity.instance,
          nativeName: inspection.nativeName,
          drift: ["creation"],
        },
      },
    );
  }

  if (fields.length === 0) {
    return;
  }

  throw SboxError.ownershipConflict(
    `Sandbox ${identity.project}/${identity.instance} exists with different creation settings; use recreate.`,
    {
      details: {
        project: identity.project,
        profile: identity.profile,
        instance: identity.instance,
        nativeName: inspection.nativeName,
        drift: fields,
      },
    },
  );
}

/**
 * Fill missing kinds on desired mounts from inspection when source/path/mount match.
 */
function reconcileMountKindsForDrift(
  desired: readonly {
    readonly source: HostMount["source"];
    readonly path: string;
    readonly mount: string;
    readonly readonly: boolean;
    readonly kind?: MountKind;
    readonly quotaMiB?: number;
    readonly followEscapingSymlinks?: boolean;
  }[],
  inspected: readonly MountAttachmentSpec[],
): readonly MountAttachmentSpec[] {
  return Object.freeze(
    canonicalMountsFingerprint(
      desired.map((entry) => {
        const follow =
          entry.followEscapingSymlinks === true ? { followEscapingSymlinks: true as const } : {};
        if (entry.kind === "file" || entry.kind === "directory") {
          return {
            source: entry.source,
            path: entry.path,
            mount: entry.mount,
            readonly: entry.readonly,
            kind: entry.kind,
            ...(entry.quotaMiB !== undefined ? { quotaMiB: entry.quotaMiB } : {}),
            ...follow,
          };
        }
        const match = inspected.find(
          (candidate) =>
            candidate.source === entry.source &&
            candidate.path === entry.path &&
            candidate.mount === entry.mount,
        );
        if (match === undefined) {
          throw SboxError.validation("Host mount kind must be resolved before drift comparison.", {
            details: { path: entry.mount },
          });
        }
        return {
          source: entry.source,
          path: entry.path,
          mount: entry.mount,
          readonly: entry.readonly,
          kind: match.kind,
          ...(entry.quotaMiB !== undefined ? { quotaMiB: entry.quotaMiB } : {}),
          ...follow,
        };
      }),
    ),
  );
}
