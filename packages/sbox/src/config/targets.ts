/**
 * User target configuration and precedence resolution.
 *
 * Precedence:
 * 1. explicit invocation target
 * 2. project-selected target
 * 3. user default target
 * 4. local
 *
 * Remote Host transport arrives in Phase 7. Selecting a remote target in Phase 2
 * fails with a capability error after configuration validation succeeds, before
 * any local Host call. Credential materialization is deferred until RemoteHost.
 *
 * Not part of the public package declaration graph.
 */

import { assertConfigSlug } from "./scalars.js";
import { SboxError } from "../errors.js";
import type { ProjectConfig, TargetConfig, UserConfig } from "./types.js";
import {
  resolveExternalValue,
  throwMissingExternalReferences,
  type ExternalResolutionContext,
} from "./external.js";

export type TargetSelectionSource = "explicit" | "project" | "user-default" | "implicit-local";

export interface ResolvedLocalTarget {
  readonly kind: "local";
  readonly name: string;
  readonly source: TargetSelectionSource;
}

/**
 * Internal remote materialization for Phase 7. Credentials are never part of
 * the public package API.
 */
export interface ResolvedRemoteTarget {
  readonly kind: "remote";
  readonly name: string;
  readonly source: TargetSelectionSource;
  readonly url: string;
  readonly token: string;
}

export type ResolvedTarget = ResolvedLocalTarget | ResolvedRemoteTarget;

export interface TargetResolutionInput {
  readonly project: ProjectConfig;
  readonly user: UserConfig;
  readonly explicitTarget?: string;
  readonly external: ExternalResolutionContext;
}

/**
 * Select and authorize a local Host target for Phase 2 operations.
 * Remote targets fail closed without resolving bearer credentials or touching Host.
 */
export async function requireLocalTarget(
  input: Omit<TargetResolutionInput, "external"> & {
    readonly external?: ExternalResolutionContext;
  },
): Promise<ResolvedLocalTarget> {
  const { name, source } = selectTargetName(input);
  const configured = resolveConfiguredTarget(input.user, name, source);

  if (configured.kind === "remote") {
    throw SboxError.capability(
      "Remote targets require Phase 7 remote Host transport and are not available yet.",
      {
        details: {
          target: name,
          url: configured.url,
          unavailableReason: "remote_transport_unimplemented",
        },
      },
    );
  }

  return { kind: "local", name, source };
}

/**
 * Full target materialization including remote credentials.
 * Reserved for Phase 7 transport; not required for Phase 2 Host gating.
 */
export async function resolveTarget(input: TargetResolutionInput): Promise<ResolvedTarget> {
  const { name, source } = selectTargetName(input);
  const configured = resolveConfiguredTarget(input.user, name, source);
  return materializeTarget(name, source, configured, input.external);
}

export function selectTargetName(input: {
  readonly project: ProjectConfig;
  readonly user: UserConfig;
  readonly explicitTarget?: string;
}): { readonly name: string; readonly source: TargetSelectionSource } {
  if (input.explicitTarget !== undefined) {
    return {
      name: assertConfigSlug(input.explicitTarget, "target"),
      source: "explicit",
    };
  }
  if (input.project.target !== undefined) {
    return {
      name: assertConfigSlug(input.project.target, "target"),
      source: "project",
    };
  }
  if (input.user.defaultTarget !== undefined) {
    return {
      name: assertConfigSlug(input.user.defaultTarget, "defaultTarget"),
      source: "user-default",
    };
  }
  return { name: "local", source: "implicit-local" };
}

function resolveConfiguredTarget(
  user: UserConfig,
  name: string,
  source: TargetSelectionSource,
): TargetConfig {
  const configured = user.targets[name];
  if (configured !== undefined) {
    return configured;
  }
  if (name === "local" && source === "implicit-local") {
    return { kind: "local" };
  }
  throw SboxError.validation(`Target ${JSON.stringify(name)} is not defined.`, {
    details: { path: "target", message: "Unknown target." },
  });
}

async function materializeTarget(
  name: string,
  source: TargetSelectionSource,
  configured: TargetConfig,
  external: ExternalResolutionContext,
): Promise<ResolvedTarget> {
  if (configured.kind === "local") {
    return { kind: "local", name, source };
  }

  const tokenResult = await resolveExternalValue(
    configured.token,
    `targets.${name}.token`,
    external,
  );
  if (!tokenResult.ok) {
    throwMissingExternalReferences(
      [tokenResult.issue],
      "Remote target credential could not be resolved.",
    );
  }

  return {
    kind: "remote",
    name,
    source,
    url: configured.url,
    token: tokenResult.value,
  };
}

/**
 * Phase 2 only supports the local Host. Remote targets fail closed.
 */
export function assertLocalTarget(target: ResolvedTarget): ResolvedLocalTarget {
  if (target.kind === "local") {
    return target;
  }
  throw SboxError.capability(
    "Remote targets require Phase 7 remote Host transport and are not available yet.",
    {
      details: {
        target: target.name,
        url: target.url,
        unavailableReason: "remote_transport_unimplemented",
      },
    },
  );
}
