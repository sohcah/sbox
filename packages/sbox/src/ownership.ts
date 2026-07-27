/**
 * Reserved Microsandbox ownership labels (public inspection surface).
 *
 * Native names are never ownership evidence. Missing or mismatched reserved
 * labels fail closed as ownership conflicts.
 *
 * Fingerprint construction and native adoption comparison are internal to the
 * Host adapter and are not part of the public package API.
 */

import type { InstanceId, ProfileId, ProjectId, SandboxIdentity } from "./identity.js";

export const OWNERSHIP_LABEL_KEYS = Object.freeze({
  managed: "dev.sohcah.sbox/managed",
  project: "dev.sohcah.sbox/project",
  instance: "dev.sohcah.sbox/instance",
  profile: "dev.sohcah.sbox/profile",
  creation: "dev.sohcah.sbox/creation",
  /** Base64url JSON of canonical DirectoryAttachmentSpec[] for inspection. */
  directories: "dev.sohcah.sbox/directories",
} as const);

export const MANAGED_LABEL_VALUE = "true";

export type LabelMap = Readonly<Record<string, string>>;

export type OwnershipMatch =
  | { readonly ok: true; readonly identity: SandboxIdentity; readonly creation: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Extract sbox ownership from labels, or fail closed.
 */
export function inspectOwnershipLabels(labels: LabelMap | undefined): OwnershipMatch {
  if (labels === undefined) {
    return { ok: false, reason: "Labels are missing." };
  }

  const managed = labels[OWNERSHIP_LABEL_KEYS.managed];
  if (managed !== MANAGED_LABEL_VALUE) {
    return { ok: false, reason: "Managed ownership marker is missing or invalid." };
  }

  const project = labels[OWNERSHIP_LABEL_KEYS.project];
  if (project === undefined || project.length === 0) {
    return { ok: false, reason: "Project label is missing." };
  }

  const instance = labels[OWNERSHIP_LABEL_KEYS.instance];
  if (instance === undefined || instance.length === 0) {
    return { ok: false, reason: "Instance label is missing." };
  }

  const profile = labels[OWNERSHIP_LABEL_KEYS.profile];
  if (profile === undefined || profile.length === 0) {
    return { ok: false, reason: "Profile label is missing." };
  }

  const creation = labels[OWNERSHIP_LABEL_KEYS.creation];
  if (creation === undefined || creation.length === 0) {
    return { ok: false, reason: "Creation fingerprint label is missing." };
  }

  return {
    ok: true,
    identity: {
      project: project as ProjectId,
      instance: instance as InstanceId,
      profile: profile as ProfileId,
    },
    creation,
  };
}

export function isSboxOwned(labels: LabelMap | undefined): boolean {
  return inspectOwnershipLabels(labels).ok;
}

export function hasPartialReservedLabels(labels: LabelMap | undefined): boolean {
  if (labels === undefined) {
    return false;
  }
  // directories is optional (absent when unused); do not treat it as required evidence.
  const keys = [
    OWNERSHIP_LABEL_KEYS.managed,
    OWNERSHIP_LABEL_KEYS.project,
    OWNERSHIP_LABEL_KEYS.instance,
    OWNERSHIP_LABEL_KEYS.profile,
    OWNERSHIP_LABEL_KEYS.creation,
  ] as const;
  const present = keys.filter((key) => {
    const value = labels[key];
    return value !== undefined && value.length > 0;
  });
  return present.length > 0 && present.length < keys.length;
}
