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
import { createLocalHost } from "../local-host.js";
import { createRedactingLogger, safeLog, silentLogger, type Logger } from "../logging.js";
import type {
  HostListOptions,
  OperationOptions,
  SandboxInspection,
  SandboxSummary,
} from "../types.js";
import type { ProjectConfig, UserConfig } from "../config/types.js";
import { parseProjectConfig, parseUserConfig } from "../config/validate.js";
import { requireLocalTarget, type ResolvedLocalTarget } from "../config/targets.js";
import type { ExternalResolutionContext } from "../config/external.js";
import { resolveInstanceId, selectProfile } from "../config/profile.js";
import type { SandboxHandle } from "./handle.js";
import { HostSandboxHandle } from "./handle-impl.js";
import { reportCreationDrift, resolveCreateIntent } from "./resolve-intent.js";

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
   * - absent → create and start (create already starts attached/running)
   * - stopped → start
   * - running → success
   * Does not reconcile immutable creation drift.
   */
  async up(options: ProfileOperationOptions = {}): Promise<SandboxHandle> {
    return this.withOperation("up", undefined, options, async () => {
      await this.requireLocal(options);
      const intent = await this.resolveIntent(options);
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
    return resolveCreateIntent({
      project: this.project,
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(options.instance !== undefined ? { instance: options.instance } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      external: this.externalContext(options),
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
