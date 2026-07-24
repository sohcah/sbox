/**
 * Portable identity scalars and deterministic Microsandbox native names.
 *
 * Native names are derived from project + instance identity with a stable hash
 * so truncation cannot collide. Names are limited to 128 UTF-8 bytes.
 */

import { createHash } from "node:crypto";
import { SboxError } from "./errors.js";

export const NATIVE_SANDBOX_NAME_MAX_BYTES = 128;

const PORTABLE_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PORTABLE_SLUG_MAX_CHARS = 63;
const NATIVE_HASH_HEX_LEN = 16;
const NATIVE_PREFIX = "sbox";

export type ProjectId = string & { readonly __brand: "ProjectId" };
export type ProfileId = string & { readonly __brand: "ProfileId" };
export type InstanceId = string & { readonly __brand: "InstanceId" };
export type NativeSandboxName = string & { readonly __brand: "NativeSandboxName" };

export interface SandboxIdentity {
  readonly project: ProjectId;
  readonly profile: ProfileId;
  readonly instance: InstanceId;
}

export function isPortableSlug(input: string): boolean {
  return (
    PORTABLE_SLUG_PATTERN.test(input) &&
    input.length >= 1 &&
    input.length <= PORTABLE_SLUG_MAX_CHARS
  );
}

export function assertProjectId(input: string, path = "project"): ProjectId {
  return assertSlug(input, path) as ProjectId;
}

export function assertProfileId(input: string, path = "profile"): ProfileId {
  return assertSlug(input, path) as ProfileId;
}

export function assertInstanceId(input: string, path = "instance"): InstanceId {
  return assertSlug(input, path) as InstanceId;
}

export function assertSandboxIdentity(input: {
  readonly project: string;
  readonly profile: string;
  readonly instance: string;
}): SandboxIdentity {
  return {
    project: assertProjectId(input.project),
    profile: assertProfileId(input.profile),
    instance: assertInstanceId(input.instance),
  };
}

function assertSlug(input: string, path: string): string {
  if (!isPortableSlug(input)) {
    throw SboxError.validation(`Invalid portable slug at ${path}.`, {
      details: {
        path,
        message: `Expected a lowercase slug matching [a-z][a-z0-9]*(-[a-z0-9]+)* up to ${PORTABLE_SLUG_MAX_CHARS} characters; received ${JSON.stringify(input)}.`,
      },
    });
  }
  return input;
}

/**
 * Deterministic native Microsandbox name for a project/instance pair.
 *
 * Readable segments are sanitized and truncated when needed; a stable hash
 * always remains so truncated names cannot collide.
 */
export function nativeSandboxName(project: string, instance: string): NativeSandboxName {
  const hash = stableIdentityHash(project, instance);
  const suffix = `-${hash}`;
  const prefix = `${NATIVE_PREFIX}-`;
  const budget = NATIVE_SANDBOX_NAME_MAX_BYTES - utf8Bytes(prefix) - utf8Bytes(suffix);
  if (budget < 1) {
    // Extremely defensive: hash alone must still fit under the Microsandbox limit.
    const compact = `${NATIVE_PREFIX}-${hash}` as NativeSandboxName;
    assertNativeNameLength(compact);
    return compact;
  }

  const projectPart = sanitizeNameSegment(project);
  const instancePart = sanitizeNameSegment(instance);
  let readable =
    projectPart.length > 0 && instancePart.length > 0
      ? `${projectPart}-${instancePart}`
      : projectPart || instancePart || "x";

  readable = truncateUtf8(readable, budget).replace(/-+$/g, "");
  if (readable.length === 0) {
    readable = "x";
    if (utf8Bytes(readable) > budget) {
      const compact = `${NATIVE_PREFIX}-${hash}` as NativeSandboxName;
      assertNativeNameLength(compact);
      return compact;
    }
  }

  const name = `${prefix}${readable}${suffix}` as NativeSandboxName;
  assertNativeNameLength(name);
  return name;
}

export function stableIdentityHash(project: string, instance: string): string {
  return createHash("sha256")
    .update(project, "utf8")
    .update("\0", "utf8")
    .update(instance, "utf8")
    .digest("hex")
    .slice(0, NATIVE_HASH_HEX_LEN);
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (utf8Bytes(value) <= maxBytes) {
    return value;
  }
  const buffer = Buffer.from(value, "utf8");
  let end = maxBytes;
  while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) {
    end -= 1;
  }
  if (end > 0 && (buffer[end - 1]! & 0xc0) === 0xc0) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

function sanitizeNameSegment(input: string): string {
  const normalized = input.normalize("NFKC").toLowerCase();
  return normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function assertNativeNameLength(name: string): void {
  const bytes = utf8Bytes(name);
  if (bytes > NATIVE_SANDBOX_NAME_MAX_BYTES) {
    throw SboxError.internal(
      `Derived native sandbox name exceeds ${NATIVE_SANDBOX_NAME_MAX_BYTES} UTF-8 bytes.`,
      { details: { bytes, maxBytes: NATIVE_SANDBOX_NAME_MAX_BYTES } },
    );
  }
  if (bytes === 0) {
    throw SboxError.internal("Derived native sandbox name is empty.");
  }
}
