import { describe, expect, it } from "vitest";
import {
  assertSandboxIdentity,
  collectingLogger,
  createSboxClient,
  isSboxError,
  parseProjectConfig,
  type Host,
  type HostCopyPaths,
  type HostCreateRequest,
  type HostExecArgvRequest,
  type HostExecShellRequest,
  type HostListOptions,
  type HostPtyRequest,
  type HostCollectedExecOptions,
  type HostCopyOptions,
  type HostPtyOptions,
  type HostStreamingExecOptions,
  type OperationOptions,
  type ProcessResult,
  type ProcessSession,
  type ProjectConfig,
  type PtySession,
  type SandboxIdentity,
  type SandboxInspection,
  type SandboxSummary,
} from "../src/index.js";
import { FakeHost } from "../src/fake-host.js";
import { disposeHost } from "../src/host.js";

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return parseProjectConfig({
    version: 1,
    project: "demo",
    defaultProfile: "default",
    profiles: {
      default: {
        image: "alpine:3.20",
        cpus: 1,
        memoryMiB: 512,
        workdir: "/root",
      },
      other: {
        image: "alpine:3.19",
        cpus: 2,
        memoryMiB: 1024,
      },
    },
    ...overrides,
  });
}

const HOST_OPTION_KEYS = new Set(["signal"]);
const HOST_LIST_OPTION_KEYS = new Set(["signal", "project"]);

class RecordingHost implements Host {
  readonly receivedOptions: OperationOptions[] = [];
  constructor(private readonly inner: FakeHost) {}

  private record(options?: OperationOptions): OperationOptions | undefined {
    if (options !== undefined) {
      this.receivedOptions.push(options);
    }
    return options;
  }

  create(request: HostCreateRequest, options?: OperationOptions): Promise<SandboxInspection> {
    return this.inner.create(request, this.record(options));
  }
  get(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.inner.get(identity, this.record(options));
  }
  list(options?: HostListOptions): Promise<readonly SandboxSummary[]> {
    this.record(options);
    return this.inner.list(options);
  }
  inspect(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.inner.inspect(identity, this.record(options));
  }
  start(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.inner.start(identity, this.record(options));
  }
  stop(identity: SandboxIdentity, options?: OperationOptions): Promise<SandboxInspection> {
    return this.inner.stop(identity, this.record(options));
  }
  remove(identity: SandboxIdentity, options?: OperationOptions): Promise<void> {
    return this.inner.remove(identity, this.record(options));
  }
  capabilities(options?: OperationOptions) {
    return this.inner.capabilities(this.record(options));
  }
  execArgv(
    request: HostExecArgvRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    this.record(options);
    return this.inner.execArgv(request, options);
  }
  execArgvStream(
    request: HostExecArgvRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    this.record(options);
    return this.inner.execArgvStream(request, options);
  }
  execShell(
    request: HostExecShellRequest,
    options?: HostCollectedExecOptions,
  ): Promise<ProcessResult> {
    this.record(options);
    return this.inner.execShell(request, options);
  }
  execShellStream(
    request: HostExecShellRequest,
    options?: HostStreamingExecOptions,
  ): Promise<ProcessSession> {
    this.record(options);
    return this.inner.execShellStream(request, options);
  }
  pty(request: HostPtyRequest, options?: HostPtyOptions): Promise<PtySession> {
    this.record(options);
    return this.inner.pty(request, options);
  }
  copyHostToGuest(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    this.record(options);
    return this.inner.copyHostToGuest(request, options);
  }
  copyGuestToHost(request: HostCopyPaths, options?: HostCopyOptions): Promise<void> {
    this.record(options);
    return this.inner.copyGuestToHost(request, options);
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.inner[Symbol.asyncDispose]();
  }
}

describe("SboxClient workflows against FakeHost", () => {
  it("strict create fails when identity exists; strict get fails when absent", async () => {
    const host = new FakeHost();
    const client = createSboxClient({ project: project(), host, ownsHost: false });
    const handle = await client.create({ profile: "default" });
    expect(handle.identity.instance).toBe("default");
    await expect(client.create({ profile: "default" })).rejects.toMatchObject({
      code: "already_exists",
    });
    await expect(
      client.get(
        assertSandboxIdentity({ project: "demo", profile: "default", instance: "missing" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await client[Symbol.asyncDispose]();
    await disposeHost(host);
  });

  it("lists only the project by default and supports explicit instance identities", async () => {
    const host = new FakeHost();
    const client = createSboxClient({ project: project(), host, ownsHost: false });
    await client.create({ profile: "default" });
    await client.create({ profile: "default", instance: "custom" });
    const listed = await client.list();
    expect(listed).toHaveLength(2);
    expect(listed.every((item) => item.identity.project === "demo")).toBe(true);
    await client[Symbol.asyncDispose]();
    await disposeHost(host);
  });

  it("up creates when absent, starts when stopped, and returns when running", async () => {
    const host = new FakeHost();
    const client = createSboxClient({ project: project(), host, ownsHost: false });

    const first = await client.up({ profile: "default" });
    const firstInspect = await first.inspect();
    expect(firstInspect.state).toBe("running");

    const second = await client.up({ profile: "default" });
    expect((await second.inspect()).nativeName).toBe(firstInspect.nativeName);

    await client.stop(first.identity);
    expect((await client.inspect(first.identity)).state).toBe("stopped");

    const third = await client.up({ profile: "default" });
    expect((await third.inspect()).state).toBe("running");
    expect((await third.inspect()).nativeName).toBe(firstInspect.nativeName);

    await client[Symbol.asyncDispose]();
    await disposeHost(host);
  });

  it("reports immutable creation drift and requires explicit recreate", async () => {
    const host = new FakeHost();
    const client = createSboxClient({ project: project(), host, ownsHost: false });
    await client.up({ profile: "default" });

    const drifted = createSboxClient({
      project: parseProjectConfig({
        version: 1,
        project: "demo",
        defaultProfile: "default",
        profiles: {
          default: {
            image: "alpine:3.19",
            cpus: 1,
            memoryMiB: 512,
            workdir: "/root",
          },
        },
      }),
      host,
      ownsHost: false,
    });

    const error = await drifted.up({ profile: "default" }).catch((value: unknown) => value);
    expect(isSboxError(error)).toBe(true);
    if (isSboxError(error)) {
      expect(error.code).toBe("ownership_conflict");
      expect(error.details["drift"]).toEqual(expect.arrayContaining(["image"]));
      expect(JSON.stringify(error)).not.toContain("secret");
    }

    const recreated = await drifted.recreate({ profile: "default" });
    expect((await recreated.inspect()).creation.image).toBe("alpine:3.19");

    await client[Symbol.asyncDispose]();
    await drifted[Symbol.asyncDispose]();
    await disposeHost(host);
  });

  it("removes exact owned identities and disposal never changes lifecycle", async () => {
    const host = new FakeHost();
    const client = createSboxClient({ project: project(), host, ownsHost: false });
    const handle = await client.up({ profile: "default" });
    const identity = handle.identity;
    await handle[Symbol.asyncDispose]();
    expect((await client.inspect(identity)).state).toBe("running");

    await client.remove(identity);
    await expect(client.inspect(identity)).rejects.toMatchObject({ code: "not_found" });

    await client[Symbol.asyncDispose]();
    await client[Symbol.asyncDispose]();
    await disposeHost(host);
  });

  it("resolves external references before create mutation and reports all missing", async () => {
    const host = new FakeHost();
    const client = createSboxClient({
      project: parseProjectConfig({
        version: 1,
        project: "demo",
        profiles: {
          default: {
            image: "alpine:3.20",
            environment: {
              A: { env: "MISSING_A" },
              B: { invocation: "missing-b" },
            },
          },
        },
      }),
      host,
      ownsHost: false,
      env: {},
      invocation: {},
    });
    const error = await client.create().catch((value: unknown) => value);
    expect(isSboxError(error)).toBe(true);
    if (isSboxError(error)) {
      expect(error.code).toBe("validation");
      const issues = error.details["issues"];
      expect(Array.isArray(issues)).toBe(true);
      expect((issues as unknown[]).length).toBe(2);
    }
    expect(await client.list()).toHaveLength(0);
    await client[Symbol.asyncDispose]();
    await disposeHost(host);
  });

  it("rejects remote targets for every lifecycle op without touching the local Host", async () => {
    const host = new FakeHost();
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "default",
    });
    host.seed({ identity, state: "running" });
    host.operations.length = 0;

    const remoteUser = {
      version: 1 as const,
      defaultTarget: "remote",
      targets: {
        local: { kind: "local" as const },
        remote: {
          kind: "remote" as const,
          url: "http://127.0.0.1:8787",
          token: { env: "SBOX_TOKEN" },
        },
      },
    };

    const client = createSboxClient({
      project: project(),
      user: remoteUser,
      host,
      ownsHost: false,
      env: { SBOX_TOKEN: "tok" },
    });

    await expect(client.list()).rejects.toMatchObject({ code: "capability" });
    await expect(client.get(identity)).rejects.toMatchObject({ code: "capability" });
    await expect(client.get({ profile: "default" })).rejects.toMatchObject({ code: "capability" });
    await expect(client.inspect(identity)).rejects.toMatchObject({ code: "capability" });
    await expect(client.stop(identity)).rejects.toMatchObject({ code: "capability" });
    await expect(client.remove(identity)).rejects.toMatchObject({ code: "capability" });
    await expect(client.up({ profile: "default" })).rejects.toMatchObject({ code: "capability" });
    await expect(client.create({ profile: "other" })).rejects.toMatchObject({
      code: "capability",
    });
    await expect(client.recreate({ profile: "default" })).rejects.toMatchObject({
      code: "capability",
    });

    expect(host.operations).toEqual([]);
    const localClient = createSboxClient({ project: project(), host, ownsHost: false });
    expect((await localClient.inspect(identity)).state).toBe("running");

    await expect(client.list({ target: "remote" })).rejects.toMatchObject({ code: "capability" });

    // Explicit local override still works under a remote default.
    const localOverride = createSboxClient({
      project: project(),
      user: remoteUser,
      host,
      ownsHost: false,
      env: { SBOX_TOKEN: "tok" },
    });
    host.operations.length = 0;
    expect(await localOverride.list({ target: "local" })).toHaveLength(1);
    expect(host.operations).toContain("list");

    await client[Symbol.asyncDispose]();
    await localClient[Symbol.asyncDispose]();
    await localOverride[Symbol.asyncDispose]();
    await disposeHost(host);
  });

  it("projects only Host-contract fields across the Host options seam", async () => {
    const inner = new FakeHost();
    const host = new RecordingHost(inner);
    const logs = collectingLogger();
    const client = createSboxClient({
      project: project(),
      host,
      ownsHost: false,
      logger: logs.logger,
    });

    const envCanary = "SECRET_ENV_CANARY_VALUE";
    const invocationCanary = "SECRET_TOKEN_CANARY_VALUE";
    const clientExtras = {
      profile: "default" as const,
      target: "local",
      env: { SECRET_ENV_CANARY: envCanary },
      invocation: { SECRET_TOKEN_CANARY: invocationCanary },
    };

    await client.create(clientExtras);
    await client.list(
      Object.assign(
        { target: "local" as const },
        {
          profile: "default",
          env: clientExtras.env,
          invocation: clientExtras.invocation,
        },
      ),
    );
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "default",
    });
    await client.get(identity, clientExtras);
    await client.inspect({ ...clientExtras });
    await client.up({ ...clientExtras, instance: "default" });
    await client.stop(identity, clientExtras);
    await client.recreate({ ...clientExtras, instance: "other" });
    await client.remove(
      assertSandboxIdentity({ project: "demo", profile: "default", instance: "other" }),
      clientExtras,
    );

    expect(host.receivedOptions.length).toBeGreaterThan(0);
    for (const options of host.receivedOptions) {
      const keys = Object.keys(options);
      const allowed = "project" in options ? HOST_LIST_OPTION_KEYS : HOST_OPTION_KEYS;
      for (const key of keys) {
        expect(allowed.has(key)).toBe(true);
      }
      expect(keys).not.toContain("profile");
      expect(keys).not.toContain("instance");
      expect(keys).not.toContain("target");
      expect(keys).not.toContain("env");
      expect(keys).not.toContain("invocation");
    }

    const serialized = JSON.stringify(host.receivedOptions);
    expect(serialized).not.toContain(envCanary);
    expect(serialized).not.toContain(invocationCanary);
    expect(serialized).not.toContain("SECRET_ENV_CANARY");
    expect(serialized).not.toContain("SECRET_TOKEN_CANARY");

    const logText = JSON.stringify(logs.events);
    expect(logText).not.toContain(envCanary);
    expect(logText).not.toContain(invocationCanary);

    await client[Symbol.asyncDispose]();
    await disposeHost(inner);
  });
});
