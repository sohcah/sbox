/**
 * Public surface for `@sohcah/sbox`.
 *
 * Explicit narrow exports only. Microsandbox SDK types are never exported.
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

export type { Host } from "./host.js";
export { disposeHost } from "./host.js";

export { createLocalHost, type LocalHostOptions } from "./local-host.js";
