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
  const request = profileToCreateRequest(
    identity,
    selected.profile,
    env,
    image,
    network,
    secretsResult.values,
  );
  const projected = projectCreateRequest(request);
  return { identity, request, projected };
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
 */
export function reportCreationDrift(
  identity: SandboxIdentity,
  expected: SandboxImmutableCreation,
  inspection: SandboxInspection,
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
  });

  const expectedVisible: SandboxImmutableCreation = Object.freeze({
    ...expected,
    env: Object.freeze({}),
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

  const expectedFingerprint = buildOwnershipLabels(identity, expected)[
    OWNERSHIP_LABEL_KEYS.creation
  ];
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
