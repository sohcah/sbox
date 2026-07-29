import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSboxClient,
  defaultNetworkConfig,
  parseProjectConfig,
  parseYamlProjectInput,
  SboxError,
  SECRET_LOG_CANARY_KEYS,
  toSafeProjectConfig,
  createRedactingLogger,
  collectingLogger,
  assertSandboxIdentity,
} from "../src/index.js";
import { FakeHost } from "../src/fake-host.js";
import { canonicalNetworkFingerprint, compileDefaultDenyPolicy } from "../src/network/compile.js";
import { decodeNetworkEvidence, hostNetworkFromEvidence } from "../src/network/decode.js";
import { resolveCreateIntent } from "../src/client/resolve-intent.js";
import { validateHostNetworkConfig } from "../src/network/validate.js";
import { immutableCreationDriftFields, projectCreateRequest } from "../src/immutable-creation.js";
import { nativeRecordMatchesCreation } from "../src/ownership-adoption.js";
import type { HostNetworkConfig } from "../src/network/types.js";

const CANARY = "network-secret-canary-VALUE-9f2c";
const networkFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/sandbox-config-network-0.6.6.json",
);

describe("network config validation", () => {
  it("accepts domain/suffix/ip/cidr with ports and protocols", () => {
    const issues = validateHostNetworkConfig({
      mode: "default-deny",
      allow: [
        { kind: "domain", domain: "example.com" },
        { kind: "suffix", suffix: ".github.com" },
        { kind: "ip", ip: "1.2.3.4", ports: [443], protocols: ["tcp"] },
        {
          kind: "cidr",
          cidr: "10.0.0.0/8",
          ports: [{ start: 8000, end: 8010 }],
          protocols: ["udp"],
        },
      ],
      publish: [{ guest: 8080, host: 18080, protocol: "tcp", bind: "127.0.0.1" }],
    });
    expect(issues).toEqual([]);
  });

  it("rejects disabled mode with allow or publish", () => {
    const allowIssues = validateHostNetworkConfig({
      mode: "disabled",
      allow: [{ kind: "domain", domain: "example.com" }],
      publish: [],
    });
    expect(allowIssues.some((issue) => issue.path.includes("allow"))).toBe(true);

    const publishIssues = validateHostNetworkConfig({
      mode: "disabled",
      allow: [],
      publish: [{ guest: 80 }],
    });
    expect(publishIssues.some((issue) => issue.path.includes("publish"))).toBe(true);
  });

  it("parses YAML network and runtime secrets into typed profiles", () => {
    const config = parseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          network: {
            mode: "default-deny",
            allow: [{ domain: "registry.npmjs.org" }, { suffix: "github.com" }],
            publish: [{ guest: 8080 }],
          },
          secrets: [
            {
              env: "API_TOKEN",
              value: { env: "API_TOKEN" },
              destinations: ["api.example.com", "*.example.com"],
            },
          ],
        },
      },
    });
    const profile = config.profiles["default"]!;
    expect(profile.network?.mode).toBe("default-deny");
    expect(profile.network?.allow).toEqual([
      { kind: "domain", domain: "registry.npmjs.org" },
      { kind: "suffix", suffix: "github.com" },
    ]);
    expect(profile.secrets?.[0]?.env).toBe("API_TOKEN");
    expect(profile.secrets?.[0]?.destinations).toContain("*.example.com");

    const safe = toSafeProjectConfig(config);
    const blob = JSON.stringify(safe);
    expect(blob).not.toContain(CANARY);
    expect(safe.profiles["default"]?.secrets?.[0]).toMatchObject({
      env: "API_TOKEN",
      destinations: ["api.example.com", "*.example.com"],
    });
    expect(safe.profiles["default"]?.secrets?.[0]).not.toHaveProperty("value");
  });
});

describe("network policy compile", () => {
  it("builds default-deny with DNS, loopback, and curated allow rules", () => {
    const policy = compileDefaultDenyPolicy({
      mode: "default-deny",
      allow: [
        { kind: "domain", domain: "example.com" },
        { kind: "ip", ip: "8.8.8.8", ports: [53], protocols: ["udp"] },
      ],
      publish: [{ guest: 8080, host: 18080 }],
    }) as {
      defaultEgress: string;
      defaultIngress: string;
      rules: readonly {
        direction: string;
        destination: Record<string, unknown>;
        protocols: readonly string[];
        ports: readonly { start: number; end: number }[];
        action: string;
      }[];
    };

    expect(policy.defaultEgress).toBe("deny");
    expect(policy.defaultIngress).toBe("deny");
    expect(policy.rules.some((rule) => rule.destination["group"] === "host")).toBe(true);
    expect(policy.rules.some((rule) => rule.destination["group"] === "loopback")).toBe(true);
    expect(
      policy.rules.some(
        (rule) =>
          rule.direction === "egress" &&
          rule.destination["domain"] === "example.com" &&
          rule.protocols.includes("tcp") &&
          rule.ports.some((port) => port.start === 80) &&
          rule.ports.some((port) => port.start === 443),
      ),
    ).toBe(true);
    expect(
      policy.rules.some(
        (rule) =>
          rule.direction === "ingress" &&
          rule.action === "allow" &&
          rule.ports.some((port) => port.start === 8080),
      ),
    ).toBe(true);
  });
});

describe("network decode and fingerprint round-trip", () => {
  const requested: HostNetworkConfig = {
    mode: "default-deny",
    allow: [
      { kind: "domain", domain: "example.com" },
      { kind: "ip", ip: "1.2.3.4" },
      { kind: "cidr", cidr: "10.0.0.0/8", protocols: ["tcp"], ports: [443] },
      { kind: "suffix", suffix: "github.com", ports: [443], protocols: ["tcp"] },
    ],
    publish: [{ guest: 8080, host: 18080, protocol: "tcp", bind: "127.0.0.1" }],
  };

  it("decodes the real network-configured sandbox fixture", async () => {
    const raw = JSON.parse(await readFile(networkFixturePath, "utf8")) as unknown;
    const evidence = decodeNetworkEvidence(raw);
    expect(evidence.mode).toBe("default-deny");
    expect(evidence.publish).toEqual([
      { guest: 8080, host: 18080, protocol: "tcp", bind: "127.0.0.1" },
    ]);
    expect(evidence.secrets).toEqual([
      {
        env: "API_TOKEN",
        placeholder: "{{API_TOKEN}}",
        destinations: ["api.example.com", "*.example.com"],
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("canary");
    expect(JSON.stringify(evidence)).not.toContain("[REDACTED]");
  });

  it("keeps compile→decode fingerprints equal for multi-protocol IP rules", async () => {
    const raw = JSON.parse(await readFile(networkFixturePath, "utf8")) as unknown;
    const decoded = hostNetworkFromEvidence(decodeNetworkEvidence(raw));
    expect(canonicalNetworkFingerprint(decoded)).toEqual(canonicalNetworkFingerprint(requested));
  });

  it("does not report network drift for IP rules without explicit protocols", () => {
    const expected = projectCreateRequest({
      image: "alpine:3.20",
      network: {
        mode: "default-deny",
        allow: [{ kind: "ip", ip: "1.2.3.4" }],
        publish: [],
      },
    });
    const actual = projectCreateRequest({
      image: "alpine:3.20",
      network: {
        mode: "default-deny",
        allow: [
          { kind: "ip", ip: "1.2.3.4", protocols: ["tcp"] },
          { kind: "ip", ip: "1.2.3.4", protocols: ["udp"] },
        ],
        publish: [],
      },
    });
    expect(immutableCreationDriftFields(expected, actual)).not.toContain("network");
    expect(
      nativeRecordMatchesCreation(
        {
          image: actual.image,
          cpus: actual.cpus,
          memoryMiB: actual.memoryMiB,
          tmpMiB: actual.tmpMiB,
          workdir: actual.workdir,
          user: actual.user,
          shell: actual.shell,
          hostname: actual.hostname,
          env: actual.env,
          maxDurationSecs: actual.maxDurationSecs,
          idleTimeoutSecs: actual.idleTimeoutSecs,
          network: actual.network,
          secrets: actual.secrets,
          volumes: actual.volumes,
          mounts: actual.mounts,
          bindMounts: [],
        },
        expected,
      ),
    ).toBe(true);
  });

  it("does not report network drift for mixed single and range ports", () => {
    const expected = projectCreateRequest({
      image: "alpine:3.20",
      network: {
        mode: "default-deny",
        allow: [
          {
            kind: "domain",
            domain: "example.com",
            protocols: ["tcp"],
            ports: [80, { start: 8000, end: 8010 }],
          },
        ],
        publish: [],
      },
    });
    const actual = projectCreateRequest({
      image: "alpine:3.20",
      network: {
        mode: "default-deny",
        allow: [
          {
            kind: "domain",
            domain: "example.com",
            protocols: ["tcp"],
            // Native may reorder range-before-single; fingerprint sorts by start.
            ports: [{ start: 8000, end: 8010 }, 80],
          },
        ],
        publish: [],
      },
    });
    expect(immutableCreationDriftFields(expected, actual)).not.toContain("network");
    expect(canonicalNetworkFingerprint(expected.network)).toEqual(
      canonicalNetworkFingerprint(actual.network),
    );
  });

  it("fails closed for enabled networking without deny defaults", () => {
    expect(() =>
      decodeNetworkEvidence({
        network: { enabled: true, ports: [] },
      }),
    ).toThrow(/policy is required/);
    expect(() =>
      decodeNetworkEvidence({
        network: {
          enabled: true,
          policy: { defaultEgress: "allow", defaultIngress: "allow", rules: [] },
          ports: [],
        },
      }),
    ).toThrow(/deny\/deny/);
  });

  it("clears publish when decoding disabled networking", () => {
    const evidence = decodeNetworkEvidence({
      network: {
        enabled: false,
        ports: [{ guestPort: 8080, hostPort: 18080, protocol: "tcp", hostBind: "127.0.0.1" }],
        secrets: { secrets: [] },
      },
    });
    expect(evidence.mode).toBe("disabled");
    expect(evidence.publish).toEqual([]);
  });

  it("rejects invalid IPv6-shaped addresses at validation time", () => {
    const issues = validateHostNetworkConfig({
      mode: "default-deny",
      allow: [{ kind: "ip", ip: ":::::" }],
      publish: [],
    });
    expect(issues.some((issue) => issue.path.includes("ip"))).toBe(true);
  });
});

describe("resolveCreateIntent network and secrets", () => {
  it("defaults omitted network to default-deny and resolves secret values", async () => {
    const project = parseProjectConfig({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          secrets: [
            {
              env: "API_TOKEN",
              value: { env: "API_TOKEN" },
              destinations: ["api.example.com"],
            },
          ],
        },
      },
    });
    const intent = await resolveCreateIntent({
      project,
      external: {
        configDirectory: "/tmp",
        env: { API_TOKEN: CANARY },
        invocation: {},
      },
    });
    expect(intent.request.network ?? defaultNetworkConfig()).toMatchObject({
      mode: "default-deny",
      allow: [],
      publish: [],
    });
    expect(intent.request.secrets).toEqual([
      {
        env: "API_TOKEN",
        value: CANARY,
        placeholder: "{{API_TOKEN}}",
        destinations: ["api.example.com"],
      },
    ]);
    expect(intent.projected.secrets[0]).not.toHaveProperty("value");
    expect(JSON.stringify(intent.projected)).not.toContain(CANARY);
  });

  it("rejects invocation allow overrides when profile network is disabled", async () => {
    const project = parseProjectConfig({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          network: { mode: "disabled", allow: [], publish: [] },
        },
      },
    });
    await expect(
      resolveCreateIntent({
        project,
        networkAllow: [{ kind: "domain", domain: "example.com" }],
        external: { configDirectory: "/tmp", env: {}, invocation: {} },
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("does not grant network access from secret destinations", async () => {
    const project = parseProjectConfig({
      version: 1,
      project: "demo",
      profiles: {
        default: {
          image: "alpine:3.20",
          secrets: [
            {
              env: "API_TOKEN",
              value: { env: "API_TOKEN" },
              destinations: ["secret-only.example.com"],
            },
          ],
        },
      },
    });
    const intent = await resolveCreateIntent({
      project,
      external: {
        configDirectory: "/tmp",
        env: { API_TOKEN: CANARY },
        invocation: {},
      },
    });
    expect(intent.request.network?.allow ?? []).toEqual([]);
    expect(intent.request.secrets?.[0]?.destinations).toEqual(["secret-only.example.com"]);
  });
});

describe("FakeHost network create and inspection", () => {
  it("allocates dynamic host ports and keeps secret values out of inspection/logs/JSON", async () => {
    const collected = collectingLogger();
    const host = new FakeHost({ logger: createRedactingLogger(collected.logger) });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "default",
    });

    const inspection = await host.create({
      identity,
      image: "alpine:3.20",
      network: {
        mode: "default-deny",
        allow: [{ kind: "domain", domain: "example.com" }],
        publish: [{ guest: 8080 }],
      },
      secrets: [
        {
          env: "API_TOKEN",
          value: CANARY,
          placeholder: "{{API_TOKEN}}",
          destinations: ["api.example.com"],
        },
      ],
    });

    expect(inspection.creation.network.mode).toBe("default-deny");
    expect(inspection.creation.network.publish[0]?.guest).toBe(8080);
    expect(inspection.creation.network.publish[0]?.host).toBeGreaterThanOrEqual(40000);
    expect(inspection.creation.secrets[0]).toEqual({
      env: "API_TOKEN",
      placeholder: "{{API_TOKEN}}",
      destinations: ["api.example.com"],
    });

    const blob = JSON.stringify(inspection);
    expect(blob).not.toContain(CANARY);
    for (const key of SECRET_LOG_CANARY_KEYS) {
      expect(blob).not.toMatch(new RegExp(`"${key}"\\s*:\\s*"${CANARY}"`));
    }
    expect(JSON.stringify(collected.events)).not.toContain(CANARY);

    const caps = await host.capabilities();
    expect(caps.dynamicHostPorts).toBe(true);

    await host[Symbol.asyncDispose]();
  });

  it("rejects disabled network with publish via Host validation", async () => {
    const host = new FakeHost();
    await expect(
      host.create({
        identity: assertSandboxIdentity({
          project: "demo",
          profile: "default",
          instance: "default",
        }),
        image: "alpine:3.20",
        network: {
          mode: "disabled",
          allow: [],
          publish: [{ guest: 8080, host: 18080 }],
        },
      }),
    ).rejects.toBeInstanceOf(SboxError);
    await host[Symbol.asyncDispose]();
  });

  it("rejects dynamic host ports when the Host does not advertise them", async () => {
    const host = new FakeHost();
    host.dynamicHostPorts = false;
    await expect(
      host.create({
        identity: assertSandboxIdentity({
          project: "demo",
          profile: "default",
          instance: "default",
        }),
        image: "alpine:3.20",
        network: {
          mode: "default-deny",
          allow: [],
          publish: [{ guest: 8080 }],
        },
      }),
    ).rejects.toMatchObject({ code: "capability" });
    await host[Symbol.asyncDispose]();
  });
});

describe("client create with network overrides", () => {
  it("merges invocation networkAllow into create request", async () => {
    const host = new FakeHost();
    const client = createSboxClient({
      project: {
        version: 1,
        project: "demo",
        profiles: {
          default: {
            image: "alpine:3.20",
            network: {
              mode: "default-deny",
              allow: [{ kind: "domain", domain: "a.example.com" }],
              publish: [],
            },
          },
        },
      },
      host,
      ownsHost: true,
    });

    await client.create({
      networkAllow: [{ domain: "b.example.com" }],
    });
    const inspection = await client.inspect({ profile: "default" });
    const domains = inspection.creation.network.allow
      .filter((rule) => rule.kind === "domain")
      .map((rule) => rule.domain);
    expect(domains).toEqual(["a.example.com", "b.example.com"]);
    await client[Symbol.asyncDispose]();
  });
});
