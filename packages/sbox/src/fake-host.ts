/**
 * In-memory FakeHost for Phase 1 Host contract tests.
 *
 * Models only the lifecycle contract. It is not a repository, workflow engine,
 * repair system, or second lifecycle authority beyond what contract tests need.
 */

import { SboxError, throwIfAborted, wrapUnknownFailure } from "./errors.js";
import type {
  Host,
  HostCopyPaths,
  HostExecArgvRequest,
  HostExecShellRequest,
  HostPtyRequest,
} from "./host.js";
import {
  assertProjectId,
  assertProfileId,
  assertSandboxIdentity,
  nativeSandboxName,
  type NativeSandboxName,
  type ProjectId,
  type SandboxIdentity,
} from "./identity.js";
import { ensureImage, type EnsureImagePorts } from "./image/ensure.js";
import {
  buildImageOwnershipEnv,
  buildImageOwnershipLabels,
  formatImageContentDigest,
  IMAGE_IDENTITY_ALGORITHM_VERSION,
  inspectImageOwnershipEvidence,
  parseNativeImageReference,
} from "./image/naming.js";
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
import { inspectOwnershipLabels } from "./ownership.js";
import { buildOwnershipLabels } from "./ownership-adoption.js";
import { assertHostMounts } from "./directory/validate.js";
import { projectCreateRequest } from "./immutable-creation.js";
import {
  FakeSandboxFilesystem,
  defaultFakeExec,
  fakeCopyGuestToHost,
  fakeCopyHostToGuest,
  fakeExecCollected,
  fakeExecStream,
  fakePty,
} from "./fake-process.js";
import type {
  HostCollectedExecOptions,
  HostPtyOptions,
  HostStreamingExecOptions,
  ProcessSession,
  PtySession,
} from "./process/session.js";
import type { HostCopyOptions } from "./transfer/types.js";
import { hostDockerPlatform } from "./image/platform.js";
import type {
  HostCapabilities,
  HostCreateRequest,
  HostListOptions,
  OperationOptions,
  ProcessResult,
  SandboxCreationSettings,
  SandboxInspection,
  SandboxLifecycleState,
  SandboxSummary,
} from "./types.js";
import { sandboxIdentityKey } from "./types.js";
import {
  DEFAULT_NETWORK_BIND,
  defaultNetworkConfig,
  toSafeNetworkConfig,
  type HostNetworkConfig,
} from "./network/types.js";
import {
  isDynamicHostPort,
  validateHostNetworkConfig,
  validateResolvedRuntimeSecrets,
} from "./network/validate.js";

export interface FakeHostOptions {
  readonly logger?: Logger;
  /** Optional clock for deterministic timestamps in tests. */
  readonly now?: () => Date;
  /** Override advertised Docker platform (defaults to this process arch). */
  readonly dockerPlatform?: string;
}

interface StoredSandbox {
  identity: SandboxIdentity;
  nativeName: NativeSandboxName;
  state: SandboxLifecycleState;
  creation: SandboxCreationSettings;
  env: Readonly<Record<string, string>>;
  maxDurationSecs: number | null;
  idleTimeoutSecs: number | null;
  createdAt: string;
  updatedAt: string;
}

export class FakeHost implements Host {
  private readonly byKey = new Map<string, StoredSandbox>();
  private readonly byNativeName = new Map<string, string>();
  private readonly filesystems = new Map<string, FakeSandboxFilesystem>();
  private readonly images = new Map<
    string,
    {
      readonly labels: Readonly<Record<string, string>>;
      readonly env: readonly string[];
      readonly owned: boolean;
    }
  >();
  private readonly volumes = new Map<
    string,
    { readonly project: ProjectId; readonly volume: string; readonly sizeBytes: number }
  >();
  private readonly logger: Logger;
  private readonly now: () => Date;
  private disposed = false;
  /** Next host port for dynamic publish allocations (host undefined or 0). */
  private nextDynamicHostPort = 40000;
  /** Test helper: Host method names invoked through the public Host contract. */
  readonly operations: string[] = [];
  /** Optional override for fake exec behavior. */
  execHandler = defaultFakeExec;
  /** When false, create rejects omitted/0 host ports with capability. */
  dynamicHostPorts = true;
  private readonly dockerPlatform: string;

  constructor(options: FakeHostOptions = {}) {
    this.logger = createRedactingLogger(options.logger ?? silentLogger);
    this.now = options.now ?? (() => new Date());
    this.dockerPlatform = options.dockerPlatform ?? hostDockerPlatform();
  }

  async create(request: HostCreateRequest, options?: OperationOptions): Promise<SandboxInspection> {
    this.operations.push("create");
    return this.withOperation("create", request.identity, options, async () => {
      const identity = assertSandboxIdentity(request.identity);
      this.validateCreateRequest(request);
      const key = sandboxIdentityKey(identity);
      const nativeName = nativeSandboxName(identity.project, identity.instance);

      const existing = this.byKey.get(key);
      if (existing !== undefined) {
        throw SboxError.alreadyExists(
          `Sandbox ${identity.project}/${identity.instance} already exists.`,
          {
            details: {
              project: identity.project,
              instance: identity.instance,
              nativeName: existing.nativeName,
            },
          },
        );
      }

      const nativeOwner = this.byNativeName.get(nativeName);
      if (nativeOwner !== undefined) {
        throw SboxError.ownershipConflict(
          `Native sandbox name ${nativeName} is already occupied by an unrelated resource.`,
          { details: { nativeName } },
        );
      }

      const timestamp = this.now().toISOString();
      const mounts = (request.mounts ?? []).map((entry) => ({
        ...entry,
        kind: entry.kind ?? ("directory" as const),
      }));
      const projected = projectCreateRequest({ ...request, mounts });
      const network = this.allocateDynamicHostPorts(projected.network);
      const creation = creationFromProjection({ ...projected, network });
      const stored: StoredSandbox = {
        identity,
        nativeName,
        state: "running",
        creation,
        env: projected.env,
        maxDurationSecs: projected.maxDurationSecs,
        idleTimeoutSecs: projected.idleTimeoutSecs,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.byKey.set(key, stored);
      this.byNativeName.set(nativeName, key);
      return this.toInspection(stored);
    });
  }

  async get(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    this.operations.push("get");
    return this.inspect(identity, options);
  }

  async list(options?: HostListOptions): Promise<readonly SandboxSummary[]> {
    this.operations.push("list");
    return this.withOperation("list", undefined, options, async () => {
      const all = [...this.byKey.values()];
      const filtered =
        options?.project === undefined
          ? all
          : all.filter((item) => item.identity.project === options.project);
      return filtered.map((item) => ({
        identity: item.identity,
        nativeName: item.nativeName,
        state: item.state,
        image: item.creation.image,
      }));
    });
  }

  async inspect(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    this.operations.push("inspect");
    return this.withOperation("inspect", identity, options, async () => {
      return this.toInspection(this.require(identity));
    });
  }

  async start(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    this.operations.push("start");
    return this.withOperation("start", identity, options, async () => {
      const stored = this.require(identity);
      if (stored.state === "running") {
        return this.toInspection(stored);
      }
      if (stored.state !== "stopped") {
        throw SboxError.nativeState(`Cannot start sandbox in state ${formatState(stored.state)}.`, {
          details: { state: stored.state },
        });
      }
      stored.state = "running";
      stored.updatedAt = this.now().toISOString();
      return this.toInspection(stored);
    });
  }

  async stop(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    this.operations.push("stop");
    return this.withOperation("stop", identity, options, async () => {
      const stored = this.require(identity);
      if (stored.state === "stopped") {
        return this.toInspection(stored);
      }
      if (stored.state !== "running" && stored.state !== "draining") {
        throw SboxError.nativeState(`Cannot stop sandbox in state ${formatState(stored.state)}.`, {
          details: { state: stored.state },
        });
      }
      stored.state = "stopped";
      stored.updatedAt = this.now().toISOString();
      return this.toInspection(stored);
    });
  }

  async remove(identity: SandboxIdentity, options?: OperationOptions): Promise<void> {
    this.operations.push("remove");
    await this.withOperation("remove", identity, options, async () => {
      const stored = this.require(identity);
      if (stored.state === "running" || stored.state === "draining") {
        stored.state = "stopped";
        stored.updatedAt = this.now().toISOString();
      }
      this.byKey.delete(sandboxIdentityKey(identity));
      this.byNativeName.delete(stored.nativeName);
    });
  }

  async capabilities(options?: OperationOptions): Promise<HostCapabilities> {
    this.operations.push("capabilities");
    return this.withOperation("capabilities", undefined, options, async () => ({
      localMicrosandbox: false,
      dynamicHostPorts: this.dynamicHostPorts,
      qemuImg: true,
      dockerPlatform: this.dockerPlatform,
      notes: ["FakeHost models the Host contract in memory."],
    }));
  }

  async listVolumes(
    request: import("./volume/types.js").HostListVolumesRequest,
    options?: OperationOptions,
  ): Promise<readonly import("./volume/types.js").HostVolumeSummary[]> {
    this.operations.push("listVolumes");
    return this.withOperation("listVolumes", undefined, options, async () => {
      const out: import("./volume/types.js").HostVolumeSummary[] = [];
      for (const [key, stored] of this.volumes) {
        if (stored.project !== request.project) {
          continue;
        }
        out.push({
          project: stored.project,
          volume: stored.volume,
          basePath: `fake://${key}`,
          sizeBytes: stored.sizeBytes,
          descendantCount: this.countVolumeDescendants(stored.project, stored.volume),
        });
      }
      return out.toSorted((a, b) => a.volume.localeCompare(b.volume));
    });
  }

  async ensureVolume(
    request: import("./volume/types.js").HostEnsureVolumeRequest,
    options?: OperationOptions,
  ): Promise<import("./volume/types.js").HostVolumeInspection> {
    this.operations.push("ensureVolume");
    return this.withOperation("ensureVolume", undefined, options, async () => {
      const key = `${request.project}\0${request.volume}`;
      const existing = this.volumes.get(key);
      if (existing !== undefined && existing.sizeBytes !== request.sizeBytes) {
        throw SboxError.ownershipConflict(
          "Managed volume base virtual size does not match the declared size.",
          {
            details: {
              expectedSizeBytes: request.sizeBytes,
              actualSizeBytes: existing.sizeBytes,
            },
          },
        );
      }
      if (existing === undefined) {
        this.volumes.set(key, {
          project: assertProjectId(request.project),
          volume: request.volume,
          sizeBytes: request.sizeBytes,
        });
      }
      return {
        project: assertProjectId(request.project),
        volume: request.volume,
        basePath: `fake://${key}`,
        sizeBytes: request.sizeBytes,
        format: "qcow2",
        descendantCount: this.countVolumeDescendants(request.project, request.volume),
      };
    });
  }

  async removeVolume(
    request: import("./volume/types.js").HostRemoveVolumeRequest,
    options?: OperationOptions,
  ): Promise<void> {
    this.operations.push("removeVolume");
    await this.withOperation("removeVolume", undefined, options, async () => {
      const key = `${request.project}\0${request.volume}`;
      if (!this.volumes.has(key)) {
        throw SboxError.notFound(`Volume ${request.project}/${request.volume} was not found.`);
      }
      const descendants = this.countVolumeDescendants(request.project, request.volume);
      if (descendants > 0) {
        throw SboxError.busy(
          `Volume ${request.volume} has ${descendants} descendant sandbox overlay(s); remove them before maintenance or base removal.`,
        );
      }
      this.volumes.delete(key);
    });
  }

  async volumeShell(
    request: import("./volume/types.js").HostVolumeShellRequest,
    options?: OperationOptions,
  ): Promise<SandboxInspection> {
    this.operations.push("volumeShell");
    const { maintenanceIdentity } = await import("./volume/maintenance.js");
    const identity = maintenanceIdentity(
      assertProjectId(request.project),
      assertProfileId(request.profile),
      request.volume,
    );
    return this.withOperation("volumeShell", identity, options, async () => {
      await this.ensureVolume(
        {
          project: request.project,
          volume: request.volume,
          sizeBytes: request.sizeBytes,
        },
        options,
      );
      const descendants = this.countVolumeDescendants(request.project, request.volume);
      if (descendants > 0) {
        throw SboxError.busy(
          `Volume ${request.volume} has ${descendants} descendant sandbox overlay(s); remove them before maintenance or base removal.`,
        );
      }
      return this.create(
        {
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
        },
        options,
      );
    });
  }

  async ensureImage(
    request: HostEnsureImageRequest,
    options?: HostEnsureImageOptions,
  ): Promise<HostImageInspection> {
    this.operations.push("ensureImage");
    return this.withOperation("ensureImage", undefined, options, async () => {
      const ports: EnsureImagePorts = {
        get: async (reference) => {
          const stored = this.images.get(reference);
          if (stored === undefined) {
            return null;
          }
          return {
            reference,
            labels: stored.labels,
            env: stored.env,
            owned: stored.owned,
            ...(stored.owned
              ? {
                  contentIdentity: stored.labels["dev.sohcah.sbox/image-identity"],
                  algorithmVersion: IMAGE_IDENTITY_ALGORITHM_VERSION,
                }
              : {}),
          };
        },
        load: async () => {
          throw SboxError.internal("FakeHost ensureImage should use fakePublish.");
        },
        remove: async (reference) => {
          this.images.delete(reference);
        },
        fakePublish: async (identity) => {
          const labels = buildImageOwnershipLabels(identity.digestHex);
          const envMap = buildImageOwnershipEnv(identity.digestHex);
          this.images.set(identity.nativeReference, {
            labels,
            env: Object.entries(envMap).map(([key, value]) => `${key}=${value}`),
            owned: true,
          });
        },
      };
      return ensureImage(
        {
          ...request,
          platform: this.dockerPlatform,
        },
        options ?? {},
        ports,
      );
    });
  }

  async listImages(options?: HostListImagesOptions): Promise<readonly HostImageSummary[]> {
    this.operations.push("listImages");
    return this.withOperation("listImages", undefined, options, async () => {
      const out: HostImageSummary[] = [];
      for (const [reference, stored] of this.images) {
        const parsed = parseNativeImageReference(reference);
        if (parsed === undefined) {
          continue;
        }
        if (!stored.owned && options?.includeUnowned !== true) {
          continue;
        }
        out.push({
          reference,
          contentIdentity: formatImageContentDigest(parsed.digestHex),
          algorithmVersion: IMAGE_IDENTITY_ALGORITHM_VERSION,
          owned: stored.owned,
        });
      }
      return out;
    });
  }

  async removeImage(reference: string, options?: HostRemoveImageOptions): Promise<void> {
    this.operations.push("removeImage");
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
      const stored = this.images.get(reference);
      if (stored === undefined) {
        throw SboxError.notFound("Native image was not found.", { details: { reference } });
      }
      const ownership = inspectImageOwnershipEvidence(stored.labels, stored.env, parsed.digestHex);
      if (!ownership.ok) {
        throw SboxError.ownershipConflict(
          "Refusing to remove an image that is not an owned sbox generated image.",
          { details: { reference, reason: ownership.reason } },
        );
      }
      this.images.delete(reference);
    });
  }

  async listStaleImageWorkspaces(
    options?: HostListStaleImageWorkspacesOptions,
  ): Promise<readonly StaleImageWorkspace[]> {
    this.operations.push("listStaleImageWorkspaces");
    return this.withOperation("listStaleImageWorkspaces", undefined, options, async () =>
      listStaleImageWorkspaces(options?.workspaceRoot),
    );
  }

  /** Test helper: plant a conflicting unowned image at a generated reference. */
  plantConflictingImage(
    reference: string,
    labels: Readonly<Record<string, string>> = {},
    env: readonly string[] = [],
  ): void {
    this.images.set(reference, { labels, env, owned: false });
  }

  async execArgv(
    request: HostExecArgvRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    this.operations.push("execArgv");
    return this.withOperation("execArgv", request.identity, options, async () => {
      this.requireRunning(request.identity);
      return fakeExecCollected(request.argv, options ?? {}, { run: this.execHandler });
    });
  }

  async execArgvStream(
    request: HostExecArgvRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    this.operations.push("execArgvStream");
    return this.withOperation("execArgvStream", request.identity, options, async () => {
      this.requireRunning(request.identity);
      return fakeExecStream(request.argv, options ?? {}, { run: this.execHandler });
    });
  }

  async execShell(
    request: HostExecShellRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    this.operations.push("execShell");
    return this.withOperation("execShell", request.identity, options, async () => {
      this.requireRunning(request.identity);
      const shell = request.shell ?? "/bin/sh";
      return fakeExecCollected([shell, "-c", request.script], options ?? {}, {
        run: this.execHandler,
      });
    });
  }

  async execShellStream(
    request: HostExecShellRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    this.operations.push("execShellStream");
    return this.withOperation("execShellStream", request.identity, options, async () => {
      this.requireRunning(request.identity);
      const shell = request.shell ?? "/bin/sh";
      return fakeExecStream([shell, "-c", request.script], options ?? {}, {
        run: this.execHandler,
      });
    });
  }

  async pty(request: HostPtyRequest, options?: HostPtyOptions): Promise<PtySession> {
    this.operations.push("pty");
    return this.withOperation("pty", request.identity, options, async () => {
      this.requireRunning(request.identity);
      return fakePty(request.argv, options ?? {});
    });
  }

  async copyHostToGuest(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    this.operations.push("copyHostToGuest");
    return this.withOperation("copyHostToGuest", request.identity, options, async () => {
      const stored = this.requireRunning(request.identity);
      const fs = this.fsFor(stored.nativeName);
      await fakeCopyHostToGuest(fs, request.hostPath, request.guestPath, options);
    });
  }

  async copyGuestToHost(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    this.operations.push("copyGuestToHost");
    return this.withOperation("copyGuestToHost", request.identity, options, async () => {
      const stored = this.requireRunning(request.identity);
      const fs = this.fsFor(stored.nativeName);
      await fakeCopyGuestToHost(fs, request.guestPath, request.hostPath, options);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }

  /** Test helper: access the in-memory guest filesystem for a sandbox. */
  filesystemFor(identity: SandboxIdentity): FakeSandboxFilesystem {
    const stored = this.require(identity);
    return this.fsFor(stored.nativeName);
  }

  /** Test helper: seed or replace stored state without going through create. */
  seed(input: {
    readonly identity: SandboxIdentity;
    readonly state?: SandboxLifecycleState;
    readonly creation?: Omit<SandboxCreationSettings, "network" | "secrets"> & {
      readonly network?: SandboxCreationSettings["network"];
      readonly secrets?: SandboxCreationSettings["secrets"];
    };
    readonly nativeName?: NativeSandboxName;
  }): SandboxInspection {
    const identity = assertSandboxIdentity(input.identity);
    const key = sandboxIdentityKey(identity);
    const nativeName = input.nativeName ?? nativeSandboxName(identity.project, identity.instance);
    const timestamp = this.now().toISOString();
    const creation = {
      image: input.creation?.image ?? "alpine:3.20",
      cpus: input.creation?.cpus ?? 1,
      memoryMiB: input.creation?.memoryMiB ?? 512,
      ...(input.creation?.tmpMiB !== undefined ? { tmpMiB: input.creation.tmpMiB } : {}),
      ...(input.creation?.workdir !== undefined ? { workdir: input.creation.workdir } : {}),
      ...(input.creation?.user !== undefined ? { user: input.creation.user } : {}),
      ...(input.creation?.shell !== undefined ? { shell: input.creation.shell } : {}),
      ...(input.creation?.hostname !== undefined ? { hostname: input.creation.hostname } : {}),
      ...(input.creation?.maxDurationSecs !== undefined
        ? { maxDurationSecs: input.creation.maxDurationSecs }
        : {}),
      ...(input.creation?.idleTimeoutSecs !== undefined
        ? { idleTimeoutSecs: input.creation.idleTimeoutSecs }
        : {}),
      network: input.creation?.network ?? toSafeNetworkConfig(defaultNetworkConfig()),
      secrets: input.creation?.secrets ?? [],
    };
    const projected = projectCreateRequest({
      image: creation.image,
      cpus: creation.cpus,
      memoryMiB: creation.memoryMiB,
      ...(creation.tmpMiB !== undefined ? { tmpMiB: creation.tmpMiB } : {}),
      ...(creation.workdir !== undefined ? { workdir: creation.workdir } : {}),
      ...(creation.user !== undefined ? { user: creation.user } : {}),
      ...(creation.shell !== undefined ? { shell: creation.shell } : {}),
      ...(creation.hostname !== undefined ? { hostname: creation.hostname } : {}),
      ...(creation.maxDurationSecs !== undefined
        ? { maxDurationSecs: creation.maxDurationSecs }
        : {}),
      ...(creation.idleTimeoutSecs !== undefined
        ? { idleTimeoutSecs: creation.idleTimeoutSecs }
        : {}),
      network: {
        mode: creation.network.mode,
        allow: creation.network.allow,
        publish: creation.network.publish,
      },
      secrets: creation.secrets.map((secret) => ({
        env: secret.env,
        placeholder: secret.placeholder,
        destinations: secret.destinations,
        value: "",
      })),
    });
    const stored: StoredSandbox = {
      identity,
      nativeName,
      state: input.state ?? "stopped",
      creation: creationFromProjection(projected),
      env: {},
      maxDurationSecs: projected.maxDurationSecs,
      idleTimeoutSecs: projected.idleTimeoutSecs,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.byKey.set(key, stored);
    this.byNativeName.set(nativeName, key);
    return this.toInspection(stored);
  }

  /** Test helper: place a conflicting native resource that fails ownership checks. */
  seedForeignNative(nativeName: NativeSandboxName, image = "foreign:latest"): void {
    const key = `foreign:${nativeName}`;
    const timestamp = this.now().toISOString();
    const identity = assertSandboxIdentity({
      project: "foreign-project",
      profile: "foreign-profile",
      instance: "foreign-instance",
    });
    // Intentionally do not index under the caller's identity key.
    this.byNativeName.set(nativeName, key);
    this.byKey.set(key, {
      identity,
      nativeName,
      state: "stopped",
      creation: {
        image,
        cpus: 1,
        memoryMiB: 512,
        network: toSafeNetworkConfig(defaultNetworkConfig()),
        secrets: [],
        volumes: [],
        mounts: [],
      },
      env: {},
      maxDurationSecs: null,
      idleTimeoutSecs: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  private require(identity: SandboxIdentity): StoredSandbox {
    const normalized = assertSandboxIdentity(identity);
    const stored = this.byKey.get(sandboxIdentityKey(normalized));
    if (stored === undefined) {
      throw SboxError.notFound(
        `Sandbox ${normalized.project}/${normalized.instance} was not found.`,
        {
          details: {
            project: normalized.project,
            instance: normalized.instance,
            nativeName: nativeSandboxName(normalized.project, normalized.instance),
          },
        },
      );
    }
    const ownership = inspectOwnershipLabels(this.toInspection(stored).labels);
    if (
      !ownership.ok ||
      ownership.identity.project !== normalized.project ||
      ownership.identity.instance !== normalized.instance ||
      ownership.identity.profile !== normalized.profile
    ) {
      throw SboxError.ownershipConflict(
        `Sandbox ${normalized.project}/${normalized.instance} failed ownership checks.`,
        { details: { reason: ownership.ok ? "Identity labels do not match." : ownership.reason } },
      );
    }
    return stored;
  }

  private requireRunning(identity: SandboxIdentity): StoredSandbox {
    const stored = this.require(identity);
    if (stored.state !== "running") {
      throw SboxError.nativeState("Sandbox must be running for process or transfer operations.", {
        details: { state: stored.state, nativeName: stored.nativeName },
      });
    }
    return stored;
  }

  private fsFor(nativeName: string): FakeSandboxFilesystem {
    let fs = this.filesystems.get(nativeName);
    if (fs === undefined) {
      fs = new FakeSandboxFilesystem();
      this.filesystems.set(nativeName, fs);
    }
    return fs;
  }

  private toInspection(stored: StoredSandbox): SandboxInspection {
    const projected = projectCreateRequest({
      image: stored.creation.image,
      cpus: stored.creation.cpus,
      memoryMiB: stored.creation.memoryMiB,
      ...(stored.creation.workdir !== undefined ? { workdir: stored.creation.workdir } : {}),
      ...(stored.creation.user !== undefined ? { user: stored.creation.user } : {}),
      ...(stored.creation.shell !== undefined ? { shell: stored.creation.shell } : {}),
      ...(stored.creation.hostname !== undefined ? { hostname: stored.creation.hostname } : {}),
      maxDurationSecs: stored.maxDurationSecs,
      idleTimeoutSecs: stored.idleTimeoutSecs,
      env: stored.env,
      network: {
        mode: stored.creation.network.mode,
        allow: stored.creation.network.allow,
        publish: stored.creation.network.publish,
      },
      secrets: stored.creation.secrets.map((secret) => ({
        env: secret.env,
        placeholder: secret.placeholder,
        destinations: secret.destinations,
        value: "",
      })),
      volumes: stored.creation.volumes,
      mounts: stored.creation.mounts,
    });
    return {
      identity: stored.identity,
      nativeName: stored.nativeName,
      state: stored.state,
      creation: {
        ...stored.creation,
        network: stored.creation.network,
        secrets: [...stored.creation.secrets],
      },
      labels: buildOwnershipLabels(stored.identity, projected),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
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
    if (request.tmpMiB !== undefined && (!Number.isInteger(request.tmpMiB) || request.tmpMiB < 1)) {
      throw SboxError.validation("Sandbox tmpMiB must be a positive integer.", {
        details: { path: "tmpMiB" },
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

    // Capability-gated dynamic host ports (toggleable for unit tests).
    this.assertDynamicHostPortsSupported(network, this.dynamicHostPorts);
  }

  private assertDynamicHostPortsSupported(
    network: HostNetworkConfig,
    dynamicHostPorts: boolean,
  ): void {
    if (dynamicHostPorts) {
      return;
    }
    for (let i = 0; i < network.publish.length; i += 1) {
      if (isDynamicHostPort(network.publish[i]!)) {
        throw SboxError.capability("This Host does not support dynamic host port allocation.", {
          details: {
            path: `network.publish.${i}.host`,
            message: "Omit host or use 0 only when the Host advertises dynamicHostPorts.",
          },
        });
      }
    }
  }

  private allocateDynamicHostPorts(network: HostNetworkConfig): HostNetworkConfig {
    return Object.freeze({
      mode: network.mode,
      allow: Object.freeze([...network.allow]),
      publish: Object.freeze(
        network.publish.map((port) => {
          if (!isDynamicHostPort(port)) {
            return Object.freeze({
              guest: port.guest,
              host: port.host!,
              ...(port.protocol !== undefined ? { protocol: port.protocol } : {}),
              ...(port.bind !== undefined ? { bind: port.bind } : {}),
            });
          }
          const host = this.nextDynamicHostPort;
          this.nextDynamicHostPort += 1;
          return Object.freeze({
            guest: port.guest,
            host,
            ...(port.protocol !== undefined ? { protocol: port.protocol } : {}),
            ...(port.bind !== undefined ? { bind: port.bind } : {}),
          });
        }),
      ),
    });
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
            }
          : {}),
        details: wrapped.toSafeJSON().details,
      });
      throw wrapped;
    }
  }

  private ensureOpen(): void {
    if (this.disposed) {
      throw SboxError.internal("FakeHost has been disposed.");
    }
  }

  private countVolumeDescendants(project: string, volume: string): number {
    let count = 0;
    for (const stored of this.byKey.values()) {
      if (stored.identity.project !== project) {
        continue;
      }
      if (stored.identity.instance.startsWith("vmaint-")) {
        continue;
      }
      if (stored.creation.volumes.some((attachment) => attachment.volume === volume)) {
        count += 1;
      }
    }
    return count;
  }
}

function creationFromProjection(
  projected: ReturnType<typeof projectCreateRequest>,
): SandboxCreationSettings {
  return {
    image: projected.image,
    cpus: projected.cpus,
    memoryMiB: projected.memoryMiB,
    ...(projected.tmpMiB !== null ? { tmpMiB: projected.tmpMiB } : {}),
    ...(projected.workdir !== null ? { workdir: projected.workdir } : {}),
    ...(projected.user !== null ? { user: projected.user } : {}),
    ...(projected.shell !== null ? { shell: projected.shell } : {}),
    ...(projected.hostname !== null ? { hostname: projected.hostname } : {}),
    ...(projected.maxDurationSecs !== null ? { maxDurationSecs: projected.maxDurationSecs } : {}),
    ...(projected.idleTimeoutSecs !== null ? { idleTimeoutSecs: projected.idleTimeoutSecs } : {}),
    network: toSafeNetworkConfig(
      projected.network,
      projected.network.publish.map((port) => ({
        guest: port.guest,
        host: port.host ?? 0,
        protocol: port.protocol ?? "tcp",
        bind: port.bind ?? DEFAULT_NETWORK_BIND,
      })),
    ),
    secrets: [...projected.secrets],
    volumes: [...projected.volumes],
    mounts: [...projected.mounts],
  };
}

function formatState(state: SandboxLifecycleState): string {
  return typeof state === "string" ? state : `unknown(${state.native})`;
}
