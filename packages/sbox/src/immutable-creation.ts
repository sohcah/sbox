/**
 * Immutable creation projection helpers.
 *
 * Internal to Host adapters. Not part of the public package declaration graph.
 */

import type { SandboxImmutableCreation } from "./ownership-adoption.js";

/** SDK defaults observed from microsandbox@0.6.6 minimal builder.build(). */
export const PHASE1_DEFAULT_CPUS = 1;
export const PHASE1_DEFAULT_MEMORY_MIB = 512;

export type { SandboxImmutableCreation };

/** @internal Alias used by Host adapters. */
export type ImmutableCreationProjection = SandboxImmutableCreation;

export function projectCreateRequest(request: {
  readonly image: string;
  readonly cpus?: number;
  readonly memoryMiB?: number;
  readonly workdir?: string;
  readonly user?: string;
  readonly shell?: string;
  readonly hostname?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxDurationSecs?: number | null;
  readonly idleTimeoutSecs?: number | null;
}): SandboxImmutableCreation {
  return Object.freeze({
    image: request.image,
    cpus: request.cpus ?? PHASE1_DEFAULT_CPUS,
    memoryMiB: request.memoryMiB ?? PHASE1_DEFAULT_MEMORY_MIB,
    workdir: request.workdir ?? null,
    user: request.user ?? null,
    shell: request.shell ?? null,
    hostname: request.hostname ?? null,
    env: Object.freeze(request.env === undefined ? {} : { ...request.env }),
    maxDurationSecs: request.maxDurationSecs ?? null,
    idleTimeoutSecs: request.idleTimeoutSecs ?? null,
  });
}

export function immutableCreationEquals(
  left: SandboxImmutableCreation,
  right: SandboxImmutableCreation,
): boolean {
  return (
    left.image === right.image &&
    left.cpus === right.cpus &&
    left.memoryMiB === right.memoryMiB &&
    left.workdir === right.workdir &&
    left.user === right.user &&
    left.shell === right.shell &&
    left.hostname === right.hostname &&
    left.maxDurationSecs === right.maxDurationSecs &&
    left.idleTimeoutSecs === right.idleTimeoutSecs &&
    envRecordsEqual(left.env, right.env)
  );
}

/**
 * Safe field names that differ between two immutable projections.
 * Environment values are never returned—only the aggregate `environment` marker.
 */
export function immutableCreationDriftFields(
  expected: SandboxImmutableCreation,
  actual: SandboxImmutableCreation,
): readonly string[] {
  const fields: string[] = [];
  if (expected.image !== actual.image) {
    fields.push("image");
  }
  if (expected.cpus !== actual.cpus) {
    fields.push("cpus");
  }
  if (expected.memoryMiB !== actual.memoryMiB) {
    fields.push("memoryMiB");
  }
  if (expected.workdir !== actual.workdir) {
    fields.push("workdir");
  }
  if (expected.user !== actual.user) {
    fields.push("user");
  }
  if (expected.shell !== actual.shell) {
    fields.push("shell");
  }
  if (expected.hostname !== actual.hostname) {
    fields.push("hostname");
  }
  if (expected.maxDurationSecs !== actual.maxDurationSecs) {
    fields.push("maxDurationSecs");
  }
  if (expected.idleTimeoutSecs !== actual.idleTimeoutSecs) {
    fields.push("idleTimeoutSecs");
  }
  if (!envRecordsEqual(expected.env, actual.env)) {
    fields.push("environment");
  }
  return fields;
}

function envRecordsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}
