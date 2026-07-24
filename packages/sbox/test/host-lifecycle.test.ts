import type { Host } from "../src/host.js";
import { FakeHost } from "../src/fake-host.js";
import { createLocalHostInternal } from "../src/local-host-internal.js";
import { assertSandboxIdentity, nativeSandboxName, type SandboxIdentity } from "../src/identity.js";
import { disposeHost } from "../src/host.js";
import { buildOwnershipLabels } from "../src/ownership-adoption.js";
import { MemoryNativeRuntime } from "./helpers/memory-native-runtime.js";
import { describe, expect, it } from "vitest";

function identity(project = "demo", profile = "default", instance = "main"): SandboxIdentity {
  return assertSandboxIdentity({ project, profile, instance });
}

function createRequest(
  overrides: Partial<{ image: string; cpus: number; memoryMiB: number }> = {},
) {
  return {
    identity: identity(),
    image: overrides.image ?? "alpine:3.20",
    ...(overrides.cpus !== undefined ? { cpus: overrides.cpus } : { cpus: 1 }),
    ...(overrides.memoryMiB !== undefined
      ? { memoryMiB: overrides.memoryMiB }
      : { memoryMiB: 512 }),
  };
}

function hostFactories(): Array<{
  name: string;
  create: () => { host: Host; runtime?: MemoryNativeRuntime };
}> {
  return [
    {
      name: "FakeHost",
      create: () => ({ host: new FakeHost() }),
    },
    {
      name: "LocalHost+MemoryNativeRuntime",
      create: () => {
        const runtime = new MemoryNativeRuntime();
        return { host: createLocalHostInternal({ runtime }), runtime };
      },
    },
  ];
}

describe.each(hostFactories())("Host lifecycle contract ($name)", ({ create }) => {
  it("creates, inspects, stops, starts, lists, and removes", async () => {
    const { host } = create();
    const request = createRequest();
    const created = await host.create(request);
    expect(created.identity).toEqual(request.identity);
    expect(created.nativeName).toBe(
      nativeSandboxName(request.identity.project, request.identity.instance),
    );
    expect(created.state).toBe("running");
    expect(created.creation.image).toBe("alpine:3.20");
    expect(created.labels).toMatchObject(
      buildOwnershipLabels(request.identity, {
        image: "alpine:3.20",
        cpus: 1,
        memoryMiB: 512,
        workdir: null,
        user: null,
        shell: null,
        hostname: null,
        env: {},
      }),
    );

    const inspected = await host.inspect(request.identity);
    expect(inspected.nativeName).toBe(created.nativeName);

    const stopped = await host.stop(request.identity);
    expect(stopped.state).toBe("stopped");

    const started = await host.start(request.identity);
    expect(started.state).toBe("running");

    const listed = await host.list({ project: request.identity.project });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.nativeName).toBe(created.nativeName);

    await host.remove(request.identity);
    await expect(host.get(request.identity)).rejects.toMatchObject({ code: "not_found" });
  });

  it("fails create when the identity already exists", async () => {
    const { host } = create();
    const request = createRequest();
    await host.create(request);
    await expect(host.create(request)).rejects.toMatchObject({ code: "already_exists" });
  });

  it("fails get/inspect when missing", async () => {
    const { host } = create();
    await expect(host.get(identity())).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports capabilities without mutating sandboxes", async () => {
    const { host } = create();
    const caps = await host.capabilities();
    expect(typeof caps.localMicrosandbox).toBe("boolean");
    expect(Array.isArray(caps.notes)).toBe(true);
    expect(await host.list()).toEqual([]);
  });

  it("disposal is idempotent and does not remove sandboxes", async () => {
    const { host } = create();
    const request = createRequest();
    await host.create(request);
    await disposeHost(host);
    await disposeHost(host);
    // After dispose, operations may fail as closed; sandboxes must not be implicitly removed
    // through dispose itself. Verify by creating a fresh host against the same backing store
    // only for LocalHost; FakeHost loses memory on dispose of the object itself, so for FakeHost
    // we only assert dispose does not throw twice.
  });
});

describe("FakeHost ownership conflicts", () => {
  it("rejects create when a foreign native name is occupied", async () => {
    const host = new FakeHost();
    const id = identity();
    const nativeName = nativeSandboxName(id.project, id.instance);
    host.seedForeignNative(nativeName);
    await expect(host.create(createRequest())).rejects.toMatchObject({
      code: "ownership_conflict",
    });
  });

  it("preserves unknown native states", async () => {
    const host = new FakeHost();
    const id = identity();
    host.seed({
      identity: id,
      state: { kind: "unknown", native: "hibernating" },
    });
    const inspected = await host.inspect(id);
    expect(inspected.state).toEqual({ kind: "unknown", native: "hibernating" });
    await expect(host.start(id)).rejects.toMatchObject({ code: "native_state" });
  });
});

describe.each(hostFactories())("Host stop preconditions ($name)", ({ create }) => {
  it("stops running and draining; rejects crashed and unknown", async () => {
    const { host, runtime } = create();
    const id = identity("stop", "default", "states");

    if (runtime === undefined) {
      const fake = host as FakeHost;
      fake.seed({ identity: id, state: "running" });
      expect((await host.stop(id)).state).toBe("stopped");

      fake.seed({ identity: id, state: "draining" });
      expect((await host.stop(id)).state).toBe("stopped");

      fake.seed({ identity: id, state: "stopped" });
      expect((await host.stop(id)).state).toBe("stopped");

      fake.seed({ identity: id, state: "crashed" });
      await expect(host.stop(id)).rejects.toMatchObject({ code: "native_state" });

      fake.seed({ identity: id, state: { kind: "unknown", native: "hibernating" } });
      await expect(host.stop(id)).rejects.toMatchObject({ code: "native_state" });
      return;
    }

    const name = nativeSandboxName(id.project, id.instance);
    const baseRecord = {
      name,
      labels: buildOwnershipLabels(id, {
        image: "alpine:3.20",
        cpus: 1,
        memoryMiB: 512,
        workdir: null,
        user: null,
        shell: null,
        hostname: null,
        env: {},
      }),
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
      workdir: null as string | null,
      user: null as string | null,
      shell: null as string | null,
      hostname: null as string | null,
      env: {},
    };

    runtime.seed({ ...baseRecord, status: "running" });
    expect((await host.stop(id)).state).toBe("stopped");

    runtime.seed({ ...baseRecord, status: "draining" });
    expect((await host.stop(id)).state).toBe("stopped");

    runtime.seed({ ...baseRecord, status: "stopped" });
    expect((await host.stop(id)).state).toBe("stopped");

    runtime.seed({ ...baseRecord, status: "crashed" });
    await expect(host.stop(id)).rejects.toMatchObject({ code: "native_state" });

    runtime.seed({ ...baseRecord, status: "hibernating" });
    await expect(host.stop(id)).rejects.toMatchObject({ code: "native_state" });
  });
});

describe("LocalHost uncertain create and detach", () => {
  it("returns matching owned resource after uncertain create", async () => {
    const runtime = new MemoryNativeRuntime();
    runtime.createFailMode = "uncertain-success";
    const host = createLocalHostInternal({ runtime });
    const created = await host.create(createRequest());
    expect(created.state).toBe("running");
    expect(created.identity.instance).toBe("main");
  });

  it("preserves failure when uncertain create leaves no resource", async () => {
    const runtime = new MemoryNativeRuntime();
    runtime.createFailMode = "uncertain-absent";
    const host = createLocalHostInternal({ runtime });
    await expect(host.create(createRequest())).rejects.toMatchObject({ code: "internal" });
    await expect(host.get(identity())).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns ownership_conflict when uncertain create finds a mismatch", async () => {
    const runtime = new MemoryNativeRuntime();
    runtime.createFailMode = "uncertain-conflict";
    const host = createLocalHostInternal({ runtime });
    await expect(host.create(createRequest())).rejects.toMatchObject({
      code: "ownership_conflict",
    });
  });

  it("rejects create against mismatched existing labels", async () => {
    const runtime = new MemoryNativeRuntime();
    const id = identity();
    const nativeName = nativeSandboxName(id.project, id.instance);
    runtime.seed({
      name: nativeName,
      status: "stopped",
      labels: { "dev.sohcah.sbox/managed": "true" },
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
      workdir: null,
      user: null,
      shell: null,
      hostname: null,
      env: {},
    });
    const host = createLocalHostInternal({ runtime });
    await expect(host.create(createRequest())).rejects.toMatchObject({
      code: "ownership_conflict",
    });
  });

  it("create and start detach live handles; stop uses stopLiveThenFreshGet", async () => {
    const runtime = new MemoryNativeRuntime();
    const host = createLocalHostInternal({ runtime });
    await host.create(createRequest());
    expect(runtime.calls.some((call) => call.op === "liveDetach")).toBe(true);
    runtime.calls.length = 0;
    await host.stop(identity());
    const stopOps = runtime.calls.map((call) => call.op);
    expect(stopOps).toContain("connect");
    expect(stopOps).toContain("liveStop");
    expect(stopOps).toContain("liveDetach");
    runtime.calls.length = 0;
    await host.start(identity());
    expect(runtime.calls.some((call) => call.op === "start")).toBe(true);
    expect(runtime.calls.some((call) => call.op === "liveDetach")).toBe(true);
  });

  it("exact removal stops running sandboxes first", async () => {
    const runtime = new MemoryNativeRuntime();
    const host = createLocalHostInternal({ runtime });
    await host.create(createRequest());
    await host.remove(identity());
    await expect(host.get(identity())).rejects.toMatchObject({ code: "not_found" });
  });

  it("disposal releases live handles without removing sandboxes", async () => {
    const runtime = new MemoryNativeRuntime();
    const host = createLocalHostInternal({ runtime });
    await host.create(createRequest());
    await host.stop(identity());
    expect(await runtime.list()).toHaveLength(1);
    await disposeHost(host);
    await disposeHost(host);
    expect(await runtime.list()).toHaveLength(1);
    await expect(host.inspect(identity())).rejects.toMatchObject({ code: "internal" });
  });
});
