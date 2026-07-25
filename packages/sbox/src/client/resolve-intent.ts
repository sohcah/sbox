/**
 * Resolve a selected profile into a Host create request after external refs.
 */

import { resolve } from "node:path";
import { assertProjectId, assertSandboxIdentity, type SandboxIdentity } from "../identity.js";
import type { HostCreateRequest, SandboxInspection } from "../types.js";
import type { ImageBuildConfig, ProfileConfig, ProjectConfig } from "../config/types.js";
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
import type { ConfigurationIssue } from "../config/types.js";

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

  const image = resolveProfileImage(selected.profile, selected.name, input.resolvedImage);
  const request = profileToCreateRequest(identity, selected.profile, env, image);
  const projected = projectCreateRequest(request);
  return { identity, request, projected };
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
