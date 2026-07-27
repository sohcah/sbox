/**
 * Directory stage paths for remote Client-path materialization.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxIdentity } from "../identity.js";

export function defaultDirectoryStageRoot(): string {
  const override = process.env["SBOX_DIRECTORY_STAGE_ROOT"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(homedir(), ".sbox", "directory-stages");
}

export function directoryStageRootForIdentity(
  identity: SandboxIdentity,
  dataRoot: string = defaultDirectoryStageRoot(),
): string {
  return join(dataRoot, identity.project, identity.instance);
}

/** One create attempt's stage tree; safe to delete without touching other generations. */
export function directoryStageGenerationRoot(
  identity: SandboxIdentity,
  generationId: string,
  dataRoot: string = defaultDirectoryStageRoot(),
): string {
  return join(directoryStageRootForIdentity(identity, dataRoot), generationId);
}

export function directoryStagePathForMount(
  identity: SandboxIdentity,
  generationId: string,
  mountIndex: number,
  dataRoot: string = defaultDirectoryStageRoot(),
): string {
  return join(directoryStageGenerationRoot(identity, generationId, dataRoot), String(mountIndex));
}
