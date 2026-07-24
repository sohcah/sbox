import { describe, expect, it } from "vitest";
import { assertSandboxIdentity, nativeSandboxName } from "../src/identity.js";
import { createLocalHostInternal } from "../src/local-host-internal.js";
import { buildOwnershipLabels } from "../src/ownership-adoption.js";
import { isSboxError } from "../src/errors.js";
import { projectCreateRequest } from "../src/immutable-creation.js";
import { OWNERSHIP_LABEL_KEYS } from "../src/ownership.js";
import { MemoryNativeRuntime } from "./helpers/memory-native-runtime.js";

const identity = assertSandboxIdentity({
  project: "demo",
  profile: "default",
  instance: "main",
});

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    identity,
    image: "alpine:3.20",
    ...overrides,
  };
}

/** Labels/fingerprint always match the *request* projection, not the seeded native fields. */
function matchingLabels(requestOverrides: Record<string, unknown> = {}) {
  return buildOwnershipLabels(identity, projectCreateRequest(baseRequest(requestOverrides)));
}

describe("uncertain-create immutable matching", () => {
  it("rejects resources that differ only by environment without leaking values", async () => {
    const runtime = new MemoryNativeRuntime();
    const name = nativeSandboxName(identity.project, identity.instance);
    runtime.seed({
      name,
      status: "running",
      labels: matchingLabels(),
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
      workdir: null,
      user: null,
      shell: null,
      hostname: null,
      maxDurationSecs: null,
      idleTimeoutSecs: null,
      env: { TOKEN: "secret-value" },
    });
    const host = createLocalHostInternal({ runtime });
    const error = await host.create(baseRequest()).catch((value: unknown) => value);
    expect(isSboxError(error)).toBe(true);
    if (isSboxError(error)) {
      expect(error.code).toBe("ownership_conflict");
      expect(JSON.stringify(error)).not.toContain("secret-value");
      expect(error.toSafeJSON().details).not.toEqual(
        expect.objectContaining({ env: expect.anything() }),
      );
    }
  });

  it.each([
    ["image", { image: "alpine:3.19" }],
    ["cpus", { cpus: 2 }],
    ["memoryMiB", { memoryMiB: 1024 }],
    ["workdir", { workdir: "/work" }],
    ["user", { user: "root" }],
    ["shell", { shell: "/bin/bash" }],
    ["hostname", { hostname: "box" }],
  ] as const)(
    "rejects when labels/fingerprint match but native %s differs",
    async (_label, nativeOverride) => {
      const runtime = new MemoryNativeRuntime();
      const name = nativeSandboxName(identity.project, identity.instance);
      runtime.seed({
        name,
        status: "stopped",
        labels: matchingLabels(),
        image: "alpine:3.20",
        cpus: 1,
        memoryMiB: 512,
        workdir: null,
        user: null,
        shell: null,
        hostname: null,
        maxDurationSecs: null,
        idleTimeoutSecs: null,
        env: {},
        ...nativeOverride,
      });
      const host = createLocalHostInternal({ runtime });
      await expect(host.create(baseRequest())).rejects.toMatchObject({
        code: "ownership_conflict",
      });
    },
  );

  it.each([
    ["cpus", { cpus: 2 }],
    ["memoryMiB", { memoryMiB: 1024 }],
    ["workdir", { workdir: "/work" }],
    ["user", { user: "root" }],
    ["shell", { shell: "/bin/bash" }],
    ["hostname", { hostname: "box" }],
  ] as const)(
    "rejects when request omits %s but native has a non-default value",
    async (_label, nativeOverride) => {
      const runtime = new MemoryNativeRuntime();
      const name = nativeSandboxName(identity.project, identity.instance);
      runtime.seed({
        name,
        status: "stopped",
        labels: matchingLabels(),
        image: "alpine:3.20",
        cpus: 1,
        memoryMiB: 512,
        workdir: null,
        user: null,
        shell: null,
        hostname: null,
        maxDurationSecs: null,
        idleTimeoutSecs: null,
        env: {},
        ...nativeOverride,
      });
      const host = createLocalHostInternal({ runtime });
      await expect(host.create(baseRequest())).rejects.toMatchObject({
        code: "ownership_conflict",
      });
    },
  );

  it("rejects mismatched native config on uncertain-create even when fingerprint matches", async () => {
    const runtime = new MemoryNativeRuntime();
    const name = nativeSandboxName(identity.project, identity.instance);
    runtime.create = async (request) => {
      runtime.seed({
        name,
        status: "stopped",
        labels: matchingLabels(),
        image: "wrong:latest",
        cpus: request.cpus,
        memoryMiB: request.memoryMiB,
        workdir: request.workdir,
        user: request.user,
        shell: request.shell,
        hostname: request.hostname,
        maxDurationSecs: request.maxDurationSecs,
        idleTimeoutSecs: request.idleTimeoutSecs,
        env: { ...request.env },
      });
      throw new Error("Simulated uncertain create failure (config drift).");
    };
    const host = createLocalHostInternal({ runtime });
    await expect(host.create(baseRequest())).rejects.toMatchObject({
      code: "ownership_conflict",
    });
  });

  it("adopts when labels, fingerprint, and decoded native configuration match", async () => {
    const runtime = new MemoryNativeRuntime();
    runtime.createFailMode = "uncertain-success";
    const host = createLocalHostInternal({ runtime });
    const created = await host.create(
      baseRequest({
        cpus: 1,
        memoryMiB: 512,
        workdir: "/tmp",
        user: "root",
        env: { A: "1" },
      }),
    );
    expect(created.state).toBe("running");
    expect(created.creation.image).toBe("alpine:3.20");
    expect(created.creation.cpus).toBe(1);
    expect(created.creation.memoryMiB).toBe(512);
    expect(created.creation.workdir).toBe("/tmp");
    expect(created.creation.user).toBe("root");
  });

  it("does not put env-derived values in the public creation fingerprint label", async () => {
    const labelsA = matchingLabels({ env: { TOKEN: "alpha" } });
    const labelsB = matchingLabels({ env: { TOKEN: "beta" } });
    expect(labelsA[OWNERSHIP_LABEL_KEYS.creation]).toBe(labelsB[OWNERSHIP_LABEL_KEYS.creation]);

    const runtime = new MemoryNativeRuntime();
    const name = nativeSandboxName(identity.project, identity.instance);
    runtime.seed({
      name,
      status: "stopped",
      labels: labelsA,
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
      workdir: null,
      user: null,
      shell: null,
      hostname: null,
      maxDurationSecs: null,
      idleTimeoutSecs: null,
      env: { TOKEN: "beta" },
    });
    const host = createLocalHostInternal({ runtime });
    const error = await host
      .create(baseRequest({ env: { TOKEN: "alpha" } }))
      .catch((value: unknown) => value);
    expect(isSboxError(error)).toBe(true);
    if (isSboxError(error)) {
      expect(error.code).toBe("ownership_conflict");
      expect(JSON.stringify(error)).not.toContain("alpha");
      expect(JSON.stringify(error)).not.toContain("beta");
    }
  });
});
