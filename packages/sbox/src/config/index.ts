/**
 * Configuration module re-exports used by the package root allowlist and by
 * internal client/CLI code. Prefer importing through `@sohcah/sbox` for product
 * consumers; target materialization helpers remain package-private.
 */

export type {
  ConfigValue,
  ConfigurationIssue,
  DirectoryMountConfig,
  ExternalValueRef,
  LocalTargetConfig,
  ProfileConfig,
  ProjectConfig,
  RemoteTargetConfig,
  SafeDirectoryMount,
  SafeProjectConfig,
  SafeUserConfig,
  TargetConfig,
  UserConfig,
  VolumeAttachment,
  VolumeDeclaration,
} from "./types.js";

export {
  parseProjectConfig,
  parseUserConfig,
  tryParseProjectConfig,
  tryParseUserConfig,
  parseYamlProjectInput,
  tryParseYamlProjectInput,
  toSafeProjectConfig,
  toSafeUserConfig,
  throwAccumulatedValidation,
} from "./validate.js";

export {
  loadProjectConfigFromYaml,
  loadUserConfigFromYaml,
  tryLoadProjectConfigFromYaml,
  tryLoadUserConfigFromYaml,
} from "./yaml.js";

export {
  discoverProjectConfig,
  discoverUserConfig,
  type ConfigDiscoveryOptions,
  type DiscoveredProjectConfig,
  type DiscoveredUserConfig,
  type DiscoveryEnvironment,
  type DiscoverySource,
  type PlatformKind,
} from "./discovery.js";

export {
  resolveEnvironmentMap,
  resolveExternalValue,
  throwMissingExternalReferences,
  isExternalValueRef,
  type ExternalResolutionContext,
  type ExternalResolutionResult,
} from "./external.js";

export {
  selectProfile,
  resolveInstanceId,
  defaultInstanceForProfile,
  type SelectedProfile,
  type ProfileSelectionSource,
} from "./profile.js";

export {
  requireLocalTarget,
  resolveTarget,
  selectTargetName,
  assertLocalTarget,
  type ResolvedTarget,
  type ResolvedLocalTarget,
  type ResolvedRemoteTarget,
  type TargetResolutionInput,
  type TargetSelectionSource,
} from "./targets.js";

export {
  assertAbsoluteGuestPath,
  assertConfigSlug,
  assertEnvVarName,
  isAbsoluteGuestPath,
  isBinarySize,
  isEnvVarName,
  isPositiveDuration,
  parseBinarySizeToBytes,
  parseBinarySizeToMiB,
  parseDurationToSecs,
} from "./scalars.js";
