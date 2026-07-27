/**
 * In-memory NativeRuntime for LocalHost unit/contract tests.
 */

import { SboxError } from "../../src/errors.js";
import type {
  NativeCall,
  NativeCreateRequest,
  NativeLiveHandle,
  NativeRuntime,
  NativeSandboxRecord,
} from "../../src/native-runtime.js";
import type { LabelMap } from "../../src/ownership.js";
import { PHASE1_DEFAULT_CPUS, PHASE1_DEFAULT_MEMORY_MIB } from "../../src/immutable-creation.js";
import { defaultNetworkConfig, toSafeRuntimeSecret } from "../../src/network/types.js";

interface Stored {
  record: NativeSandboxRecord;
}

class MemoryLiveHandle implements NativeLiveHandle {
  detached = false;
  constructor(
    readonly name: string,
    private readonly onStop: () => void,
    private readonly onDetach: () => void,
  ) {}

  async stop(): Promise<void> {
    this.onStop();
  }

  async detach(): Promise<void> {
    this.detached = true;
    this.onDetach();
  }
}

export class MemoryNativeRuntime implements NativeRuntime {
  private readonly byName = new Map<string, Stored>();
  createFailMode: "none" | "uncertain-success" | "uncertain-absent" | "uncertain-conflict" = "none";
  detachFailNames = new Set<string>();
  stopFailNames = new Set<string>();
  connectFailNames = new Set<string>();
  freshGetFailAfterDetach = new Set<string>();
  probeAvailable = true;
  readonly calls: NativeCall[] = [];

  async create(request: NativeCreateRequest): Promise<NativeLiveHandle> {
    this.calls.push({ op: "create", name: request.name });
    if (this.createFailMode === "uncertain-absent") {
      this.createFailMode = "none";
      throw SboxError.internal("Simulated uncertain create failure (absent).");
    }
    if (this.createFailMode === "uncertain-conflict") {
      this.createFailMode = "none";
      this.byName.set(request.name, {
        record: {
          name: request.name,
          status: "stopped",
          labels: Object.freeze({ "other/managed": "true" }),
          image: "foreign:latest",
          cpus: PHASE1_DEFAULT_CPUS,
          memoryMiB: PHASE1_DEFAULT_MEMORY_MIB,
          workdir: null,
          user: null,
          shell: null,
          hostname: null,
          maxDurationSecs: null,
          idleTimeoutSecs: null,
          env: Object.freeze({}),
          network: defaultNetworkConfig(),
          secrets: [],
          mounts: [],
          bindMounts: [],
        },
      });
      throw SboxError.internal("Simulated uncertain create failure (conflict).");
    }
    if (this.createFailMode === "uncertain-success") {
      this.createFailMode = "none";
      this.byName.set(request.name, {
        record: this.recordFromRequest(request, "running"),
      });
      throw SboxError.internal("Simulated uncertain create failure (matching).");
    }

    if (this.byName.has(request.name)) {
      throw SboxError.alreadyExists(`Sandbox ${request.name} already exists.`);
    }
    this.byName.set(request.name, {
      record: this.recordFromRequest(request, "running"),
    });
    return this.makeLive(request.name);
  }

  async get(name: string): Promise<NativeSandboxRecord> {
    this.calls.push({ op: "get", name });
    if (this.freshGetFailAfterDetach.has(name)) {
      this.freshGetFailAfterDetach.delete(name);
      throw SboxError.internal("Simulated fresh get failure.");
    }
    const stored = this.byName.get(name);
    if (stored === undefined) {
      throw SboxError.notFound(`Sandbox ${name} was not found.`);
    }
    return cloneRecord(stored.record);
  }

  async list(): Promise<readonly NativeSandboxRecord[]> {
    this.calls.push({ op: "list" });
    return [...this.byName.values()].map((stored) => cloneRecord(stored.record));
  }

  async start(name: string): Promise<NativeLiveHandle> {
    this.calls.push({ op: "start", name });
    const stored = this.byName.get(name);
    if (stored === undefined) {
      throw SboxError.notFound(`Sandbox ${name} was not found.`);
    }
    if (stored.record.status !== "running" && stored.record.status !== "stopped") {
      throw SboxError.nativeState(`Cannot start sandbox in state ${stored.record.status}.`);
    }
    stored.record = { ...stored.record, status: "running" };
    return this.makeLive(name);
  }

  async stopLiveThenFreshGet(name: string): Promise<NativeSandboxRecord> {
    const stored = this.byName.get(name);
    if (stored === undefined) {
      throw SboxError.notFound(`Sandbox ${name} was not found.`);
    }
    if (stored.record.status === "stopped") {
      this.calls.push({ op: "get", name });
      return cloneRecord(stored.record);
    }

    this.calls.push({ op: "connect", name });
    if (this.connectFailNames.has(name)) {
      throw SboxError.internal("Simulated connect failure.");
    }

    const live = this.makeLive(name);
    try {
      await live.stop();
    } catch (stopError) {
      try {
        await live.detach();
      } catch {
        // prefer stop failure
      }
      throw stopError;
    }

    await live.detach();

    this.calls.push({ op: "get", name });
    if (this.freshGetFailAfterDetach.has(name)) {
      this.freshGetFailAfterDetach.delete(name);
      throw SboxError.internal("Simulated fresh get failure.");
    }
    const fresh = this.byName.get(name);
    if (fresh === undefined) {
      throw SboxError.notFound(`Sandbox ${name} was not found.`);
    }
    return cloneRecord(fresh.record);
  }

  async remove(name: string): Promise<void> {
    this.calls.push({ op: "remove", name });
    const stored = this.byName.get(name);
    if (stored === undefined) {
      throw SboxError.notFound(`Sandbox ${name} was not found.`);
    }
    if (stored.record.status === "running" || stored.record.status === "draining") {
      throw SboxError.busy(`Sandbox ${name} is still running.`);
    }
    this.byName.delete(name);
  }

  async probe(): Promise<{ readonly available: boolean; readonly notes: readonly string[] }> {
    this.calls.push({ op: "probe" });
    return {
      available: this.probeAvailable,
      notes: this.probeAvailable
        ? ["MemoryNativeRuntime is available."]
        : ["MemoryNativeRuntime probe disabled."],
    };
  }

  seed(
    record: Omit<NativeSandboxRecord, "network" | "secrets" | "mounts" | "bindMounts"> & {
      readonly network?: NativeSandboxRecord["network"];
      readonly secrets?: NativeSandboxRecord["secrets"];
      readonly mounts?: NativeSandboxRecord["mounts"];
      readonly bindMounts?: NativeSandboxRecord["bindMounts"];
    },
  ): void {
    this.byName.set(record.name, {
      record: cloneRecord({
        ...record,
        network: record.network ?? defaultNetworkConfig(),
        secrets: record.secrets ?? [],
        mounts: record.mounts ?? [],
        bindMounts: record.bindMounts ?? [],
      }),
    });
  }

  private makeLive(name: string): NativeLiveHandle {
    const handle = new MemoryLiveHandle(
      name,
      () => {
        const stored = this.byName.get(name);
        if (stored !== undefined) {
          stored.record = { ...stored.record, status: "stopped" };
        }
      },
      () => {
        // tracked via wrapper below
      },
    );

    return {
      name,
      stop: async () => {
        this.calls.push({ op: "liveStop", name });
        if (this.stopFailNames.has(name)) {
          throw SboxError.internal("Simulated live stop failure.");
        }
        await handle.stop();
      },
      detach: async () => {
        this.calls.push({ op: "liveDetach", name });
        if (this.detachFailNames.has(name)) {
          throw SboxError.internal("Simulated detach failure.");
        }
        await handle.detach();
      },
    };
  }

  private recordFromRequest(request: NativeCreateRequest, status: string): NativeSandboxRecord {
    return {
      name: request.name,
      status,
      labels: freeze(request.labels),
      image: request.image,
      cpus: request.cpus,
      memoryMiB: request.memoryMiB,
      workdir: request.workdir,
      user: request.user,
      shell: request.shell,
      hostname: request.hostname,
      maxDurationSecs: request.maxDurationSecs,
      idleTimeoutSecs: request.idleTimeoutSecs,
      env: Object.freeze({ ...request.env }),
      network: request.network,
      secrets: Object.freeze(
        request.secrets.map((secret) =>
          toSafeRuntimeSecret({
            env: secret.env,
            placeholder: secret.placeholder,
            destinations: secret.destinations,
          }),
        ),
      ),
      mounts: Object.freeze(
        (request.mounts ?? []).map((mount) =>
          Object.freeze({
            guestPath: mount.guestPath,
            hostPath: mount.hostPath,
            format: mount.format,
            fstype: mount.fstype,
          }),
        ),
      ),
      bindMounts: Object.freeze(
        (request.bindMounts ?? []).map((mount) =>
          Object.freeze({
            guestPath: mount.guestPath,
            hostPath: mount.hostPath,
            readonly: mount.readonly,
            ...(mount.quotaMiB !== undefined ? { quotaMiB: mount.quotaMiB } : {}),
          }),
        ),
      ),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  }
}

function freeze(labels: LabelMap): LabelMap {
  return Object.freeze({ ...labels });
}

function cloneRecord(record: NativeSandboxRecord): NativeSandboxRecord {
  return {
    ...record,
    labels: freeze(record.labels),
    env: Object.freeze({ ...record.env }),
    network: {
      mode: record.network.mode,
      allow: Object.freeze([...record.network.allow]),
      publish: Object.freeze(record.network.publish.map((port) => Object.freeze({ ...port }))),
    },
    secrets: Object.freeze(
      record.secrets.map((secret) =>
        toSafeRuntimeSecret({
          env: secret.env,
          placeholder: secret.placeholder,
          destinations: secret.destinations,
        }),
      ),
    ),
    mounts: Object.freeze(
      record.mounts.map((mount) =>
        Object.freeze({
          guestPath: mount.guestPath,
          hostPath: mount.hostPath,
          format: mount.format,
          fstype: mount.fstype,
        }),
      ),
    ),
    bindMounts: Object.freeze(
      (record.bindMounts ?? []).map((mount) =>
        Object.freeze({
          guestPath: mount.guestPath,
          hostPath: mount.hostPath,
          readonly: mount.readonly,
          ...(mount.quotaMiB !== undefined ? { quotaMiB: mount.quotaMiB } : {}),
        }),
      ),
    ),
  };
}
