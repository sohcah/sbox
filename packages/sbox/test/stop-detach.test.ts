import { describe, expect, it } from "vitest";
import { assertSandboxIdentity, nativeSandboxName } from "../src/identity.js";
import { createLocalHostInternal } from "../src/local-host-internal.js";
import { disposeHost } from "../src/host.js";
import { MemoryNativeRuntime } from "./helpers/memory-native-runtime.js";

const identity = assertSandboxIdentity({
  project: "demo",
  profile: "default",
  instance: "main",
});

const request = {
  identity,
  image: "alpine:3.20" as const,
};

describe("stop → detach → fresh get", () => {
  it("uses connect, live stop, live detach, then fresh get", async () => {
    const runtime = new MemoryNativeRuntime();
    const host = createLocalHostInternal({ runtime });
    await host.create(request);
    runtime.calls.length = 0;

    const stopped = await host.stop(identity);
    expect(stopped.state).toBe("stopped");

    const ops = runtime.calls.map((call) => call.op);
    const connectIdx = ops.indexOf("connect");
    const stopIdx = ops.indexOf("liveStop");
    const detachIdx = ops.indexOf("liveDetach");
    const getIdx = ops.lastIndexOf("get");
    expect(connectIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(connectIdx);
    expect(detachIdx).toBeGreaterThan(stopIdx);
    expect(getIdx).toBeGreaterThan(detachIdx);
  });

  it("does not live-stop an already stopped sandbox", async () => {
    const runtime = new MemoryNativeRuntime();
    const host = createLocalHostInternal({ runtime });
    await host.create(request);
    await host.stop(identity);
    runtime.calls.length = 0;
    const again = await host.stop(identity);
    expect(again.state).toBe("stopped");
    expect(runtime.calls.some((call) => call.op === "liveStop")).toBe(false);
  });

  it("surfaces stop failure without claiming success", async () => {
    const runtime = new MemoryNativeRuntime();
    const host = createLocalHostInternal({ runtime });
    await host.create(request);
    runtime.stopFailNames.add(nativeSandboxName(identity.project, identity.instance));
    await expect(host.stop(identity)).rejects.toMatchObject({ code: "internal" });
    expect((await host.inspect(identity)).state).toBe("running");
  });

  it("surfaces detach failure after stop via stopLiveThenFreshGet", async () => {
    const runtime = new MemoryNativeRuntime();
    const host = createLocalHostInternal({ runtime });
    await host.create(request);
    runtime.detachFailNames.add(nativeSandboxName(identity.project, identity.instance));
    await expect(host.stop(identity)).rejects.toMatchObject({
      code: "internal",
    });
  });

  it("surfaces fresh-get failure after detach", async () => {
    const runtime = new MemoryNativeRuntime();
    const host = createLocalHostInternal({ runtime });
    await host.create(request);
    runtime.freshGetFailAfterDetach.add(nativeSandboxName(identity.project, identity.instance));
    await expect(host.stop(identity)).rejects.toMatchObject({ code: "internal" });
  });

  it("restart and remove after stop succeed", async () => {
    const runtime = new MemoryNativeRuntime();
    const host = createLocalHostInternal({ runtime });
    await host.create(request);
    await host.stop(identity);
    const started = await host.start(identity);
    expect(started.state).toBe("running");
    await host.stop(identity);
    await host.remove(identity);
    await expect(host.get(identity)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps live handles retryable when create detach fails", async () => {
    const runtime = new MemoryNativeRuntime();
    const name = nativeSandboxName(identity.project, identity.instance);
    runtime.detachFailNames.add(name);
    const host = createLocalHostInternal({ runtime });
    await expect(host.create(request)).rejects.toMatchObject({
      code: "internal",
      details: { cleanup: "detach_failed" },
    });
    expect(await runtime.list()).toHaveLength(1);
    runtime.detachFailNames.delete(name);
    await disposeHost(host);
    await disposeHost(host);
    expect(await runtime.list()).toHaveLength(1);
  });
});
