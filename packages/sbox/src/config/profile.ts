/**
 * Profile selection and default-instance identity.
 */

import { assertInstanceId, assertProfileId, type InstanceId, type ProfileId } from "../identity.js";
import { SboxError } from "../errors.js";
import type { ProfileConfig, ProjectConfig } from "./types.js";

export type ProfileSelectionSource = "explicit" | "default-profile" | "sole-profile";

export interface SelectedProfile {
  readonly name: ProfileId;
  readonly profile: ProfileConfig;
  readonly source: ProfileSelectionSource;
}

export function selectProfile(project: ProjectConfig, profileName?: string): SelectedProfile {
  if (profileName !== undefined) {
    const name = assertProfileId(profileName, "profile");
    const profile = project.profiles[name];
    if (profile === undefined) {
      throw SboxError.validation(`Profile ${JSON.stringify(name)} is not defined.`, {
        details: { path: "profile", message: "Unknown profile." },
      });
    }
    return { name, profile, source: "explicit" };
  }

  if (project.defaultProfile !== undefined) {
    const name = assertProfileId(project.defaultProfile, "defaultProfile");
    const profile = project.profiles[name];
    if (profile === undefined) {
      throw SboxError.validation(
        `defaultProfile ${JSON.stringify(project.defaultProfile)} is not defined.`,
        { details: { path: "defaultProfile" } },
      );
    }
    return { name, profile, source: "default-profile" };
  }

  const names = Object.keys(project.profiles);
  if (names.length === 1) {
    const only = names[0]!;
    const name = assertProfileId(only, "profile");
    return { name, profile: project.profiles[only]!, source: "sole-profile" };
  }

  throw SboxError.validation(
    "Profile selection is ambiguous: pass an explicit profile or set defaultProfile.",
    {
      details: {
        path: "profile",
        message: "Multiple profiles are configured and no defaultProfile is set.",
        profiles: names,
      },
    },
  );
}

/**
 * Default portable instance identity for a profile is the profile slug itself.
 */
export function defaultInstanceForProfile(profile: ProfileId | string): InstanceId {
  return assertInstanceId(profile, "instance");
}

export function resolveInstanceId(profile: ProfileId, instance?: string): InstanceId {
  if (instance === undefined) {
    return defaultInstanceForProfile(profile);
  }
  return assertInstanceId(instance, "instance");
}
