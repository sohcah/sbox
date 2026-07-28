/**
 * Local Microsandbox Host adapter for Phase 1 lifecycle.
 *
 * Thin mapping over the pinned SDK via NativeRuntime. No durable sbox state.
 * Not part of the public package export graph.
 */

import { SboxError, isSboxError, throwIfAborted, wrapUnknownFailure } from "./errors.js";
import { Sandbox } from "microsandbox";
import type { Host } from "./host.js";
import {
  assertProjectId,
  assertProfileId,
  assertSandboxIdentity,
  nativeSandboxName,
  type NativeSandboxName,
  type SandboxIdentity,
} from "./identity.js";
import { ensureImage } from "./image/ensure.js";
import { hostDockerPlatform } from "./image/platform.js";
import {
  formatImageContentDigest,
  IMAGE_IDENTITY_ALGORITHM_VERSION,
  inspectImageOwnershipEvidence,
  parseNativeImageReference,
} from "./image/naming.js";
import {
  nativeImageGet,
  nativeImageList,
  nativeImageRemove,
  toHostImageSummary,
} from "./image/native-images.js";
import type {
  HostEnsureImageOptions,
  HostEnsureImageRequest,
  HostImageInspection,
  HostImageSummary,
  HostListImagesOptions,
  HostListStaleImageWorkspacesOptions,
  HostRemoveImageOptions,
  StaleImageWorkspace,
} from "./image/types.js";
import { listStaleImageWorkspaces } from "./image/workspace.js";
import { createRedactingLogger, safeLog, silentLogger, type Logger } from "./logging.js";
import { createMicrosandboxRuntime } from "./microsandbox-runtime.js";
import type {
  NativeBindMount,
  NativeDiskMount,
  NativeLiveHandle,
  NativeRuntime,
  NativeSandboxRecord,
} from "./native-runtime.js";
import { mapNativeStatus } from "./native-runtime.js";
import { buildOwnershipLabels, matchOwnedCreation } from "./ownership-adoption.js";
import { inspectOwnershipLabels, type LabelMap } from "./ownership.js";
import { projectCreateRequest, type ImmutableCreationProjection } from "./immutable-creation.js";
import { assertBindablePath } from "./directory/assert-directory.js";
import { mountsFromLabels } from "./directory/labels.js";
import { removeDirectoryStages } from "./directory/stages.js";
import type { HostMount } from "./directory/types.js";
import { mountMode } from "./directory/types.js";
import { assertHostMounts } from "./directory/validate.js";
import { expandHomePrefix } from "./directory/home-path.js";
import type {
  HostCopyPaths,
  HostExecArgvRequest,
  HostExecShellRequest,
  HostPtyRequest,
  HostTerminalAttachOptions,
} from "./host.js";
import { startAgentPty } from "./internal/agent-pty.js";
import {
  execArgvCollected,
  execArgvStream,
  execShellCollected,
  execShellStream,
} from "./local-process.js";
import { copyGuestToHost, copyHostToGuest } from "./local-transfer.js";
import type {
  HostCollectedExecOptions,
  HostPtyOptions,
  HostStreamingExecOptions,
  ProcessSession,
  PtySession,
} from "./process/session.js";
import type { HostCopyOptions } from "./transfer/types.js";
import type {
  HostCapabilities,
  HostCreateRequest,
  HostListOptions,
  OperationOptions,
  ProcessResult,
  SandboxCreationSettings,
  SandboxInspection,
  SandboxSummary,
} from "./types.js";
import { defaultNetworkConfig, toSafeNetworkConfig } from "./network/types.js";
import {
  isDynamicHostPort,
  validateHostNetworkConfig,
  validateResolvedRuntimeSecrets,
} from "./network/validate.js";
import {
  acquireVolumeLock,
  assertNoOrdinaryDescendants,
  buildMaintenanceOwnershipLabels,
  countOrdinaryDescendants,
  defaultVolumeDataRoot,
  ensureChildOverlay,
  ensureVolumeBase,
  ensureVolumeBaseLocked,
  isManagedChildOverlayPath,
  listVolumeDescendants,
  maintenanceIdentity,
  maintenanceNativeName,
  projectVolumeRoot,
  recoverCrashedMaintenance,
  removeChildOverlay,
  requireQemuImg,
  volumeAttachmentsFromMounts,
  volumePaths,
  withVolumeLock,
  qemuImgInfo,
  type QemuImgInfo,
  type QemuImgPorts,
  type VolumeLockHandle,
} from "./volume/index.js";
import type {
  HostEnsureVolumeRequest,
  HostListVolumesRequest,
  HostRemoveVolumeRequest,
  HostVolumeInspection,
  HostVolumeShellRequest,
  HostVolumeSummary,
} from "./volume/types.js";
import { access, readdir, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

/** Internal testing seam. Not exported from the package root. */
export interface LocalHostInternalOptions {
  readonly logger?: Logger;
  readonly runtime?: NativeRuntime;
  readonly volumeDataRoot?: string;
  readonly qemuImg?: import("./volume/qemu-img.js").QemuImgPorts;
}

/** @internal Used by unit tests to inject a fake native runtime. */
export function createLocalHostInternal(options: LocalHostInternalOptions = {}): Host {
  return new LocalHost(options);
}

class LocalHost implements Host {
  private readonly logger: Logger;
  private readonly runtime: NativeRuntime;
  private readonly volumeDataRoot: string;
  private readonly qemuImg: QemuImgPorts | undefined;
  private readonly liveByName = new Map<string, NativeLiveHandle>();
  private disposed = false;

  constructor(options: LocalHostInternalOptions) {
    this.logger = createRedactingLogger(options.logger ?? silentLogger);
    this.runtime = options.runtime ?? createMicrosandboxRuntime();
    this.volumeDataRoot = options.volumeDataRoot ?? defaultVolumeDataRoot();
    this.qemuImg = options.qemuImg;
  }

  async create(request: HostCreateRequest, options?: OperationOptions): Promise<SandboxInspection> {
    return this.withOperation("create", request.identity, options, async () => {
      const identity = assertSandboxIdentity(request.identity);
      this.validateCreateRequest(request);
      const nativeName = nativeSandboxName(identity.project, identity.instance);
      const preparedMounts = await this.prepareMountBinds(request);
      const projected = projectCreateRequest({ ...request, mounts: preparedMounts.mounts });
      const labels = buildOwnershipLabels(identity, projected);

      const preexisting = await this.tryGet(nativeName);
      if (preexisting !== undefined) {
        throw this.conflictOrAlreadyExists(identity, nativeName, preexisting, projected);
      }

      const volumePrep = await this.prepareCreateVolumes(identity, request, options?.signal);
      const bindMounts = preparedMounts.bindMounts;
      let published = false;
      try {
        const live = await this.runtime.create({
          name: nativeName,
          image: projected.image,
          labels,
          detached: true,
          cpus: projected.cpus,
          memoryMiB: projected.memoryMiB,
          workdir: projected.workdir,
          user: projected.user,
          shell: projected.shell,
          hostname: projected.hostname,
          maxDurationSecs: projected.maxDurationSecs,
          idleTimeoutSecs: projected.idleTimeoutSecs,
          env: projected.env,
          network: projected.network,
          secrets: request.secrets ?? [],
          ...(volumePrep.mounts.length > 0 ? { mounts: volumePrep.mounts } : {}),
          ...(bindMounts.length > 0 ? { bindMounts } : {}),
        });
        published = true;
        this.liveByName.set(nativeName, live);
      } catch (error) {
        const mapped = wrapUnknownFailure(error, "Sandbox create failed.");
        try {
          if (isDefinitiveCreateFailure(mapped)) {
            const leftover = await this.tryGet(nativeName);
            if (leftover !== undefined) {
              const conflict = this.conflictOrAlreadyExists(
                identity,
                nativeName,
                leftover,
                projected,
              );
              // Owned already-exists keeps overlays; foreign conflict orphans ours.
              if (conflict.code === "ownership_conflict") {
                await volumePrep.rollback();
              }
              throw conflict;
            }
            await volumePrep.rollback();
            throw mapped;
          }
          try {
            return await this.reinspectUncertainCreate(identity, nativeName, projected, mapped);
          } catch (reinspectError) {
            const leftover = await this.tryGet(nativeName);
            if (leftover === undefined) {
              await volumePrep.rollback();
            } else {
              const ownership = matchOwnedCreation(
                this.creationEvidence(identity, leftover),
                identity,
                projected,
              );
              if (!ownership.ok) {
                await volumePrep.rollback();
              }
            }
            throw reinspectError;
          }
        } finally {
          await volumePrep.releaseLocks();
        }
      }

      // Success path: release volume locks after native create published.
      await volumePrep.releaseLocks();

      try {
        await this.applyCopyMounts(nativeName, preparedMounts.mounts, options?.signal);
      } catch (copyError) {
        await this.abortPublishedCreate(nativeName, identity, volumePrep.mounts);
        try {
          await volumePrep.rollback();
        } catch {
          // Best-effort after abort.
        }
        throw wrapUnknownFailure(copyError, "Sandbox create failed while applying copy mounts.");
      }

      try {
        await this.consumeLive(nativeName);
      } catch (detachError) {
        throw SboxError.internal(
          "Sandbox was created but releasing the local live handle failed.",
          {
            cause: detachError,
            details: { nativeName, cleanup: "detach_failed" },
          },
        );
      }

      try {
        return await this.inspectOwned(identity, nativeName);
      } catch (inspectError) {
        if (published) {
          throw wrapUnknownFailure(
            inspectError,
            "Sandbox was created but post-create inspection failed.",
          );
        }
        throw wrapUnknownFailure(inspectError);
      }
    });
  }

  async get(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.inspect(identity, options);
  }

  async list(options?: HostListOptions): Promise<readonly SandboxSummary[]> {
    return this.withOperation("list", undefined, options, async () => {
      const records = await this.runtime.list();
      const summaries: SandboxSummary[] = [];
      for (const record of records) {
        const ownership = inspectOwnershipLabels(record.labels);
        if (!ownership.ok) {
          continue;
        }
        if (options?.project !== undefined && ownership.identity.project !== options.project) {
          continue;
        }
        summaries.push({
          identity: ownership.identity,
          nativeName: record.name as NativeSandboxName,
          state: mapNativeStatus(record.status),
          image: record.image,
        });
      }
      return summaries;
    });
  }

  async inspect(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.withOperation("inspect", identity, options, async () => {
      const normalized = assertSandboxIdentity(identity);
      const nativeName = nativeSandboxName(normalized.project, normalized.instance);
      return this.inspectOwned(normalized, nativeName);
    });
  }

  async start(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.withOperation("start", identity, options, async () => {
      const normalized = assertSandboxIdentity(identity);
      const nativeName = nativeSandboxName(normalized.project, normalized.instance);
      const current = await this.requireOwned(normalized, nativeName);
      if (current.status === "running") {
        return this.toInspection(normalized, current);
      }
      if (current.status !== "stopped") {
        throw SboxError.nativeState(`Cannot start sandbox in native state ${current.status}.`, {
          details: { state: current.status, nativeName },
        });
      }
      await this.consumeLive(nativeName);
      const live = await this.runtime.start(nativeName);
      this.liveByName.set(nativeName, live);
      try {
        await this.consumeLive(nativeName);
      } catch (detachError) {
        throw SboxError.internal(
          "Sandbox was started but releasing the local live handle failed.",
          {
            cause: detachError,
            details: { nativeName, cleanup: "detach_failed" },
          },
        );
      }
      const fresh = await this.requireOwned(normalized, nativeName);
      return this.toInspection(normalized, fresh);
    });
  }

  async stop(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.withOperation("stop", identity, options, async () => {
      const normalized = assertSandboxIdentity(identity);
      const nativeName = nativeSandboxName(normalized.project, normalized.instance);
      const current = await this.requireOwned(normalized, nativeName);
      if (current.status === "stopped") {
        await this.consumeLive(nativeName);
        return this.toInspection(normalized, current);
      }
      if (current.status !== "running" && current.status !== "draining") {
        throw SboxError.nativeState(`Cannot stop sandbox in native state ${current.status}.`, {
          details: { state: current.status, nativeName },
        });
      }
      const fresh = await this.stopExact(nativeName);
      this.assertOwnedMatch(normalized, nativeName, fresh);
      return this.toInspection(normalized, fresh);
    });
  }

  async remove(identity: SandboxIdentity, options?: OperationOptions): Promise<void> {
    await this.withOperation("remove", identity, options, async () => {
      const normalized = assertSandboxIdentity(identity);
      const nativeName = nativeSandboxName(normalized.project, normalized.instance);
      const current = await this.tryGet(nativeName);
      if (current === undefined) {
        throw SboxError.notFound(
          `Sandbox ${normalized.project}/${normalized.instance} was not found.`,
          {
            details: {
              project: normalized.project,
              instance: normalized.instance,
              nativeName,
            },
          },
        );
      }
      this.assertOwnedMatch(normalized, nativeName, current);
      if (current.status === "running" || current.status === "draining") {
        await this.stopExact(nativeName);
      } else {
        await this.consumeLive(nativeName);
      }
      const fresh = await this.requireOwned(normalized, nativeName);
      if (fresh.status === "running" || fresh.status === "draining") {
        throw SboxError.busy(`Sandbox ${nativeName} is still running after stop.`, {
          details: { nativeName, state: fresh.status },
        });
      }
      await this.runtime.remove(nativeName);
      this.liveByName.delete(nativeName);
      await this.cleanupManagedOverlays(identity, current.mounts);
      await removeDirectoryStages(normalized);
    });
  }

  async capabilities(options?: OperationOptions): Promise<HostCapabilities> {
    return this.withOperation("capabilities", undefined, options, async () => {
      const probe = await this.runtime.probe();
      return {
        localMicrosandbox: probe.available,
        // Microsandbox 0.6.6 accepts host port 0 but does not expose the allocated
        // port via inspectable sandbox config, so dynamic publication is gated off.
        dynamicHostPorts: false,
        // qemu-img is probed only when volume operations run (requireQemuImg).
        qemuImg: false,
        dockerPlatform: hostDockerPlatform(),
        notes: [
          ...probe.notes,
          "Dynamic host ports are not advertised: allocated ports are not inspectable on Microsandbox 0.6.6.",
          "Host qemu-img availability is checked when managed volumes are used.",
        ],
      };
    });
  }

  async listVolumes(
    request: HostListVolumesRequest,
    options?: OperationOptions,
  ): Promise<readonly HostVolumeSummary[]> {
    return this.withOperation("listVolumes", undefined, options, async () => {
      const project = assertProjectId(request.project);
      const projectRoot = projectVolumeRoot(project, this.volumeDataRoot);
      let volumeNames: string[] = [];
      try {
        const entries = await readdir(projectRoot, { withFileTypes: true });
        volumeNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
      const records = await this.runtime.list();
      const summaries: HostVolumeSummary[] = [];
      for (const volume of volumeNames.toSorted()) {
        const paths = volumePaths(project, volume, this.volumeDataRoot);
        if (!(await pathExists(paths.basePath))) {
          continue;
        }
        const info = await this.safeBaseInfo(paths.basePath, options?.signal);
        if (info === undefined) {
          continue;
        }
        const descendants = await listVolumeDescendants({
          project,
          volume,
          sizeBytes: info.virtualSize,
          records,
          dataRoot: this.volumeDataRoot,
          ...(this.qemuImg !== undefined ? { qemuImg: this.qemuImg } : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
          validateChildren: false,
        });
        summaries.push({
          project,
          volume,
          basePath: paths.basePath,
          sizeBytes: info.virtualSize,
          descendantCount: countOrdinaryDescendants(descendants),
        });
      }
      return summaries;
    });
  }

  async ensureVolume(
    request: HostEnsureVolumeRequest,
    options?: OperationOptions,
  ): Promise<HostVolumeInspection> {
    return this.withOperation("ensureVolume", undefined, options, async () => {
      const project = assertProjectId(request.project);
      const ports = this.formatPorts(options?.signal);
      const ensured = await ensureVolumeBase(
        {
          project,
          volume: request.volume,
          sizeBytes: request.sizeBytes,
          dataRoot: this.volumeDataRoot,
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        },
        {
          ...ports,
          beforeEnsure: async () => {
            await recoverCrashedMaintenance({
              runtime: this.runtime,
              project,
              volume: request.volume,
              expectedNativeName: maintenanceNativeName(project, request.volume),
            });
          },
        },
      );
      const records = await this.runtime.list();
      const descendants = await listVolumeDescendants({
        project,
        volume: request.volume,
        sizeBytes: request.sizeBytes,
        records,
        dataRoot: this.volumeDataRoot,
        ...(this.qemuImg !== undefined ? { qemuImg: this.qemuImg } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        validateChildren: false,
      });
      return {
        project,
        volume: request.volume,
        basePath: ensured.basePath,
        sizeBytes: request.sizeBytes,
        format: "qcow2",
        descendantCount: countOrdinaryDescendants(descendants),
      };
    });
  }

  async removeVolume(request: HostRemoveVolumeRequest, options?: OperationOptions): Promise<void> {
    await this.withOperation("removeVolume", undefined, options, async () => {
      const project = assertProjectId(request.project);
      const paths = volumePaths(project, request.volume, this.volumeDataRoot);
      if (!(await pathExists(paths.basePath))) {
        throw SboxError.notFound(`Volume ${project}/${request.volume} was not found.`, {
          details: { project, volume: request.volume, basePath: paths.basePath },
        });
      }
      await requireQemuImg(this.qemuImg, options?.signal);
      await withVolumeLock(
        paths.lockSocketPath,
        async () => {
          await recoverCrashedMaintenance({
            runtime: this.runtime,
            project,
            volume: request.volume,
            expectedNativeName: maintenanceNativeName(project, request.volume),
          });
          const info = await this.safeBaseInfo(paths.basePath, options?.signal);
          if (info === undefined) {
            throw SboxError.ownershipConflict("Managed volume base is not a valid qcow2 image.", {
              details: { basePath: paths.basePath },
            });
          }
          const records = await this.runtime.list();
          const descendants = await listVolumeDescendants({
            project,
            volume: request.volume,
            sizeBytes: info.virtualSize,
            records,
            dataRoot: this.volumeDataRoot,
            ...(this.qemuImg !== undefined ? { qemuImg: this.qemuImg } : {}),
            ...(options?.signal !== undefined ? { signal: options.signal } : {}),
            validateChildren: false,
          });
          assertNoOrdinaryDescendants(request.volume, descendants);
          await rm(paths.basePath, { force: true });
          await rm(paths.childrenRoot, { recursive: true, force: true }).catch(() => undefined);
        },
        options?.signal !== undefined ? { signal: options.signal } : {},
      );
    });
  }

  async volumeShell(
    request: HostVolumeShellRequest,
    options?: OperationOptions,
  ): Promise<SandboxInspection> {
    const identity = maintenanceIdentity(
      assertProjectId(request.project),
      assertProfileId(request.profile),
      request.volume,
    );
    return this.withOperation("volumeShell", identity, options, async () => {
      this.validateCreateRequest({
        identity,
        image: request.image,
        ...(request.cpus !== undefined ? { cpus: request.cpus } : {}),
        ...(request.memoryMiB !== undefined ? { memoryMiB: request.memoryMiB } : {}),
        ...(request.workdir !== undefined ? { workdir: request.workdir } : {}),
        ...(request.user !== undefined ? { user: request.user } : {}),
        ...(request.shell !== undefined ? { shell: request.shell } : {}),
        ...(request.hostname !== undefined ? { hostname: request.hostname } : {}),
        ...(request.env !== undefined ? { env: request.env } : {}),
        ...(request.maxDurationSecs !== undefined
          ? { maxDurationSecs: request.maxDurationSecs }
          : {}),
        ...(request.idleTimeoutSecs !== undefined
          ? { idleTimeoutSecs: request.idleTimeoutSecs }
          : {}),
        volumes: [{ volume: request.volume, path: request.path, sizeBytes: request.sizeBytes }],
      });

      const projected = projectCreateRequest({
        image: request.image,
        ...(request.cpus !== undefined ? { cpus: request.cpus } : {}),
        ...(request.memoryMiB !== undefined ? { memoryMiB: request.memoryMiB } : {}),
        ...(request.workdir !== undefined ? { workdir: request.workdir } : {}),
        ...(request.user !== undefined ? { user: request.user } : {}),
        ...(request.shell !== undefined ? { shell: request.shell } : {}),
        ...(request.hostname !== undefined ? { hostname: request.hostname } : {}),
        ...(request.env !== undefined ? { env: request.env } : {}),
        ...(request.maxDurationSecs !== undefined
          ? { maxDurationSecs: request.maxDurationSecs }
          : {}),
        ...(request.idleTimeoutSecs !== undefined
          ? { idleTimeoutSecs: request.idleTimeoutSecs }
          : {}),
        volumes: [{ volume: request.volume, path: request.path, sizeBytes: request.sizeBytes }],
      });
      const labels = buildMaintenanceOwnershipLabels(identity, projected, request.volume);
      const nativeName = nativeSandboxName(identity.project, identity.instance);
      const paths = volumePaths(identity.project, request.volume, this.volumeDataRoot);
      const ports = this.formatPorts(options?.signal);

      await withVolumeLock(
        paths.lockSocketPath,
        async () => {
          await recoverCrashedMaintenance({
            runtime: this.runtime,
            project: identity.project,
            volume: request.volume,
            expectedNativeName: nativeName,
          });
          await ensureVolumeBaseLocked(
            {
              project: identity.project,
              volume: request.volume,
              sizeBytes: request.sizeBytes,
              dataRoot: this.volumeDataRoot,
              ...(options?.signal !== undefined ? { signal: options.signal } : {}),
            },
            ports,
            paths,
          );
          const records = await this.runtime.list();
          const descendants = await listVolumeDescendants({
            project: identity.project,
            volume: request.volume,
            sizeBytes: request.sizeBytes,
            records,
            dataRoot: this.volumeDataRoot,
            ...(this.qemuImg !== undefined ? { qemuImg: this.qemuImg } : {}),
            ...(options?.signal !== undefined ? { signal: options.signal } : {}),
            validateChildren: false,
          });
          assertNoOrdinaryDescendants(request.volume, descendants);

          const preexisting = await this.tryGet(nativeName);
          if (preexisting !== undefined) {
            throw SboxError.busy(
              "Volume maintenance sandbox identity is still present after recovery.",
              { details: { nativeName } },
            );
          }

          const live = await this.runtime.create({
            name: nativeName,
            image: projected.image,
            labels,
            detached: true,
            cpus: projected.cpus,
            memoryMiB: projected.memoryMiB,
            workdir: projected.workdir,
            user: projected.user,
            shell: projected.shell,
            hostname: projected.hostname,
            maxDurationSecs: projected.maxDurationSecs,
            idleTimeoutSecs: projected.idleTimeoutSecs,
            env: projected.env,
            network: projected.network,
            secrets: [],
            mounts: [
              {
                guestPath: request.path,
                hostPath: paths.basePath,
                format: "qcow2",
                fstype: "ext4",
              },
            ],
          });
          this.liveByName.set(nativeName, live);
          await this.consumeLive(nativeName);
        },
        options?.signal !== undefined ? { signal: options.signal } : {},
      );

      return this.inspectOwned(identity, nativeName as NativeSandboxName);
    });
  }

  async ensureImage(
    request: HostEnsureImageRequest,
    options?: HostEnsureImageOptions,
  ): Promise<HostImageInspection> {
    return this.withOperation("ensureImage", undefined, options, async () =>
      ensureImage(
        {
          ...request,
          // Host machine decides Docker platform; ignore Client-supplied value.
          platform: hostDockerPlatform(),
        },
        options ?? {},
      ),
    );
  }

  async listImages(options?: HostListImagesOptions): Promise<readonly HostImageSummary[]> {
    return this.withOperation("listImages", undefined, options, async () => {
      const all = await nativeImageList();
      const summaries: HostImageSummary[] = [];
      for (const evidence of all) {
        const summary = toHostImageSummary(evidence);
        if (summary !== null) {
          summaries.push(summary);
          continue;
        }
        if (options?.includeUnowned === true && parseNativeImageReference(evidence.reference)) {
          summaries.push({
            reference: evidence.reference,
            contentIdentity: formatImageContentDigest(
              parseNativeImageReference(evidence.reference)!.digestHex,
            ),
            algorithmVersion: IMAGE_IDENTITY_ALGORITHM_VERSION,
            owned: false,
          });
        }
      }
      return summaries;
    });
  }

  async removeImage(reference: string, options?: HostRemoveImageOptions): Promise<void> {
    return this.withOperation("removeImage", undefined, options, async () => {
      const parsed = parseNativeImageReference(reference);
      if (parsed === undefined) {
        throw SboxError.validation(
          "Image removal requires an exact generated sbox image reference.",
          {
            details: { path: "reference" },
          },
        );
      }
      const evidence = await nativeImageGet(reference);
      if (evidence === null) {
        throw SboxError.notFound("Native image was not found.", { details: { reference } });
      }
      const ownership = inspectImageOwnershipEvidence(
        evidence.labels,
        evidence.env,
        parsed.digestHex,
      );
      if (!ownership.ok) {
        throw SboxError.ownershipConflict(
          "Refusing to remove an image that is not an owned sbox generated image.",
          { details: { reference, reason: ownership.reason } },
        );
      }
      await nativeImageRemove(reference, options?.force === true);
    });
  }

  async listStaleImageWorkspaces(
    options?: HostListStaleImageWorkspacesOptions,
  ): Promise<readonly StaleImageWorkspace[]> {
    return this.withOperation("listStaleImageWorkspaces", undefined, options, async () =>
      listStaleImageWorkspaces(options?.workspaceRoot),
    );
  }

  async execArgv(
    request: HostExecArgvRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    return this.withOperation("execArgv", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      return execArgvCollected(nativeName, request.argv, options);
    });
  }

  async execArgvStream(
    request: HostExecArgvRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    return this.withOperation("execArgvStream", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      return execArgvStream(nativeName, request.argv, options);
    });
  }

  async execShell(
    request: HostExecShellRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    return this.withOperation("execShell", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      return execShellCollected(nativeName, request.script, {
        ...options,
        ...(request.shell !== undefined ? { shell: request.shell } : {}),
      });
    });
  }

  async execShellStream(
    request: HostExecShellRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    return this.withOperation("execShellStream", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      return execShellStream(nativeName, request.script, {
        ...options,
        ...(request.shell !== undefined ? { shell: request.shell } : {}),
      });
    });
  }

  async pty(request: HostPtyRequest, options?: HostPtyOptions): Promise<PtySession> {
    return this.withOperation("pty", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      return startAgentPty({
        nativeName,
        argv: request.argv,
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.user !== undefined ? { user: options.user } : {}),
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.rows !== undefined ? { rows: options.rows } : {}),
        ...(options?.cols !== undefined ? { cols: options.cols } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.input !== undefined ? { input: options.input } : {}),
      });
    });
  }

  async attachTerminal(
    request: HostPtyRequest,
    options?: HostTerminalAttachOptions,
  ): Promise<number> {
    return this.withOperation("attachTerminal", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      const [command, ...args] = request.argv;
      if (command === undefined || command.length === 0) {
        throw SboxError.validation("Terminal attach argv must not be empty.");
      }
      const handle = await Sandbox.get(nativeName);
      const sandbox = await handle.connect();
      try {
        return await sandbox.attachWith(command, (builder) => {
          builder.args(args);
          if (options?.cwd !== undefined) {
            builder.cwd(options.cwd);
          }
          if (options?.user !== undefined) {
            builder.user(options.user);
          }
          if (options?.env !== undefined) {
            builder.envs({ ...options.env });
          }
          return builder;
        });
      } finally {
        await sandbox[Symbol.asyncDispose]();
      }
    });
  }

  async copyHostToGuest(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    return this.withOperation("copyHostToGuest", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      await copyHostToGuest(nativeName, request.hostPath, request.guestPath, options);
    });
  }

  async copyGuestToHost(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    return this.withOperation("copyGuestToHost", request.identity, options, async () => {
      const nativeName = await this.requireRunningNativeName(request.identity, options?.signal);
      await copyGuestToHost(nativeName, request.guestPath, request.hostPath, options);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const names = [...this.liveByName.keys()];
    for (const name of names) {
      try {
        await this.consumeLive(name);
      } catch {
        // Retain the live handle for a later dispose retry. Never stop/remove.
      }
    }
    this.disposed = true;
  }

  private async stopExact(nativeName: string): Promise<NativeSandboxRecord> {
    const live = this.liveByName.get(nativeName);
    if (live !== undefined) {
      try {
        await live.stop();
      } catch (stopError) {
        try {
          await live.detach();
          this.liveByName.delete(nativeName);
        } catch {
          // Keep the handle when detach also fails so disposal can retry.
        }
        throw wrapUnknownFailure(stopError, "Sandbox stop failed.");
      }

      try {
        await live.detach();
        this.liveByName.delete(nativeName);
      } catch (detachError) {
        throw SboxError.internal("Sandbox stopped but local live-handle detach failed.", {
          cause: detachError,
          details: { nativeName, cleanup: "detach_failed" },
        });
      }

      return await this.runtime.get(nativeName);
    }

    return await this.runtime.stopLiveThenFreshGet(nativeName);
  }

  /**
   * Detach/consume a live handle without changing sandbox lifecycle.
   * The map entry is removed only after detach succeeds so failures remain retryable.
   */
  private async consumeLive(nativeName: string): Promise<void> {
    const live = this.liveByName.get(nativeName);
    if (live === undefined) {
      return;
    }
    await live.detach();
    this.liveByName.delete(nativeName);
  }

  private async reinspectUncertainCreate(
    identity: SandboxIdentity,
    nativeName: NativeSandboxName,
    projected: ImmutableCreationProjection,
    error: unknown,
  ): Promise<SandboxInspection> {
    if (isSboxError(error) && error.code === "already_exists") {
      const existing = await this.tryGet(nativeName);
      if (existing === undefined) {
        throw error;
      }
      throw this.conflictOrAlreadyExists(identity, nativeName, existing, projected);
    }

    const existing = await this.tryGet(nativeName);
    if (existing === undefined) {
      throw wrapUnknownFailure(error, "Sandbox create failed.");
    }

    const ownership = matchOwnedCreation(
      this.creationEvidence(identity, existing),
      identity,
      projected,
    );
    if (!ownership.ok) {
      throw SboxError.ownershipConflict(
        `Native sandbox ${nativeName} exists but does not match sbox ownership or configuration.`,
        {
          details: {
            nativeName,
            reason: ownership.reason,
          },
          cause: error,
        },
      );
    }

    // Matching owned resource: return it only after local live cleanup succeeds (or is absent).
    try {
      await this.consumeLive(nativeName);
    } catch (detachError) {
      throw SboxError.internal(
        "Matching sandbox exists after uncertain create, but local live-handle detach failed.",
        {
          cause: detachError,
          details: { nativeName, cleanup: "detach_failed" },
        },
      );
    }
    return this.toInspection(identity, existing);
  }

  private conflictOrAlreadyExists(
    identity: SandboxIdentity,
    nativeName: NativeSandboxName,
    existing: NativeSandboxRecord,
    projected: ImmutableCreationProjection,
  ): SboxError {
    const ownership = matchOwnedCreation(
      this.creationEvidence(identity, existing),
      identity,
      projected,
    );
    if (ownership.ok) {
      return SboxError.alreadyExists(
        `Sandbox ${identity.project}/${identity.instance} already exists.`,
        {
          details: {
            project: identity.project,
            instance: identity.instance,
            nativeName,
          },
        },
      );
    }
    return SboxError.ownershipConflict(
      `Native sandbox ${nativeName} exists but does not match sbox ownership or configuration.`,
      {
        details: {
          nativeName,
          reason: ownership.reason,
        },
      },
    );
  }

  private async inspectOwned(
    identity: SandboxIdentity,
    nativeName: NativeSandboxName,
  ): Promise<SandboxInspection> {
    const record = await this.requireOwned(identity, nativeName);
    return this.toInspection(identity, record);
  }

  private async requireRunningNativeName(
    identity: SandboxIdentity,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const normalized = assertSandboxIdentity(identity);
    const nativeName = nativeSandboxName(normalized.project, normalized.instance);
    const record = await this.requireOwned(normalized, nativeName);
    if (record.status !== "running") {
      throw SboxError.nativeState("Sandbox must be running for process or transfer operations.", {
        details: { state: record.status, nativeName },
      });
    }
    return nativeName;
  }

  private async requireOwned(
    identity: SandboxIdentity,
    nativeName: NativeSandboxName,
  ): Promise<NativeSandboxRecord> {
    const record = await this.tryGet(nativeName);
    if (record === undefined) {
      throw SboxError.notFound(`Sandbox ${identity.project}/${identity.instance} was not found.`, {
        details: {
          project: identity.project,
          instance: identity.instance,
          nativeName,
        },
      });
    }
    this.assertOwnedMatch(identity, nativeName, record);
    return record;
  }

  private assertOwnedMatch(
    identity: SandboxIdentity,
    nativeName: NativeSandboxName,
    record: NativeSandboxRecord,
  ): void {
    const ownership = inspectOwnershipLabels(record.labels);
    if (!ownership.ok) {
      throw SboxError.ownershipConflict(`Native sandbox ${nativeName} failed ownership checks.`, {
        details: { nativeName, reason: ownership.reason },
      });
    }
    if (
      ownership.identity.project !== identity.project ||
      ownership.identity.instance !== identity.instance ||
      ownership.identity.profile !== identity.profile
    ) {
      throw SboxError.ownershipConflict(`Native sandbox ${nativeName} failed ownership checks.`, {
        details: { nativeName, reason: "Identity labels do not match." },
      });
    }
  }

  private async tryGet(nativeName: string): Promise<NativeSandboxRecord | undefined> {
    try {
      return await this.runtime.get(nativeName);
    } catch (error) {
      if (isSboxError(error) && error.code === "not_found") {
        return undefined;
      }
      throw wrapUnknownFailure(error);
    }
  }

  private toInspection(identity: SandboxIdentity, record: NativeSandboxRecord): SandboxInspection {
    return {
      identity,
      nativeName: record.name as NativeSandboxName,
      state: mapNativeStatus(record.status),
      creation: this.creationFromRecord(identity, record),
      labels: freezeLabels(record.labels),
      ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
    };
  }

  private creationFromRecord(
    identity: SandboxIdentity,
    record: NativeSandboxRecord,
  ): SandboxCreationSettings {
    return {
      image: record.image,
      cpus: record.cpus,
      memoryMiB: record.memoryMiB,
      ...(record.workdir !== null ? { workdir: record.workdir } : {}),
      ...(record.user !== null ? { user: record.user } : {}),
      ...(record.shell !== null ? { shell: record.shell } : {}),
      ...(record.hostname !== null ? { hostname: record.hostname } : {}),
      ...(record.maxDurationSecs !== null ? { maxDurationSecs: record.maxDurationSecs } : {}),
      ...(record.idleTimeoutSecs !== null ? { idleTimeoutSecs: record.idleTimeoutSecs } : {}),
      network: toSafeNetworkConfig(record.network),
      secrets: [...record.secrets],
      volumes: volumeAttachmentsFromMounts({
        project: identity.project,
        instance: identity.instance,
        mounts: record.mounts,
        labels: record.labels,
        dataRoot: this.volumeDataRoot,
      }),
      mounts: [...mountsFromLabels(record.labels)],
    };
  }

  private async prepareMountBinds(request: HostCreateRequest): Promise<{
    readonly mounts: readonly HostMount[];
    readonly bindMounts: readonly NativeBindMount[];
  }> {
    const entries = request.mounts ?? [];
    if (entries.length === 0) {
      return { mounts: Object.freeze([]), bindMounts: Object.freeze([]) };
    }
    const mounts: HostMount[] = [];
    const bindMounts: NativeBindMount[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const hostPath = expandHomePrefix(entry.bindHostPath ?? entry.path);
      const kind = await assertBindablePath(hostPath, `mounts.${i}.path`);
      if (entry.kind !== undefined && entry.kind !== kind) {
        throw SboxError.validation(
          `Host mount kind mismatch (declared ${entry.kind}, found ${kind}).`,
          { details: { path: `mounts.${i}.kind` } },
        );
      }
      const resolved: HostMount = {
        ...entry,
        kind,
        ...(mountMode(entry) === "copy" ? { mode: "copy" as const } : {}),
      };
      mounts.push(resolved);
      if (mountMode(resolved) === "copy") {
        continue;
      }
      bindMounts.push({
        guestPath: entry.mount,
        hostPath,
        readonly: entry.readonly,
        ...(entry.quotaMiB !== undefined ? { quotaMiB: entry.quotaMiB } : {}),
      });
    }
    return {
      mounts: Object.freeze(mounts),
      bindMounts: Object.freeze(bindMounts),
    };
  }

  /**
   * Materialize copy-mode mounts into the running guest (no virtio devices).
   * Create-time only; content is not refreshed on later start.
   */
  private async applyCopyMounts(
    nativeName: string,
    mounts: readonly HostMount[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (let i = 0; i < mounts.length; i += 1) {
      const entry = mounts[i]!;
      if (mountMode(entry) !== "copy") {
        continue;
      }
      throwIfAborted(signal);
      const hostPath = expandHomePrefix(entry.bindHostPath ?? entry.path);
      await copyHostToGuest(nativeName, hostPath, entry.mount, {
        overwrite: "replace",
        ...(signal !== undefined ? { signal } : {}),
      });
    }
  }

  private async abortPublishedCreate(
    nativeName: string,
    identity: SandboxIdentity,
    diskMounts: readonly NativeDiskMount[],
  ): Promise<void> {
    try {
      await this.consumeLive(nativeName);
    } catch {
      // Best-effort; remove may still succeed.
    }
    try {
      const current = await this.tryGet(nativeName);
      if (current !== undefined) {
        if (current.status === "running" || current.status === "draining") {
          await this.stopExact(nativeName);
        }
        await this.runtime.remove(nativeName);
      }
    } catch {
      // Best-effort cleanup before surfacing the copy failure.
    }
    this.liveByName.delete(nativeName);
    try {
      await this.cleanupManagedOverlays(identity, diskMounts);
    } catch {
      // ignore
    }
    try {
      await removeDirectoryStages(identity);
    } catch {
      // ignore
    }
  }

  private validateCreateRequest(request: HostCreateRequest): void {
    if (request.image.trim().length === 0) {
      throw SboxError.validation("Sandbox image is required.", {
        details: { path: "image", message: "Expected a non-empty image reference." },
      });
    }
    if (request.cpus !== undefined && (!Number.isInteger(request.cpus) || request.cpus < 1)) {
      throw SboxError.validation("Sandbox cpus must be a positive integer.", {
        details: { path: "cpus" },
      });
    }
    if (
      request.memoryMiB !== undefined &&
      (!Number.isInteger(request.memoryMiB) || request.memoryMiB < 1)
    ) {
      throw SboxError.validation("Sandbox memoryMiB must be a positive integer.", {
        details: { path: "memoryMiB" },
      });
    }
    if (
      request.maxDurationSecs !== undefined &&
      request.maxDurationSecs !== null &&
      (!Number.isInteger(request.maxDurationSecs) || request.maxDurationSecs < 1)
    ) {
      throw SboxError.validation("Sandbox maxDurationSecs must be a positive integer.", {
        details: { path: "maxDurationSecs" },
      });
    }
    if (
      request.idleTimeoutSecs !== undefined &&
      request.idleTimeoutSecs !== null &&
      (!Number.isInteger(request.idleTimeoutSecs) || request.idleTimeoutSecs < 1)
    ) {
      throw SboxError.validation("Sandbox idleTimeoutSecs must be a positive integer.", {
        details: { path: "idleTimeoutSecs" },
      });
    }

    const network = request.network ?? defaultNetworkConfig();
    const networkIssues = validateHostNetworkConfig(network);
    const secretIssues = validateResolvedRuntimeSecrets(request.secrets ?? []);
    const issues = [...networkIssues, ...secretIssues];
    if (issues.length > 0) {
      throw SboxError.validation("Sandbox network/secret validation failed.", {
        details: {
          issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
          issueCount: issues.length,
        },
      });
    }
    assertHostMounts(request.mounts, request.volumes);
    // Capability-gated: Microsandbox 0.6.6 accepts host 0 but does not expose the
    // allocated port for inspection, so LocalHost refuses dynamic publication.
    for (let i = 0; i < network.publish.length; i += 1) {
      if (isDynamicHostPort(network.publish[i]!)) {
        throw SboxError.capability("This Host does not support dynamic host port allocation.", {
          details: {
            path: `network.publish.${i}.host`,
            message:
              "Omit host or use 0 only when the Host advertises dynamicHostPorts. Specify an explicit host port between 1 and 65535.",
          },
        });
      }
    }
  }

  private async withOperation<T>(
    operation: string,
    identity: SandboxIdentity | undefined,
    options: OperationOptions | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    this.ensureOpen();
    throwIfAborted(options?.signal);
    const started = Date.now();
    try {
      const result = await run();
      throwIfAborted(options?.signal);
      safeLog(this.logger, {
        level: "info",
        message: `${operation} succeeded`,
        operation,
        durationMs: Date.now() - started,
        resultCode: "ok",
        ...(identity !== undefined
          ? {
              project: identity.project,
              profile: identity.profile,
              instance: identity.instance,
              nativeName: nativeSandboxName(identity.project, identity.instance),
            }
          : {}),
      });
      return result;
    } catch (error) {
      const wrapped = wrapUnknownFailure(error);
      safeLog(this.logger, {
        level: "error",
        message: `${operation} failed`,
        operation,
        durationMs: Date.now() - started,
        resultCode: wrapped.code,
        ...(identity !== undefined
          ? {
              project: identity.project,
              profile: identity.profile,
              instance: identity.instance,
              nativeName: nativeSandboxName(identity.project, identity.instance),
            }
          : {}),
        details: wrapped.toSafeJSON().details,
      });
      throw wrapped;
    }
  }

  private ensureOpen(): void {
    if (this.disposed) {
      throw SboxError.internal("LocalHost has been disposed.");
    }
  }

  private formatPorts(signal?: AbortSignal) {
    return {
      runtime: this.runtime,
      ...(this.qemuImg !== undefined ? { qemuImg: this.qemuImg } : {}),
      execInSandbox: async (request: {
        readonly name: string;
        readonly argv: readonly string[];
        readonly signal?: AbortSignal;
      }) => {
        const result = await execArgvCollected(
          request.name,
          request.argv,
          (request.signal ?? signal) !== undefined ? { signal: (request.signal ?? signal)! } : {},
        );
        return {
          exitCode: result.exitCode,
          stderr: Buffer.from(result.stderr).toString("utf8"),
        };
      },
    };
  }

  private async safeBaseInfo(
    basePath: string,
    signal?: AbortSignal,
  ): Promise<QemuImgInfo | undefined> {
    try {
      return await qemuImgInfo(basePath, this.qemuImg, signal);
    } catch {
      return undefined;
    }
  }

  private async prepareCreateVolumes(
    identity: SandboxIdentity,
    request: HostCreateRequest,
    signal?: AbortSignal,
  ): Promise<{
    readonly mounts: readonly NativeDiskMount[];
    rollback(): Promise<void>;
    releaseLocks(): Promise<void>;
  }> {
    const attachments = [...(request.volumes ?? [])].toSorted((a, b) =>
      a.volume.localeCompare(b.volume),
    );
    if (attachments.length === 0) {
      return {
        mounts: [],
        async rollback() {},
        async releaseLocks() {},
      };
    }

    await requireQemuImg(this.qemuImg, signal);
    const locks: VolumeLockHandle[] = [];
    const createdChildren: { volume: string }[] = [];
    const mounts: NativeDiskMount[] = [];
    const ports = this.formatPorts(signal);

    try {
      for (const attachment of attachments) {
        const paths = volumePaths(identity.project, attachment.volume, this.volumeDataRoot);
        const lock = await acquireVolumeLock(
          paths.lockSocketPath,
          signal !== undefined ? { signal } : {},
        );
        locks.push(lock);
        await recoverCrashedMaintenance({
          runtime: this.runtime,
          project: identity.project,
          volume: attachment.volume,
          expectedNativeName: maintenanceNativeName(identity.project, attachment.volume),
        });
        await ensureVolumeBaseLocked(
          {
            project: identity.project,
            volume: attachment.volume,
            sizeBytes: attachment.sizeBytes,
            dataRoot: this.volumeDataRoot,
            ...(signal !== undefined ? { signal } : {}),
          },
          ports,
          paths,
        );
        const childPath = await ensureChildOverlay({
          project: identity.project,
          volume: attachment.volume,
          instance: identity.instance,
          sizeBytes: attachment.sizeBytes,
          dataRoot: this.volumeDataRoot,
          ...(this.qemuImg !== undefined ? { qemuImg: this.qemuImg } : {}),
          ...(signal !== undefined ? { signal } : {}),
        });
        createdChildren.push({ volume: attachment.volume });
        mounts.push({
          guestPath: attachment.path,
          hostPath: childPath,
          format: "qcow2",
          fstype: "ext4",
        });
      }
    } catch (error) {
      for (const child of createdChildren.toReversed()) {
        await removeChildOverlay(
          identity.project,
          child.volume,
          identity.instance,
          this.volumeDataRoot,
        ).catch(() => undefined);
      }
      for (const lock of locks.toReversed()) {
        await lock.release().catch(() => undefined);
      }
      throw error;
    }

    return {
      mounts,
      rollback: async () => {
        for (const child of createdChildren.toReversed()) {
          await removeChildOverlay(
            identity.project,
            child.volume,
            identity.instance,
            this.volumeDataRoot,
          ).catch(() => undefined);
        }
      },
      releaseLocks: async () => {
        for (const lock of locks.toReversed()) {
          await lock.release().catch(() => undefined);
        }
      },
    };
  }

  private async cleanupManagedOverlays(
    identity: SandboxIdentity,
    mounts: readonly NativeDiskMount[],
  ): Promise<void> {
    // Never delete a managed base. Only exact deterministic child overlay paths.
    const volumes = new Set<string>();
    for (const mount of mounts) {
      const host = mount.hostPath;
      const slash = Math.max(host.lastIndexOf("/"), host.lastIndexOf("\\"));
      const file = slash >= 0 ? host.slice(slash + 1) : host;
      if (!file.endsWith(".qcow2")) {
        continue;
      }
      const volume = file.slice(0, -".qcow2".length);
      if (volume.length === 0) {
        continue;
      }
      if (
        isManagedChildOverlayPath(
          host,
          identity.project,
          volume,
          identity.instance,
          this.volumeDataRoot,
        )
      ) {
        volumes.add(volume);
      }
    }
    for (const volume of volumes) {
      await removeChildOverlay(
        identity.project,
        volume,
        identity.instance,
        this.volumeDataRoot,
      ).catch(() => undefined);
    }
  }

  private creationEvidence(identity: SandboxIdentity, record: NativeSandboxRecord) {
    return {
      ...record,
      volumes: volumeAttachmentsFromMounts({
        project: identity.project,
        instance: identity.instance,
        mounts: record.mounts,
        labels: record.labels,
        dataRoot: this.volumeDataRoot,
      }),
      mounts: [...mountsFromLabels(record.labels)],
      bindMounts: record.bindMounts,
    };
  }
}

function freezeLabels(labels: LabelMap): LabelMap {
  return Object.freeze({ ...labels });
}

function isDefinitiveCreateFailure(error: SboxError): boolean {
  return (
    error.code === "validation" ||
    error.code === "already_exists" ||
    error.code === "capability" ||
    error.code === "ownership_conflict"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
