/**
 * SboxClient: configuration-aware workflow over a Host.
 *
 * Resolves project intent and invokes Host. Does not load YAML itself when
 * constructed from typed config; the YAML factory is a convenience adapter.
 *
 * Every lifecycle operation resolves the selected target first. Until Phase 7,
 * a remote target fails with capability before any local Host call.
 */

import { isSboxError, SboxError, throwIfAborted, wrapUnknownFailure } from "../errors.js";
import type { Host } from "../host.js";
import { disposeHost } from "../host.js";
import { assertProjectId, assertSandboxIdentity, type SandboxIdentity } from "../identity.js";
import type { HostImageInspection, ImageBuildProgressEvent } from "../image/types.js";
import { createLocalHost } from "../local-host.js";
import { createRedactingLogger, safeLog, silentLogger, type Logger } from "../logging.js";
import type {
  HostListOptions,
  OperationOptions,
  SandboxInspection,
  SandboxSummary,
} from "../types.js";
import type { ProjectConfig, UserConfig } from "../config/types.js";
import { isBuildProfile } from "../config/types.js";
import { parseProjectConfig, parseUserConfig } from "../config/validate.js";
import { requireLocalTarget, type ResolvedLocalTarget } from "../config/targets.js";
import type { ExternalResolutionContext } from "../config/external.js";
import { parseBinarySizeToBytes } from "../config/scalars.js";
import { resolveInstanceId, selectProfile } from "../config/profile.js";
import type { SandboxHandle } from "./handle.js";
import { HostSandboxHandle } from "./handle-impl.js";
import { computeGeneratedImageIdentity } from "../image/compute.js";
import {
  reportCreationDrift,
  resolveCreateIntent,
  resolveEnsureImageRequest,
  resolveImageIdentityInputs,
} from "./resolve-intent.js";
import type { RawNetworkAllowRule } from "../network/normalize.js";
import type { NetworkAllowRule, PublishedPortSpec, RuntimeSecretConfig } from "../network/types.js";

export interface SboxClientOptions {
  readonly project: ProjectConfig;
  readonly user?: UserConfig;
  readonly host?: Host;
  readonly logger?: Logger;
  readonly configDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly invocation?: Readonly<Record<string, string>>;
  /** Owns and disposes the host when true (default when host is created internally). */
  readonly ownsHost?: boolean;
}

/** Options accepted by every client operation that may select a target. */
export interface ClientOperationOptions extends OperationOptions {
  readonly target?: string;
}

export interface ProfileOperationOptions extends ClientOperationOptions {
  readonly profile?: string;
  readonly instance?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly invocation?: Readonly<Record<string, string>>;
  readonly networkAllow?: readonly NetworkAllowRule[] | readonly RawNetworkAllowRule[];
  readonly networkPublish?: readonly PublishedPortSpec[];
  readonly secrets?: readonly RuntimeSecretConfig[];
}

export interface ClientBuildOptions extends ProfileOperationOptions {
  readonly force?: boolean;
  readonly onProgress?: (event: ImageBuildProgressEvent) => void;
  readonly timeoutMs?: number;
}

export interface ClientListOptions extends HostListOptions {
  readonly target?: string;
}

export interface SboxClient extends AsyncDisposable {
  readonly project: ProjectConfig;
  create(options?: ProfileOperationOptions): Promise<SandboxHandle>;
  /**
   * Strict get. Accepts either a full identity or profile/instance options.
   * Always resolves target selection before Host access.
   */
  get(
    identityOrOptions: SandboxIdentity | ProfileOperationOptions,
    options?: ClientOperationOptions,
  ): Promise<SandboxHandle>;
  list(options?: ClientListOptions): Promise<readonly SandboxSummary[]>;
  up(options?: ProfileOperationOptions): Promise<SandboxHandle>;
  recreate(options?: ProfileOperationOptions): Promise<SandboxHandle>;
  /** Ensure the exact generated image for a Dockerfile-backed profile. */
  build(options?: ClientBuildOptions): Promise<HostImageInspection>;
  listImages(
    options?: ClientOperationOptions & { readonly includeUnowned?: boolean },
  ): Promise<Awaited<ReturnType<Host["listImages"]>>>;
  removeImage(
    reference: string,
    options?: ClientOperationOptions & { readonly force?: boolean },
  ): Promise<void>;
  listStaleImageWorkspaces(
    options?: ClientOperationOptions & { readonly workspaceRoot?: string },
  ): Promise<Awaited<ReturnType<Host["listStaleImageWorkspaces"]>>>;
  inspect(
    identityOrOptions: SandboxIdentity | ProfileOperationOptions,
    options?: ClientOperationOptions,
  ): Promise<SandboxInspection>;
  stop(
    identityOrOptions: SandboxIdentity | ProfileOperationOptions,
    options?: ClientOperationOptions,
  ): Promise<SandboxInspection>;
  remove(
    identityOrOptions: SandboxIdentity | ProfileOperationOptions,
    options?: ClientOperationOptions,
  ): Promise<void>;
  listVolumes(options?: ClientOperationOptions): Promise<Awaited<ReturnType<Host["listVolumes"]>>>;
  ensureVolume(
    volume: string,
    options?: ClientOperationOptions,
  ): Promise<Awaited<ReturnType<Host["ensureVolume"]>>>;
  removeVolume(volume: string, options?: ClientOperationOptions): Promise<void>;
  volumeShell(volume: string, options?: ProfileOperationOptions): Promise<SandboxHandle>;
}

class HostSboxClient implements SboxClient {
  readonly project: ProjectConfig;
  private readonly user: UserConfig;
  private readonly host: Host;
  private readonly logger: Logger;
  private readonly ownsHost: boolean;
  private readonly configDirectory: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly invocation: Readonly<Record<string, string>>;
  private disposed = false;

  constructor(options: SboxClientOptions) {
    this.project = parseProjectConfig(options.project);
    this.user =
      options.user === undefined
        ? parseUserConfig({ version: 1, targets: { local: { kind: "local" } } })
        : parseUserConfig(options.user);
    this.logger = createRedactingLogger(options.logger ?? silentLogger);
    this.configDirectory = options.configDirectory ?? process.cwd();
    this.env = options.env ?? process.env;
    this.invocation = options.invocation ?? {};
    if (options.host !== undefined) {
      this.host = options.host;
      this.ownsHost = options.ownsHost ?? false;
    } else {
      this.host = createLocalHost({ logger: this.logger });
      this.ownsHost = options.ownsHost ?? true;
    }
  }

  async create(options: ProfileOperationOptions = {}): Promise<SandboxHandle> {
    return this.withOperation("create", undefined, options, async () => {
      await this.requireLocal(options);
      const intent = await this.resolveIntent(options);
      const inspection = await this.host.create(intent.request, toHostOptions(options));
      return new HostSandboxHandle(this.host, inspection.identity);
    });
  }

  async get(
    identityOrOptions: SandboxIdentity | ProfileOperationOptions,
    options?: ClientOperationOptions,
  ): Promise<SandboxHandle> {
    const resolved = this.resolveReference(identityOrOptions, options);
    return this.withOperation("get", resolved.identity, resolved.options, async () => {
      await this.requireLocal(resolved.options);
      await this.host.get(resolved.identity, toHostOptions(resolved.options));
      return new HostSandboxHandle(this.host, resolved.identity);
    });
  }

  async list(options?: ClientListOptions): Promise<readonly SandboxSummary[]> {
    return this.withOperation("list", undefined, options, async () => {
      await this.requireLocal(options ?? {});
      return this.host.list(toHostListOptions(options, assertProjectId(this.project.project)));
    });
  }

  /**
   * Narrow convenience workflow:
   * - absent → ensure image (if build-backed), create and start
   * - stopped → start
   * - running → success
   * Does not reconcile immutable creation drift.
   *
   * For build profiles, computes the expected image identity without Docker
   * mutation, looks up the sandbox first, and only ensures/builds when absent.
   */
  async up(options: ProfileOperationOptions = {}): Promise<SandboxHandle> {
    return this.withOperation("up", undefined, options, async () => {
      await this.requireLocal(options);
      const intent = await this.resolveIntentPredictingImage(options);
      const hostOptions = toHostOptions(options);

      let existing: SandboxInspection | undefined;
      try {
        existing = await this.host.get(intent.identity, hostOptions);
      } catch (error) {
        if (!isSboxError(error) || error.code !== "not_found") {
          throw error;
        }
      }

      if (existing === undefined) {
        if (intent.needsImageEnsure) {
          await this.ensureProfileImage(options);
        }
        const created = await this.host.create(intent.request, hostOptions);
        return new HostSandboxHandle(this.host, created.identity);
      }

      reportCreationDrift(intent.identity, intent.projected, existing);

      if (existing.state === "running") {
        return new HostSandboxHandle(this.host, existing.identity);
      }
      if (existing.state === "stopped") {
        const started = await this.host.start(intent.identity, hostOptions);
        return new HostSandboxHandle(this.host, started.identity);
      }
      throw SboxError.nativeState(`Cannot up sandbox in state ${formatState(existing.state)}.`, {
        details: { state: existing.state },
      });
    });
  }

  async recreate(options: ProfileOperationOptions = {}): Promise<SandboxHandle> {
    return this.withOperation("recreate", undefined, options, async () => {
      await this.requireLocal(options);
      const intent = await this.resolveIntent(options);
      const hostOptions = toHostOptions(options);

      try {
        await this.host.get(intent.identity, hostOptions);
        await this.host.remove(intent.identity, hostOptions);
      } catch (error) {
        if (!isSboxError(error) || error.code !== "not_found") {
          throw error;
        }
      }

      const created = await this.host.create(intent.request, hostOptions);
      return new HostSandboxHandle(this.host, created.identity);
    });
  }

  async build(options: ClientBuildOptions = {}): Promise<HostImageInspection> {
    return this.withOperation("build", undefined, options, async () => {
      await this.requireLocal(options);
      return this.ensureProfileImage(options);
    });
  }

  async listImages(
    options: ClientOperationOptions & { readonly includeUnowned?: boolean } = {},
  ): Promise<Awaited<ReturnType<Host["listImages"]>>> {
    return this.withOperation("listImages", undefined, options, async () => {
      await this.requireLocal(options);
      return this.host.listImages({
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.includeUnowned !== undefined ? { includeUnowned: options.includeUnowned } : {}),
      });
    });
  }

  async removeImage(
    reference: string,
    options: ClientOperationOptions & { readonly force?: boolean } = {},
  ): Promise<void> {
    return this.withOperation("removeImage", undefined, options, async () => {
      await this.requireLocal(options);
      await this.host.removeImage(reference, {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.force !== undefined ? { force: options.force } : {}),
      });
    });
  }

  async listStaleImageWorkspaces(
    options: ClientOperationOptions & { readonly workspaceRoot?: string } = {},
  ): Promise<Awaited<ReturnType<Host["listStaleImageWorkspaces"]>>> {
    return this.withOperation("listStaleImageWorkspaces", undefined, options, async () => {
      await this.requireLocal(options);
      return this.host.listStaleImageWorkspaces({
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
      });
    });
  }

  async inspect(
    identityOrOptions: SandboxIdentity | ProfileOperationOptions,
    options?: ClientOperationOptions,
  ): Promise<SandboxInspection> {
    const resolved = this.resolveReference(identityOrOptions, options);
    return this.withOperation("inspect", resolved.identity, resolved.options, async () => {
      await this.requireLocal(resolved.options);
      return this.host.inspect(resolved.identity, toHostOptions(resolved.options));
    });
  }

  async stop(
    identityOrOptions: SandboxIdentity | ProfileOperationOptions,
    options?: ClientOperationOptions,
  ): Promise<SandboxInspection> {
    const resolved = this.resolveReference(identityOrOptions, options);
    return this.withOperation("stop", resolved.identity, resolved.options, async () => {
      await this.requireLocal(resolved.options);
      return this.host.stop(resolved.identity, toHostOptions(resolved.options));
    });
  }

  async remove(
    identityOrOptions: SandboxIdentity | ProfileOperationOptions,
    options?: ClientOperationOptions,
  ): Promise<void> {
    const resolved = this.resolveReference(identityOrOptions, options);
    return this.withOperation("remove", resolved.identity, resolved.options, async () => {
      await this.requireLocal(resolved.options);
      await this.host.remove(resolved.identity, toHostOptions(resolved.options));
    });
  }

  async listVolumes(
    options: ClientOperationOptions = {},
  ): Promise<Awaited<ReturnType<Host["listVolumes"]>>> {
    return this.withOperation("listVolumes", undefined, options, async () => {
      await this.requireLocal(options);
      return this.host.listVolumes(
        { project: assertProjectId(this.project.project) },
        toHostOptions(options),
      );
    });
  }

  async ensureVolume(
    volume: string,
    options: ClientOperationOptions = {},
  ): Promise<Awaited<ReturnType<Host["ensureVolume"]>>> {
    return this.withOperation("ensureVolume", undefined, options, async () => {
      await this.requireLocal(options);
      const declaration = this.project.volumes?.[volume];
      if (declaration === undefined) {
        throw SboxError.validation(`Volume "${volume}" is not declared in project volumes.`, {
          details: { path: `volumes.${volume}` },
        });
      }
      return this.host.ensureVolume(
        {
          project: assertProjectId(this.project.project),
          volume,
          sizeBytes: parseBinarySizeToBytes(declaration.size, `volumes.${volume}.size`),
        },
        toHostOptions(options),
      );
    });
  }

  async removeVolume(volume: string, options: ClientOperationOptions = {}): Promise<void> {
    await this.withOperation("removeVolume", undefined, options, async () => {
      await this.requireLocal(options);
      if (this.project.volumes?.[volume] === undefined) {
        throw SboxError.validation(`Volume "${volume}" is not declared in project volumes.`, {
          details: { path: `volumes.${volume}` },
        });
      }
      await this.host.removeVolume(
        { project: assertProjectId(this.project.project), volume },
        toHostOptions(options),
      );
    });
  }

  async volumeShell(volume: string, options: ProfileOperationOptions = {}): Promise<SandboxHandle> {
    return this.withOperation("volumeShell", undefined, options, async () => {
      await this.requireLocal(options);
      const declaration = this.project.volumes?.[volume];
      if (declaration === undefined) {
        throw SboxError.validation(`Volume "${volume}" is not declared in project volumes.`, {
          details: { path: `volumes.${volume}` },
        });
      }
      const selected = selectProfile(this.project, options.profile);
      const attachment = (selected.profile.volumes ?? []).find((item) => item.volume === volume);
      if (attachment === undefined) {
        throw SboxError.validation(`Profile ${selected.name} does not attach volume "${volume}".`, {
          details: { path: `profiles.${selected.name}.volumes` },
        });
      }
      const intent = await this.resolveIntent({
        ...options,
        profile: selected.name,
      });
      const inspection = await this.host.volumeShell(
        {
          project: assertProjectId(this.project.project),
          volume,
          sizeBytes: parseBinarySizeToBytes(declaration.size, `volumes.${volume}.size`),
          profile: selected.name,
          image: intent.request.image,
          ...(intent.request.cpus !== undefined ? { cpus: intent.request.cpus } : {}),
          ...(intent.request.memoryMiB !== undefined
            ? { memoryMiB: intent.request.memoryMiB }
            : {}),
          ...(intent.request.workdir !== undefined ? { workdir: intent.request.workdir } : {}),
          ...(intent.request.user !== undefined ? { user: intent.request.user } : {}),
          ...(intent.request.shell !== undefined ? { shell: intent.request.shell } : {}),
          ...(intent.request.hostname !== undefined ? { hostname: intent.request.hostname } : {}),
          ...(intent.request.env !== undefined ? { env: intent.request.env } : {}),
          ...(intent.request.maxDurationSecs !== undefined
            ? { maxDurationSecs: intent.request.maxDurationSecs }
            : {}),
          ...(intent.request.idleTimeoutSecs !== undefined
            ? { idleTimeoutSecs: intent.request.idleTimeoutSecs }
            : {}),
          path: attachment.path,
        },
        toHostOptions(options),
      );
      return new HostSandboxHandle(this.host, inspection.identity);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.ownsHost) {
      await disposeHost(this.host);
    }
  }

  private async requireLocal(
    options: ClientOperationOptions | ProfileOperationOptions,
  ): Promise<ResolvedLocalTarget> {
    return requireLocalTarget({
      project: this.project,
      user: this.user,
      ...(options.target !== undefined ? { explicitTarget: options.target } : {}),
    });
  }

  private resolveReference(
    identityOrOptions: SandboxIdentity | ProfileOperationOptions,
    options?: ClientOperationOptions,
  ): { readonly identity: SandboxIdentity; readonly options: ClientOperationOptions } {
    if (isSandboxIdentity(identityOrOptions)) {
      return {
        identity: assertSandboxIdentity(identityOrOptions),
        options: options ?? {},
      };
    }
    const profileOptions = identityOrOptions;
    const selected = selectProfile(this.project, profileOptions.profile);
    const identity = assertSandboxIdentity({
      project: assertProjectId(this.project.project),
      profile: selected.name,
      instance: resolveInstanceId(selected.name, profileOptions.instance),
    });
    return {
      identity,
      options: {
        ...profileOptions,
        ...(options?.target !== undefined ? { target: options.target } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      },
    };
  }

  private async resolveIntent(options: ProfileOperationOptions) {
    const selected = selectProfile(this.project, options.profile);
    let resolvedImage: string | undefined;
    if (isBuildProfile(selected.profile)) {
      const image = await this.ensureProfileImage(options);
      resolvedImage = image.reference;
    }
    return resolveCreateIntent({
      project: this.project,
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(options.instance !== undefined ? { instance: options.instance } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.networkAllow !== undefined ? { networkAllow: options.networkAllow } : {}),
      ...(options.networkPublish !== undefined ? { networkPublish: options.networkPublish } : {}),
      ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
      ...(resolvedImage !== undefined ? { resolvedImage } : {}),
      external: this.externalContext(options),
    });
  }

  /**
   * Resolve create intent using predicted image identity only — no Docker/msb
   * mutation. Used by `up` so existing sandboxes can start without building.
   */
  private async resolveIntentPredictingImage(options: ProfileOperationOptions) {
    const selected = selectProfile(this.project, options.profile);
    let resolvedImage: string | undefined;
    const needsImageEnsure = isBuildProfile(selected.profile);
    if (needsImageEnsure) {
      const predicted = await resolveImageIdentityInputs({
        project: this.project,
        ...(options.profile !== undefined ? { profile: options.profile } : {}),
        external: this.externalContext(options),
      });
      const identity = await computeGeneratedImageIdentity({
        ...predicted.inputs,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      resolvedImage = identity.nativeReference;
    }
    const intent = await resolveCreateIntent({
      project: this.project,
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(options.instance !== undefined ? { instance: options.instance } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.networkAllow !== undefined ? { networkAllow: options.networkAllow } : {}),
      ...(options.networkPublish !== undefined ? { networkPublish: options.networkPublish } : {}),
      ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
      ...(resolvedImage !== undefined ? { resolvedImage } : {}),
      external: this.externalContext(options),
    });
    return { ...intent, needsImageEnsure };
  }

  private async ensureProfileImage(options: ClientBuildOptions): Promise<HostImageInspection> {
    const resolved = await resolveEnsureImageRequest({
      project: this.project,
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      external: this.externalContext(options),
      ...(options.force === true ? { force: true } : {}),
    });
    return this.host.ensureImage(resolved.request, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  private externalContext(options: ProfileOperationOptions): ExternalResolutionContext {
    return {
      configDirectory: this.configDirectory,
      env: this.env,
      invocation: {
        ...this.invocation,
        ...options.invocation,
      },
    };
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
          : { project: this.project.project }),
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
          : { project: this.project.project }),
        details: wrapped.toSafeJSON().details,
      });
      throw wrapped;
    }
  }

  private ensureOpen(): void {
    if (this.disposed) {
      throw SboxError.internal("SboxClient has been disposed.");
    }
  }
}

/**
 * Typed-config entrypoint. Does not require YAML.
 */
export function createSboxClient(options: SboxClientOptions): SboxClient {
  return new HostSboxClient(options);
}

function isSandboxIdentity(
  value: SandboxIdentity | ProfileOperationOptions,
): value is SandboxIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    "project" in value &&
    "profile" in value &&
    "instance" in value &&
    typeof (value as SandboxIdentity).project === "string" &&
    typeof (value as SandboxIdentity).profile === "string" &&
    typeof (value as SandboxIdentity).instance === "string"
  );
}

/**
 * Project client options into a fresh Host OperationOptions object.
 * Client-only fields (profile, target, env, invocation, …) must never cross
 * the Host seam — RemoteHost could otherwise serialize undeclared credentials.
 */
function toHostOptions(
  options?: ClientOperationOptions | ProfileOperationOptions,
): OperationOptions {
  return options?.signal !== undefined ? { signal: options.signal } : {};
}

function toHostListOptions(
  options: ClientListOptions | undefined,
  defaultProject: ReturnType<typeof assertProjectId>,
): HostListOptions {
  return {
    project: options?.project ?? defaultProject,
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  };
}

function formatState(state: SandboxInspection["state"]): string {
  return typeof state === "string" ? state : `unknown(${state.native})`;
}
