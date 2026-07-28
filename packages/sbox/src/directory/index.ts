/**
 * Host mount helpers.
 */

export type {
  DirectoryAttachmentSpec,
  DirectoryMountSource,
  HostDirectoryMount,
  HostMount,
  MountAttachmentSpec,
  MountKind,
  MountMode,
  MountSource,
} from "./types.js";
export { canonicalDirectoriesFingerprint, canonicalMountsFingerprint, mountMode } from "./types.js";
export {
  normalizeDirectoryMountConfig,
  normalizeHostMountConfig,
  type RequiredDirectoryMount,
  type RequiredHostMount,
} from "./normalize.js";
export { assertBindableDirectory, assertBindablePath } from "./assert-directory.js";
export {
  expandHomePrefix,
  isAbsoluteHostPath,
  isAbsoluteOrHomeRelativeHostPath,
  isHomeRelativePath,
} from "./home-path.js";
export {
  bindMountsMatchDirectories,
  bindMountsMatchHostMounts,
  canonicalBindMountFingerprint,
  decodeBindMounts,
} from "./decode-binds.js";
export {
  directoriesFromLabels,
  directoriesLabelValue,
  mountsFromLabels,
  mountsLabelValue,
} from "./labels.js";
export {
  defaultDirectoryStageRoot,
  directoryStageGenerationRoot,
  directoryStagePathForMount,
  directoryStageRootForIdentity,
} from "./paths.js";
export {
  materializeClientDirectoryStages,
  materializeClientMountStages,
  packClientDirectoryArchive,
  packClientMountArchive,
  removeDirectoryStageGeneration,
  removeDirectoryStages,
  type MaterializedDirectoryStages,
  type MaterializedMountStages,
} from "./stages.js";
export { assertHostDirectoryMounts, assertHostMounts, assertMountKind } from "./validate.js";
