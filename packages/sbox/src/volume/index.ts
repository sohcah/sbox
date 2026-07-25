/**
 * Managed QCOW2 volume helpers (paths, lock, qemu-img, ensure, children).
 */

export type {
  HostVolumeAttachment,
  HostVolumeInspection,
  HostVolumeShellRequest,
  HostVolumeSummary,
  HostEnsureVolumeRequest,
  HostListVolumesRequest,
  HostRemoveVolumeRequest,
  VolumeAttachmentSpec,
} from "./types.js";

export {
  BASE_QCOW2_NAME,
  CHILDREN_DIR_NAME,
  assertManagedHostPath,
  childOverlayPath,
  defaultVolumeDataRoot,
  isManagedChildOverlayPath,
  isManagedHostPath,
  projectVolumeRoot,
  volumePaths,
} from "./paths.js";

export {
  VOLUME_LABEL_KEYS,
  VOLUME_MAINTENANCE_PURPOSE,
  buildVolumeMaintenanceLabels,
  isMaintenanceInstanceId,
  isVolumeMaintenanceLabels,
  maintenanceInstanceId,
} from "./naming.js";

export {
  acquireVolumeLock,
  withVolumeLock,
  volumeLockListenPath,
  POSIX_VOLUME_LOCK_LISTEN_MAX,
  type VolumeLockHandle,
} from "./lock.js";

export {
  assertBaseQcow2Info,
  assertChildQcow2Info,
  parseQemuImgInfoJson,
  probeQemuImg,
  qemuImgCreateOverlay,
  qemuImgConvertRawToQcow2,
  qemuImgInfo,
  requireQemuImg,
  type QemuImgInfo,
  type QemuImgPorts,
} from "./qemu-img.js";

export { decodeDiskMounts, type DecodedDiskMount } from "./mounts.js";

export {
  ensureChildOverlay,
  removeChildOverlay,
  removeHostOverlayPath,
  validateChildCreateInputs,
} from "./child.js";

export {
  DEFAULT_VOLUME_FORMATTER_IMAGE,
  formatAndPublishBase,
  volumeFormatterImage,
  type FormatBasePorts,
} from "./format-base.js";

export {
  ensureVolumeBase,
  ensureVolumeBaseLocked,
  type EnsureBasePorts,
  type EnsureBaseRequest,
} from "./ensure-base.js";

export {
  countOrdinaryDescendants,
  listVolumeDescendants,
  type ListDescendantsRequest,
  type VolumeDescendant,
} from "./descendants.js";

export { volumeAttachmentsFromMounts } from "./from-mounts.js";

export {
  assertNoOrdinaryDescendants,
  buildMaintenanceOwnershipLabels,
  maintenanceIdentity,
  maintenanceNativeName,
  recoverCrashedMaintenance,
} from "./maintenance.js";
