/**
 * Compute a generated-image identity from a build definition without Docker or
 * native mutation. Used by `up` to predict the required reference before
 * inspecting an existing sandbox.
 */

import { discoverBuildContext } from "./context.js";
import { computeImageContentIdentity, type ImageContentIdentity } from "./identity.js";
import { IMAGE_IDENTITY_ALGORITHM_VERSION } from "./naming.js";
import type { HostEnsureImageRequest } from "./types.js";

export type ImageIdentityInputs = {
  readonly contextRoot: string;
  readonly dockerfile: string;
  readonly platform: string;
  readonly target?: string;
  readonly args: Readonly<Record<string, string>>;
  /** Secret ids only — values must not be supplied here. */
  readonly secretIds: readonly string[];
  readonly includeGit: boolean;
  readonly signal?: AbortSignal;
};

/**
 * Discover context and hash identity. Does not invoke Docker or Microsandbox.
 */
export async function computeGeneratedImageIdentity(
  input: ImageIdentityInputs,
): Promise<ImageContentIdentity> {
  const discovered = await discoverBuildContext({
    contextRoot: input.contextRoot,
    dockerfile: input.dockerfile,
    includeGit: input.includeGit,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return computeImageContentIdentity({
    algorithmVersion: IMAGE_IDENTITY_ALGORITHM_VERSION,
    dockerfileRelativePath: discovered.dockerfileRelativePath,
    dockerfileContents: discovered.dockerfileContents,
    platform: input.platform,
    target: input.target ?? "",
    args: input.args,
    secretIds: input.secretIds,
    includeGit: input.includeGit,
    entries: discovered.entries,
  });
}

export function identityInputsFromEnsureRequest(
  request: HostEnsureImageRequest,
  signal?: AbortSignal,
): ImageIdentityInputs {
  return {
    contextRoot: request.contextRoot,
    dockerfile: request.dockerfile,
    platform: request.platform,
    ...(request.target !== undefined ? { target: request.target } : {}),
    args: request.args,
    secretIds: Object.keys(request.secrets),
    includeGit: request.includeGit,
    ...(signal !== undefined ? { signal } : {}),
  };
}
