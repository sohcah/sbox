/**
 * Directory mount helpers.
 */

export type { DirectoryAttachmentSpec, DirectoryMountSource, HostDirectoryMount } from "./types.js";
export { canonicalDirectoriesFingerprint } from "./types.js";
export { normalizeDirectoryMountConfig, type RequiredDirectoryMount } from "./normalize.js";
export { assertBindableDirectory } from "./assert-directory.js";
export {
  bindMountsMatchDirectories,
  canonicalBindMountFingerprint,
  decodeBindMounts,
} from "./decode-binds.js";
export { directoriesFromLabels, directoriesLabelValue } from "./labels.js";
export {
  defaultDirectoryStageRoot,
  directoryStageGenerationRoot,
  directoryStagePathForMount,
  directoryStageRootForIdentity,
} from "./paths.js";
export {
  materializeClientDirectoryStages,
  packClientDirectoryArchive,
  removeDirectoryStageGeneration,
  removeDirectoryStages,
  type MaterializedDirectoryStages,
} from "./stages.js";
export { assertHostDirectoryMounts } from "./validate.js";
