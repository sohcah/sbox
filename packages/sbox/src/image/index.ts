/**
 * Image module public surface for Host/client (still re-exported selectively).
 */

export {
  IMAGE_IDENTITY_ALGORITHM_VERSION,
  IMAGE_LABEL_KEYS,
  IMAGE_ENV_KEYS,
  NATIVE_IMAGE_REFERENCE_MAX_BYTES,
  formatImageContentDigest,
  formatNativeImageReference,
  parseNativeImageReference,
  buildImageOwnershipLabels,
  buildImageOwnershipEnv,
  buildOwnershipDockerChanges,
  inspectImageOwnershipEvidence,
  inspectImageOwnershipLabels,
  hasNoReservedImageEvidence,
  type ImageOwnershipMatch,
} from "./naming.js";

export {
  computeImageContentIdentity,
  compareRelativePaths,
  permissionBits,
  type ContextEntry,
  type ContextFileEntry,
  type ContextDirectoryEntry,
  type ContextSymlinkEntry,
  type ImageIdentityModel,
  type ImageContentIdentity,
} from "./identity.js";

export {
  discoverBuildContext,
  materializeContextEntries,
  assertSafeSymlinkTarget,
  normalizePosixRelative,
  type DiscoverContextOptions,
  type DiscoveredBuildContext,
} from "./context.js";

export { hostDockerPlatform } from "./platform.js";

export {
  encodeDockerBuild,
  encodeDockerSave,
  encodeDockerImageRemove,
  encodeDockerCreate,
  encodeDockerCommit,
  encodeDockerContainerRemove,
  encodeMsbImageLoad,
} from "./docker-argv.js";

export { ensureImage, clearEnsureImageCoalescing, type EnsureImagePorts } from "./ensure.js";
export {
  computeGeneratedImageIdentity,
  identityInputsFromEnsureRequest,
  type ImageIdentityInputs,
} from "./compute.js";

export {
  defaultImageWorkspaceRoot,
  createImageWorkspace,
  cleanupImageWorkspace,
  listStaleImageWorkspaces,
  WORKSPACE_MARKER_NAME,
  WORKSPACE_MARKER_VALUE,
} from "./workspace.js";

export type {
  ImageBuildPhase,
  ImageBuildProgressEvent,
  ImageContentDigest,
  HostImageSummary,
  HostImageInspection,
  HostEnsureImageRequest,
  HostEnsureImageOptions,
  HostListImagesOptions,
  HostRemoveImageOptions,
  StaleImageWorkspace,
  HostListStaleImageWorkspacesOptions,
} from "./types.js";
