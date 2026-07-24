/**
 * Resolve a selected profile into a Host create request after external refs.
 */

import { assertProjectId, assertSandboxIdentity, type SandboxIdentity } from "../identity.js";
import type { HostCreateRequest, SandboxInspection } from "../types.js";
import type { ProfileConfig, ProjectConfig } from "../config/types.js";
import {
  resolveEnvironmentMap,
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

export interface ResolveCreateInput {
  readonly project: ProjectConfig;
  readonly profile?: string;
  readonly instance?: string;
  readonly external: ExternalResolutionContext;
  /** Invocation environment overlays merged after profile environment. */
  readonly env?: Readonly<Record<string, string>>;
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

  const request = profileToCreateRequest(identity, selected.profile, env);
  const projected = projectCreateRequest(request);
  return { identity, request, projected };
}

export function profileToCreateRequest(
  identity: SandboxIdentity,
  profile: ProfileConfig,
  env: Readonly<Record<string, string>>,
): HostCreateRequest {
  return {
    identity,
    image: profile.image,
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
  const fields = immutableCreationDriftFields(expectedVisible, actual).filter(
    (field) => field !== "environment",
  );

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
