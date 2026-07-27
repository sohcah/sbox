import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  immutableCreationEquals,
  projectCreateRequest,
  PHASE1_DEFAULT_CPUS,
  PHASE1_DEFAULT_MEMORY_MIB,
} from "../src/immutable-creation.js";
import { nativeRecordMatchesCreation } from "../src/ownership-adoption.js";
import { decodeSandboxConfig } from "../src/sandbox-config.js";
import { defaultNetworkConfig } from "../src/network/types.js";
import { collectDecodableRecordsFromHandles } from "../src/microsandbox-runtime.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/sandbox-config-0.6.6.json",
);

describe("decodeSandboxConfig (microsandbox@0.6.6)", () => {
  it("decodes an actual builder.build() fixture", async () => {
    const raw = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const decoded = decodeSandboxConfig(raw);
    expect(decoded.image).toBe("alpine:3.20");
    expect(decoded.cpus).toBe(1);
    expect(decoded.memoryMiB).toBe(512);
    expect(decoded.workdir).toBe("/work");
    expect(decoded.user).toBe("root");
    expect(decoded.shell).toBe("/bin/sh");
    expect(decoded.hostname).toBe("probe");
    expect(decoded.maxDurationSecs).toBeNull();
    expect(decoded.idleTimeoutSecs).toBeNull();
    expect(decoded.env).toEqual({ FOO: "bar" });
    expect(decoded.labels).toMatchObject({
      "dev.sohcah.sbox/managed": "true",
      "dev.sohcah.sbox/project": "demo",
      "dev.sohcah.sbox/instance": "main",
      "dev.sohcah.sbox/profile": "default",
    });
    expect(decoded.network).toEqual({
      mode: "default-deny",
      allow: [],
      publish: [],
    });
    expect(decoded.secrets).toEqual([]);
  });

  it("rejects flattened speculative shapes", () => {
    expect(() =>
      decodeSandboxConfig({
        image: "alpine:3.20",
        cpus: 1,
        memory: 512,
      }),
    ).toThrow(/SandboxConfig\.image must be an object/);
  });

  it("fails closed when enabled networking has no deny/deny policy", async () => {
    const raw = JSON.parse(await readFile(fixturePath, "utf8")) as {
      network: Record<string, unknown>;
    };
    raw.network = { enabled: true, ports: [] };
    expect(() => decodeSandboxConfig(raw)).toThrow(/policy is required/);
  });

  it("list decoding skips unrestricted sandboxes beside owned deny-policy ones", async () => {
    const owned = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const unrestricted = {
      ...owned,
      name: "foreign-unrestricted",
      network: { enabled: true, ports: [] },
      labels: { "other/managed": "true" },
    };
    const handles = [
      {
        name: "owned",
        status: "stopped",
        createdAt: null,
        updatedAt: null,
        config: () => owned,
      },
      {
        name: "foreign-unrestricted",
        status: "stopped",
        createdAt: null,
        updatedAt: null,
        config: () => unrestricted,
      },
    ];
    const records = collectDecodableRecordsFromHandles(handles);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("owned");
    expect(records[0]?.network.mode).toBe("default-deny");
  });

  it("list decoding surfaces undecodable managed sandboxes instead of hiding them", async () => {
    const owned = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const managedBroken = {
      ...owned,
      name: "managed-broken",
      network: { enabled: true, ports: [] },
      // Keep sbox managed marker so the skip path must not swallow this.
    };
    const foreignBroken = {
      ...owned,
      name: "foreign-broken",
      network: { enabled: true, ports: [] },
      labels: { "other/managed": "true" },
    };
    expect(() =>
      collectDecodableRecordsFromHandles([
        {
          name: "foreign-broken",
          status: "stopped",
          createdAt: null,
          updatedAt: null,
          config: () => foreignBroken,
        },
        {
          name: "managed-broken",
          status: "stopped",
          createdAt: null,
          updatedAt: null,
          config: () => managedBroken,
        },
      ]),
    ).toThrow(/Managed sandbox managed-broken/);
  });
});

describe("immutable creation projection", () => {
  it("resolves omitted fields to native defaults", () => {
    const projected = projectCreateRequest({ image: "alpine:3.20" });
    expect(projected).toEqual({
      image: "alpine:3.20",
      cpus: PHASE1_DEFAULT_CPUS,
      memoryMiB: PHASE1_DEFAULT_MEMORY_MIB,
      workdir: null,
      user: null,
      shell: null,
      hostname: null,
      maxDurationSecs: null,
      idleTimeoutSecs: null,
      env: {},
      network: {
        mode: "default-deny",
        allow: [],
        publish: [],
      },
      secrets: [],
      volumes: [],
      mounts: [],
    });
  });

  it("treats omitted request fields as defaults, not wildcards", () => {
    const request = projectCreateRequest({ image: "alpine:3.20" });
    const nativeWithNonDefaultUser = projectCreateRequest({
      image: "alpine:3.20",
      user: "root",
    });
    expect(immutableCreationEquals(request, nativeWithNonDefaultUser)).toBe(false);

    const nativeWithExtraEnv = projectCreateRequest({
      image: "alpine:3.20",
      env: { A: "1" },
    });
    expect(immutableCreationEquals(request, nativeWithExtraEnv)).toBe(false);

    const nativeWithDifferentCpus = projectCreateRequest({
      image: "alpine:3.20",
      cpus: 2,
    });
    expect(immutableCreationEquals(request, nativeWithDifferentCpus)).toBe(false);
  });

  it("matches equal projections including env", () => {
    const left = projectCreateRequest({
      image: "alpine:3.20",
      cpus: 2,
      memoryMiB: 1024,
      workdir: "/w",
      user: "root",
      shell: "/bin/bash",
      hostname: "box",
      env: { B: "2", A: "1" },
    });
    const right = projectCreateRequest({
      image: "alpine:3.20",
      cpus: 2,
      memoryMiB: 1024,
      workdir: "/w",
      user: "root",
      shell: "/bin/bash",
      hostname: "box",
      env: { A: "1", B: "2" },
    });
    expect(immutableCreationEquals(left, right)).toBe(true);
  });

  it("matches decoded native records while allowing documented SDK PATH injection", () => {
    const requested = projectCreateRequest({
      image: "alpine:3.20",
      env: { A: "1" },
    });
    expect(
      nativeRecordMatchesCreation(
        {
          image: "alpine:3.20",
          cpus: PHASE1_DEFAULT_CPUS,
          memoryMiB: PHASE1_DEFAULT_MEMORY_MIB,
          workdir: null,
          user: null,
          shell: null,
          hostname: null,
          maxDurationSecs: null,
          idleTimeoutSecs: null,
          env: { A: "1", PATH: "/usr/bin" },
          network: defaultNetworkConfig(),
          secrets: [],
          volumes: [],
          mounts: [],
          bindMounts: [],
        },
        requested,
      ),
    ).toBe(true);
    expect(
      nativeRecordMatchesCreation(
        {
          image: "alpine:3.20",
          cpus: PHASE1_DEFAULT_CPUS,
          memoryMiB: PHASE1_DEFAULT_MEMORY_MIB,
          workdir: null,
          user: null,
          shell: null,
          hostname: null,
          maxDurationSecs: null,
          idleTimeoutSecs: null,
          env: { A: "1", EXTRA: "nope" },
          network: defaultNetworkConfig(),
          secrets: [],
          volumes: [],
          mounts: [],
          bindMounts: [],
        },
        requested,
      ),
    ).toBe(false);
    expect(
      nativeRecordMatchesCreation(
        {
          image: "debian:12",
          cpus: PHASE1_DEFAULT_CPUS,
          memoryMiB: PHASE1_DEFAULT_MEMORY_MIB,
          workdir: null,
          user: null,
          shell: null,
          hostname: null,
          maxDurationSecs: null,
          idleTimeoutSecs: null,
          env: { A: "1" },
          network: defaultNetworkConfig(),
          secrets: [],
          volumes: [],
          mounts: [],
          bindMounts: [],
        },
        requested,
      ),
    ).toBe(false);
  });
});
