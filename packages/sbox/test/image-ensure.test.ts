import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHost } from "../src/fake-host.js";
import { createSboxClient } from "../src/client/client.js";
import { SboxError } from "../src/errors.js";
import {
  clearEnsureImageCoalescing,
  ensureImage,
  type EnsureImagePorts,
} from "../src/image/ensure.js";
import {
  buildImageOwnershipEnv,
  buildImageOwnershipLabels,
  formatNativeImageReference,
  hasNoReservedImageEvidence,
  inspectImageOwnershipEvidence,
} from "../src/image/naming.js";
import { hostDockerPlatform } from "../src/image/platform.js";
import {
  cleanupImageWorkspace,
  createImageWorkspace,
  listStaleImageWorkspaces,
} from "../src/image/workspace.js";
import type { HostEnsureImageRequest } from "../src/image/types.js";

afterEach(() => {
  clearEnsureImageCoalescing();
});

async function dockerfileProject(root: string) {
  await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\nRUN echo hi\n");
  await writeFile(join(root, "note.txt"), "n");
  return {
    version: 1 as const,
    project: "imgdemo",
    profiles: {
      built: {
        build: { context: root },
        memoryMiB: 512,
      },
    },
  };
}

async function ensureRequest(root: string): Promise<HostEnsureImageRequest> {
  return {
    contextRoot: root,
    dockerfile: "Dockerfile",
    platform: hostDockerPlatform(),
    args: {},
    secrets: {},
    includeGit: false,
  };
}

describe("ensureImage via FakeHost", () => {
  it("builds once, reuses exact image, and force rebuilds owned images", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-ensure-"));
    const host = new FakeHost();
    const client = createSboxClient({
      project: await dockerfileProject(root),
      host,
      ownsHost: false,
      configDirectory: root,
    });

    const first = await client.build({ profile: "built" });
    expect(first.built).toBe(true);
    expect(first.reused).toBe(false);
    expect(first.reference).toMatch(/^sbox-img:sha256-/);

    const second = await client.build({ profile: "built" });
    expect(second.reused).toBe(true);
    expect(second.reference).toBe(first.reference);

    const forced = await client.build({ profile: "built", force: true });
    expect(forced.built).toBe(true);
    expect(forced.reference).toBe(first.reference);

    const listed = await client.listImages();
    expect(listed.some((image) => image.reference === first.reference && image.owned)).toBe(true);

    await client.removeImage(first.reference);
    await expect(client.removeImage(first.reference)).rejects.toMatchObject({ code: "not_found" });
    await client[Symbol.asyncDispose]();
  });

  it("coalesces identical in-process concurrent builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-coalesce-"));
    const host = new FakeHost();
    const client = createSboxClient({
      project: await dockerfileProject(root),
      host,
      ownsHost: false,
      configDirectory: root,
    });
    const [a, b] = await Promise.all([
      client.build({ profile: "built" }),
      client.build({ profile: "built" }),
    ]);
    expect(a.reference).toBe(b.reference);
    expect(host.operations.filter((op) => op === "ensureImage").length).toBeGreaterThanOrEqual(1);
    await client[Symbol.asyncDispose]();
  });

  it("keeps shared work alive when one coalesced waiter cancels", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-coalesce-cancel-"));
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const request = await ensureRequest(root);
    let releases = 0;
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    const store = new Map<
      string,
      { labels: Readonly<Record<string, string>>; env: readonly string[]; owned: boolean }
    >();
    const ports: EnsureImagePorts = {
      get: async (reference) => {
        const stored = store.get(reference);
        if (stored === undefined) {
          return null;
        }
        return { reference, labels: stored.labels, env: stored.env, owned: stored.owned };
      },
      load: async () => {
        throw new Error("unused");
      },
      remove: async () => undefined,
      fakePublish: async (identity) => {
        releases += 1;
        await gate;
        const labels = buildImageOwnershipLabels(identity.digestHex);
        const envMap = buildImageOwnershipEnv(identity.digestHex);
        store.set(identity.nativeReference, {
          labels,
          env: Object.entries(envMap).map(([key, value]) => `${key}=${value}`),
          owned: true,
        });
      },
    };

    const controller = new AbortController();
    const abandoned = ensureImage(request, { signal: controller.signal }, ports);
    const kept = ensureImage(request, {}, ports);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ code: "cancellation" });
    resolveGate?.();
    const result = await kept;
    expect(result.built).toBe(true);
    expect(releases).toBe(1);
  });

  it("fails closed on mismatched ownership labels without adopting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-conflict-"));
    const host = new FakeHost();
    const client = createSboxClient({
      project: await dockerfileProject(root),
      host,
      ownsHost: false,
      configDirectory: root,
    });
    const built = await client.build({ profile: "built" });
    host.plantConflictingImage(built.reference, {
      "dev.sohcah.sbox/managed": "true",
      "dev.sohcah.sbox/image-identity":
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "dev.sohcah.sbox/image-algorithm": "1",
    });
    await expect(client.build({ profile: "built" })).rejects.toMatchObject({
      code: "ownership_conflict",
    });
    await expect(client.build({ profile: "built", force: true })).rejects.toMatchObject({
      code: "ownership_conflict",
    });
    await client[Symbol.asyncDispose]();
  });

  it("treats unlabelled images at the generated ref as ownership conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-unlabelled-"));
    const host = new FakeHost();
    const client = createSboxClient({
      project: await dockerfileProject(root),
      host,
      ownsHost: false,
      configDirectory: root,
    });
    const built = await client.build({ profile: "built" });
    host.plantConflictingImage(built.reference, {});
    expect(hasNoReservedImageEvidence({}, [])).toBe(true);
    expect(
      inspectImageOwnershipEvidence({}, [], built.contentIdentity.slice("sha256:".length)),
    ).toEqual({
      ok: false,
      reason: "Image ownership evidence is missing.",
    });
    await expect(client.build({ profile: "built" })).rejects.toMatchObject({
      code: "ownership_conflict",
    });
    await expect(client.build({ profile: "built", force: true })).rejects.toMatchObject({
      code: "ownership_conflict",
    });
    await expect(client.removeImage(built.reference)).rejects.toMatchObject({
      code: "ownership_conflict",
    });
    // Unlabelled plant remains — remove must not mutate it.
    const listed = await client.listImages({ includeUnowned: true });
    expect(listed.some((image) => image.reference === built.reference && !image.owned)).toBe(true);
    await client[Symbol.asyncDispose]();
  });

  it("accepts env-only ownership evidence when labels are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-env-own-"));
    const host = new FakeHost();
    const client = createSboxClient({
      project: await dockerfileProject(root),
      host,
      ownsHost: false,
      configDirectory: root,
    });
    const built = await client.build({ profile: "built" });
    const digestHex = built.contentIdentity.slice("sha256:".length);
    const envMap = buildImageOwnershipEnv(digestHex);
    // Replace owned image with env-only evidence (labels stripped, as on MSB 0.6.6 load).
    host.plantConflictingImage(
      built.reference,
      {},
      Object.entries(envMap).map(([key, value]) => `${key}=${value}`),
    );
    const again = await client.build({ profile: "built" });
    expect(again.reused).toBe(true);
    expect(again.reference).toBe(built.reference);
    expect(
      inspectImageOwnershipEvidence(
        {},
        Object.entries(envMap).map(([key, value]) => `${key}=${value}`),
        digestHex,
      ),
    ).toMatchObject({ ok: true, source: "env" });
    await client[Symbol.asyncDispose]();
  });

  it("refuses reuse, force, and remove when label and ENV evidence contradict", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-mixed-evidence-"));
    const host = new FakeHost();
    const client = createSboxClient({
      project: await dockerfileProject(root),
      host,
      ownsHost: false,
      configDirectory: root,
    });
    const built = await client.build({ profile: "built" });
    const digestHex = built.contentIdentity.slice("sha256:".length);
    const wrongLabels = buildImageOwnershipLabels("f".repeat(64));
    const matchingEnv = Object.entries(buildImageOwnershipEnv(digestHex)).map(
      ([key, value]) => `${key}=${value}`,
    );
    host.plantConflictingImage(built.reference, wrongLabels, matchingEnv);

    await expect(client.build({ profile: "built" })).rejects.toMatchObject({
      code: "ownership_conflict",
    });
    await expect(client.build({ profile: "built", force: true })).rejects.toMatchObject({
      code: "ownership_conflict",
    });
    await expect(client.removeImage(built.reference)).rejects.toMatchObject({
      code: "ownership_conflict",
    });
    const listed = await client.listImages({ includeUnowned: true });
    expect(listed.some((image) => image.reference === built.reference && !image.owned)).toBe(true);
    await client[Symbol.asyncDispose]();
  });

  it("propagates stamp-container cleanup failures without leaking identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-stamp-cleanup-"));
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const request = await ensureRequest(root);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sbox-ws-stamp-"));
    const store = new Map<string, Readonly<Record<string, string>>>();
    const secretCanary = "stamp-container-id-must-not-leak";

    const portsFor = (commitFails: boolean): EnsureImagePorts => ({
      get: async (reference) => {
        const labels = store.get(reference);
        if (labels === undefined) {
          return null;
        }
        return {
          reference,
          labels,
          env: [],
          owned: true,
          contentIdentity: `sha256:${reference.slice("sbox-img:sha256-".length)}`,
          algorithmVersion: 1,
        };
      },
      load: async (_archive, tag) => {
        const digestHex = tag.slice("sbox-img:sha256-".length);
        store.set(tag, buildImageOwnershipLabels(digestHex));
      },
      remove: async () => undefined,
      runCommand: async (cmd) => {
        if (cmd.args[0] === "create") {
          return { exitCode: 0, stdout: `${secretCanary}\n`, stderr: "" };
        }
        if (cmd.args[0] === "commit") {
          if (commitFails) {
            throw SboxError.nativeState("Docker commit failed while stamping ownership evidence.", {
              details: { phase: "stamp" },
            });
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd.args[0] === "rm") {
          throw SboxError.internal("Failed to remove temporary stamp container.", {
            details: { phase: "stamp", cleanupFailed: true },
          });
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      createWorkspace: async (wsRoot, signal) => createImageWorkspace(wsRoot, signal),
      cleanupWorkspace: async (path) => cleanupImageWorkspace(path),
      workspaceRoot,
    });

    const successCleanup = await ensureImage(request, {}, portsFor(false)).then(
      () => {
        throw new Error("expected cleanup failure");
      },
      (error: unknown) => error,
    );
    expect(successCleanup).toMatchObject({
      code: "internal",
      details: { cleanupFailed: true, phase: "stamp" },
    });
    expect(JSON.stringify(successCleanup)).not.toContain(secretCanary);

    clearEnsureImageCoalescing();
    store.clear();
    const failedCommit = await ensureImage(request, {}, portsFor(true)).then(
      () => {
        throw new Error("expected commit+cleanup failure");
      },
      (error: unknown) => error,
    );
    expect(failedCommit).toMatchObject({
      code: "native_state",
      details: { cleanupFailed: true },
    });
    expect(JSON.stringify(failedCommit)).not.toContain(secretCanary);
  });

  it("never removes a conflicting image after load verification failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-no-delete-"));
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const request = await ensureRequest(root);
    const removed: string[] = [];
    const store = new Map<
      string,
      { labels: Readonly<Record<string, string>>; env: readonly string[]; owned: boolean }
    >();

    const ports: EnsureImagePorts = {
      get: async (reference) => {
        const stored = store.get(reference);
        if (stored === undefined) {
          return null;
        }
        return { reference, labels: stored.labels, env: stored.env, owned: stored.owned };
      },
      load: async (_archive, tag) => {
        store.set(tag, { labels: {}, env: [], owned: false });
      },
      remove: async (reference) => {
        removed.push(reference);
        store.delete(reference);
      },
      runCommand: async (cmd) => {
        if (cmd.args[0] === "create") {
          return { exitCode: 0, stdout: "stamp-container\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      createWorkspace: async (workspaceRoot, signal) => createImageWorkspace(workspaceRoot, signal),
      cleanupWorkspace: async (path) => cleanupImageWorkspace(path),
      workspaceRoot: await mkdtemp(join(tmpdir(), "sbox-ws-")),
    };

    await expect(ensureImage(request, {}, ports)).rejects.toMatchObject({
      code: "capability",
      details: { unavailableReason: "image_ownership_evidence_unavailable" },
    });
    expect(removed).toEqual([]);
    expect(store.size).toBe(1);
  });

  it("propagates workspace cleanup failures after success and after primary failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cleanup-"));
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const request = await ensureRequest(root);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sbox-ws-clean-"));
    const store = new Map<string, Readonly<Record<string, string>>>();

    const buildPorts: EnsureImagePorts = {
      get: async (reference) => {
        const labels = store.get(reference);
        if (labels === undefined) {
          return null;
        }
        return {
          reference,
          labels,
          env: [],
          owned: true,
          contentIdentity: `sha256:${reference.slice("sbox-img:sha256-".length)}`,
          algorithmVersion: 1,
        };
      },
      load: async (_archive, tag) => {
        const digestHex = tag.slice("sbox-img:sha256-".length);
        store.set(tag, buildImageOwnershipLabels(digestHex));
      },
      remove: async () => undefined,
      runCommand: async (cmd) => {
        if (cmd.args[0] === "create") {
          return { exitCode: 0, stdout: "stamp-container\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      createWorkspace: async (wsRoot, signal) => createImageWorkspace(wsRoot, signal),
      cleanupWorkspace: async () => {
        throw new Error("cleanup boom");
      },
      workspaceRoot,
    };

    await expect(ensureImage(request, {}, buildPorts)).rejects.toMatchObject({
      code: "internal",
      details: { cleanupFailed: true },
    });

    clearEnsureImageCoalescing();
    store.clear();
    const failingBuild: EnsureImagePorts = {
      ...buildPorts,
      runCommand: async () => {
        throw SboxError.nativeState("Docker build failed.", { details: { phase: "docker" } });
      },
    };
    await expect(ensureImage(request, {}, failingBuild)).rejects.toMatchObject({
      code: "native_state",
      details: { cleanupFailed: true },
    });
  });

  it("emits phase-only progress and never surfaces secret canaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-secret-progress-"));
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const canary = "SECRET_CANARY_do_not_leak_7f3a";
    const request: HostEnsureImageRequest = {
      ...(await ensureRequest(root)),
      secrets: { npm: canary },
    };
    const events: string[] = [];
    const store = new Map<string, Readonly<Record<string, string>>>();
    const ports: EnsureImagePorts = {
      get: async (reference) => {
        const labels = store.get(reference);
        if (labels === undefined) {
          return null;
        }
        return { reference, labels, env: [], owned: true };
      },
      load: async () => undefined,
      remove: async () => undefined,
      fakePublish: async (identity) => {
        store.set(identity.nativeReference, buildImageOwnershipLabels(identity.digestHex));
      },
    };
    await ensureImage(
      request,
      {
        onProgress: (event) => {
          events.push(JSON.stringify(event));
        },
      },
      ports,
    );
    const joined = events.join("\n");
    expect(joined).not.toContain(canary);
    expect(events.every((line) => line.includes('"type":"phase"'))).toBe(true);
  });

  it("up ensures build-backed images only when the sandbox is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-up-build-"));
    const host = new FakeHost();
    const client = createSboxClient({
      project: await dockerfileProject(root),
      host,
      ownsHost: false,
      configDirectory: root,
    });
    const handle = await client.up({ profile: "built" });
    const inspection = await handle.inspect();
    expect(inspection.creation.image).toMatch(/^sbox-img:sha256-/);
    expect(host.operations).toContain("ensureImage");
    expect(host.operations).toContain("create");

    const ensureCount = host.operations.filter((op) => op === "ensureImage").length;
    await handle.stop();
    host.operations.length = 0;
    const again = await client.up({ profile: "built" });
    expect((await again.inspect()).state).toBe("running");
    expect(host.operations).not.toContain("ensureImage");
    expect(host.operations).toContain("get");
    expect(host.operations).toContain("start");
    expect(ensureCount).toBeGreaterThanOrEqual(1);
    await client[Symbol.asyncDispose]();
  });

  it("lists stale workspaces without mutating them", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-stale-"));
    const workspace = await createImageWorkspace(root);
    const before = await listStaleImageWorkspaces(root);
    expect(before.some((entry) => entry.path === workspace.root && entry.markerPresent)).toBe(true);
    const after = await listStaleImageWorkspaces(root);
    expect(after).toEqual(before);
    await cleanupImageWorkspace(workspace.root);
  });

  it("uses host platform for identity", () => {
    expect(hostDockerPlatform("arm64")).toBe("linux/arm64");
    expect(hostDockerPlatform("x64")).toBe("linux/amd64");
    expect(formatNativeImageReference("a".repeat(64))).toContain("sbox-img:sha256-");
  });

  it("client image ensure uses Host capabilities dockerPlatform, not Client arch defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-host-plat-"));
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const project = await dockerfileProject(root);
    const localPlatform = hostDockerPlatform();
    const otherPlatform = localPlatform === "linux/amd64" ? "linux/arm64" : "linux/amd64";

    const localHost = new FakeHost({ dockerPlatform: localPlatform });
    const otherHost = new FakeHost({ dockerPlatform: otherPlatform });
    const localClient = createSboxClient({
      project,
      host: localHost,
      ownsHost: false,
      configDirectory: root,
    });
    const otherClient = createSboxClient({
      project,
      host: otherHost,
      ownsHost: false,
      configDirectory: root,
    });

    const localImage = await localClient.build({ profile: "built" });
    const otherImage = await otherClient.build({ profile: "built" });
    expect(localImage.reference).not.toBe(otherImage.reference);
    expect(localHost.operations).toContain("capabilities");
    expect(otherHost.operations).toContain("capabilities");

    await localClient[Symbol.asyncDispose]();
    await otherClient[Symbol.asyncDispose]();
  });

  it("LocalHost-style ensureImage ignores caller-supplied platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-plat-override-"));
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const host = new FakeHost({ dockerPlatform: "linux/amd64" });
    const base = await ensureRequest(root);
    const wrong = await host.ensureImage({ ...base, platform: "linux/arm64" });
    const right = await host.ensureImage({ ...base, platform: "linux/amd64" });
    expect(wrong.reference).toBe(right.reference);
  });

  it("isolates throwing progress subscribers during coalesced builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-progress-throw-"));
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const request = await ensureRequest(root);
    const recorded: string[] = [];
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const store = new Map<
      string,
      { labels: Readonly<Record<string, string>>; env: readonly string[]; owned: boolean }
    >();
    const ports: EnsureImagePorts = {
      get: async (reference) => {
        const stored = store.get(reference);
        if (stored === undefined) {
          return null;
        }
        return { reference, labels: stored.labels, env: stored.env, owned: stored.owned };
      },
      load: async () => {
        throw new Error("unused");
      },
      remove: async () => undefined,
      fakePublish: async (identity) => {
        await gate;
        const labels = buildImageOwnershipLabels(identity.digestHex);
        const envMap = buildImageOwnershipEnv(identity.digestHex);
        store.set(identity.nativeReference, {
          labels,
          env: Object.entries(envMap).map(([key, value]) => `${key}=${value}`),
          owned: true,
        });
      },
    };

    const throwing = ensureImage(
      request,
      {
        onProgress: () => {
          throw new Error("observer boom");
        },
      },
      ports,
    );
    const recording = ensureImage(
      request,
      {
        onProgress: (event) => {
          if (event.type === "phase") {
            recorded.push(event.phase);
          }
        },
      },
      ports,
    );
    resolveGate?.();
    const [a, b] = await Promise.all([throwing, recording]);
    expect(a.reference).toBe(b.reference);
    expect(recorded.length).toBeGreaterThan(0);
  });

  it("applies timeout per subscriber without aborting longer coalesced waiters", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-timeout-coalesce-"));
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.20\n");
    const request = await ensureRequest(root);
    let releases = 0;
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const store = new Map<
      string,
      { labels: Readonly<Record<string, string>>; env: readonly string[]; owned: boolean }
    >();
    const ports: EnsureImagePorts = {
      get: async (reference) => {
        const stored = store.get(reference);
        if (stored === undefined) {
          return null;
        }
        return { reference, labels: stored.labels, env: stored.env, owned: stored.owned };
      },
      load: async () => {
        throw new Error("unused");
      },
      remove: async () => undefined,
      fakePublish: async (identity) => {
        releases += 1;
        await gate;
        const labels = buildImageOwnershipLabels(identity.digestHex);
        const envMap = buildImageOwnershipEnv(identity.digestHex);
        store.set(identity.nativeReference, {
          labels,
          env: Object.entries(envMap).map(([key, value]) => `${key}=${value}`),
          owned: true,
        });
      },
    };

    const shortWait = ensureImage(request, { timeoutMs: 30 }, ports);
    const longWait = ensureImage(request, { timeoutMs: 5_000 }, ports);
    await expect(shortWait).rejects.toMatchObject({ code: "timeout" });
    resolveGate?.();
    const result = await longWait;
    expect(result.built).toBe(true);
    expect(releases).toBe(1);
  });
});
