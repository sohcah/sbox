/**
 * Public surface for `@sohcah/sbox`.
 *
 * Explicit allowlisted exports only. Imports come from leaf modules so private
 * config/target/CLI plumbing cannot enter the public declaration graph.
 * Microsandbox SDK types are never exported.
 */

export { PACKAGE_NAME, PACKAGE_VERSION } from "./package-meta.js";

export {
  SBOX_ERROR_CODES,
  SboxError,
  SECRET_DETAIL_CANARY_KEYS,
  isSboxError,
  isAbortError,
  throwIfAborted,
  wrapUnknownFailure,
  type SboxErrorCode,
  type SboxErrorDetails,
  type SafeSboxError,
  type SboxErrorOptions,
} from "./errors.js";

export {
  NATIVE_SANDBOX_NAME_MAX_BYTES,
  assertProjectId,
  assertProfileId,
  assertInstanceId,
  assertSandboxIdentity,
  isPortableSlug,
  nativeSandboxName,
  stableIdentityHash,
  utf8Bytes,
  truncateUtf8,
  type ProjectId,
  type ProfileId,
  type InstanceId,
  type NativeSandboxName,
  type SandboxIdentity,
} from "./identity.js";

export {
  OWNERSHIP_LABEL_KEYS,
  MANAGED_LABEL_VALUE,
  inspectOwnershipLabels,
  isSboxOwned,
  hasPartialReservedLabels,
  type LabelMap,
  type OwnershipMatch,
} from "./ownership.js";

export type {
  KnownSandboxLifecycleState,
  SandboxLifecycleState,
  OperationOptions,
  HostCreateRequest,
  HostListOptions,
  HostCapabilities,
  SandboxCreationSettings,
  SandboxInspection,
  SandboxSummary,
  ProcessResult,
  ProcessEvent,
} from "./types.js";

export { mapNativeLifecycleState, sandboxIdentityKey } from "./types.js";

export {
  LOG_LEVELS,
  silentLogger,
  createRedactingLogger,
  safeLog,
  redactLogEvent,
  collectingLogger,
  SECRET_LOG_CANARY_KEYS,
  type LogLevel,
  type LogEvent,
  type Logger,
} from "./logging.js";

export type {
  Host,
  HostExecArgvRequest,
  HostExecShellRequest,
  HostPtyRequest,
  HostCopyPaths,
} from "./host.js";
export { disposeHost } from "./host.js";

export {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  resolveOutputLimits,
  assertTimeoutMs,
  assertPtyDimension,
  type OutputLimits,
} from "./process/limits.js";

export {
  bytesToUtf8,
  utf8ToBytes,
  concatBytes,
  IncrementalUtf8Decoder,
  LineDecoder,
  collectUtf8,
  collectLines,
} from "./process/decode.js";

export { collectProcessEvents, type CollectProcessOptions } from "./process/collect.js";

export type {
  ProcessStdin,
  ProcessSession,
  PtySize,
  PtySession,
  HostExecBaseOptions,
  HostCollectedExecOptions,
  HostStreamingExecOptions,
  HostPtyOptions,
} from "./process/session.js";

export type { TransferOverwrite, HostCopyOptions, HostCopyRequest } from "./transfer/types.js";

export { createLocalHost, type LocalHostOptions } from "./local-host.js";

export {
  SBOX_PROTOCOL_VERSION,
  createRemoteHost,
  createSboxServer,
  DEFAULT_REMOTE_LIMITS,
  resolveRemoteLimits,
  type RemoteHostOptions,
  type SboxServer,
  type SboxServerOptions,
  type RemoteLimits,
  type HealthResponse,
  type HandshakeResponse,
} from "./remote/index.js";

export type {
  ConfigValue,
  ConfigurationIssue,
  DirectoryMountConfig,
  ExternalValueRef,
  ImageBuildConfig,
  ImageBuildProfile,
  ImageReferenceProfile,
  LocalTargetConfig,
  ProfileConfig,
  ProjectConfig,
  RemoteTargetConfig,
  SafeDirectoryMount,
  SafeImageBuildConfig,
  SafeProjectConfig,
  SafeUserConfig,
  TargetConfig,
  UserConfig,
  VolumeAttachment,
  VolumeDeclaration,
} from "./config/types.js";

export type {
  HostNetworkConfig,
  InspectedPublishedPort,
  NetworkAllowRule,
  NetworkConfig,
  NetworkMode,
  NetworkPortSpec,
  NetworkProtocol,
  PublishedPortSpec,
  ResolvedRuntimeSecret,
  RuntimeSecretConfig,
  SafeNetworkConfig,
  SafeRuntimeSecret,
} from "./network/types.js";

export { defaultNetworkConfig, DEFAULT_NETWORK_BIND } from "./network/types.js";

export { isBuildProfile, isImageReferenceProfile } from "./config/types.js";

export {
  parseProjectConfig,
  parseUserConfig,
  tryParseProjectConfig,
  tryParseUserConfig,
  parseYamlProjectInput,
  tryParseYamlProjectInput,
  toSafeProjectConfig,
  toSafeUserConfig,
  toSafeBuildConfig,
  throwAccumulatedValidation,
} from "./config/validate.js";

export {
  loadProjectConfigFromYaml,
  loadUserConfigFromYaml,
  tryLoadProjectConfigFromYaml,
  tryLoadUserConfigFromYaml,
} from "./config/yaml.js";

export {
  discoverProjectConfig,
  discoverUserConfig,
  type ConfigDiscoveryOptions,
  type DiscoveredProjectConfig,
  type DiscoveredUserConfig,
  type DiscoverySource,
  type PlatformKind,
} from "./config/discovery.js";

export {
  selectProfile,
  resolveInstanceId,
  defaultInstanceForProfile,
  type SelectedProfile,
  type ProfileSelectionSource,
} from "./config/profile.js";

export type {
  SboxClient,
  SboxClientOptions,
  ProfileOperationOptions,
  ClientOperationOptions,
  ClientListOptions,
  ClientBuildOptions,
} from "./client/client.js";

export { createSboxClient } from "./client/client.js";
export { createSboxClientFromYaml, type YamlSboxClientOptions } from "./client/from-yaml.js";
export type { SandboxHandle } from "./client/handle.js";

export type {
  HostImageSummary,
  HostImageInspection,
  HostEnsureImageRequest,
  HostEnsureImageOptions,
  HostListImagesOptions,
  HostRemoveImageOptions,
  ImageBuildProgressEvent,
  ImageBuildPhase,
  ImageContentDigest,
  StaleImageWorkspace,
  HostListStaleImageWorkspacesOptions,
} from "./image/types.js";

export type {
  HostEnsureVolumeRequest,
  HostListVolumesRequest,
  HostRemoveVolumeRequest,
  HostVolumeAttachment,
  HostVolumeInspection,
  HostVolumeShellRequest,
  HostVolumeSummary,
  VolumeAttachmentSpec,
} from "./volume/types.js";

export type {
  DirectoryAttachmentSpec,
  DirectoryMountSource,
  HostDirectoryMount,
  HostMount,
  MountAttachmentSpec,
  MountKind,
  MountSource,
} from "./directory/types.js";

/** Documented CLI operational exit codes (the runner itself is not exported). */
export {
  EXIT_SUCCESS,
  EXIT_OPERATIONAL,
  EXIT_VALIDATION,
  EXIT_OWNERSHIP,
  EXIT_NOT_FOUND,
  EXIT_ALREADY_EXISTS,
  EXIT_CANCELLED,
  exitCodeForError,
} from "./cli/exit-codes.js";
