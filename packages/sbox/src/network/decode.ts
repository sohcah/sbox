/**
 * Decode network / published ports / secret metadata from pinned SandboxConfig.
 */

import {
  DEFAULT_NETWORK_BIND,
  type HostNetworkConfig,
  type InspectedPublishedPort,
  type NetworkAllowRule,
  type NetworkMode,
  type NetworkPortSpec,
  type NetworkProtocol,
  type SafeRuntimeSecret,
} from "./types.js";
import { normalizeSuffix } from "./validate.js";

export interface DecodedNetworkEvidence {
  readonly mode: NetworkMode;
  readonly allow: readonly NetworkAllowRule[];
  readonly publish: readonly InspectedPublishedPort[];
  readonly secrets: readonly SafeRuntimeSecret[];
}

/**
 * Decode network evidence from native sandbox config.
 *
 * Fail closed: an enabled network without deny/deny policy defaults is rejected
 * rather than reported as default-deny. Missing network is treated as
 * default-deny only when the sandbox predates network attachment (absent key).
 */
export function decodeNetworkEvidence(config: unknown): DecodedNetworkEvidence {
  if (config === null || typeof config !== "object") {
    return emptyDefaultDeny();
  }
  const root = config as Record<string, unknown>;
  const network = root["network"];
  if (network === undefined || network === null) {
    return emptyDefaultDeny();
  }
  if (typeof network !== "object" || Array.isArray(network)) {
    throw new Error("SandboxConfig.network must be an object.");
  }
  const record = network as Record<string, unknown>;
  const enabled = record["enabled"];
  if (enabled === false) {
    return {
      mode: "disabled",
      allow: Object.freeze([]),
      // Disabled mode rejects publish at create time; ignore residual native ports.
      publish: Object.freeze([]),
      secrets: decodeSecrets(record["secrets"]),
    };
  }

  const policy = record["policy"];
  assertDefaultDenyPolicy(policy);

  return {
    mode: "default-deny",
    allow: decodeAllowRulesFromPolicy(policy),
    publish: decodePublishedPorts(record["ports"]),
    secrets: decodeSecrets(record["secrets"]),
  };
}

export function hostNetworkFromEvidence(evidence: DecodedNetworkEvidence): HostNetworkConfig {
  return Object.freeze({
    mode: evidence.mode,
    allow: evidence.allow,
    publish: Object.freeze(
      evidence.publish.map((port) =>
        Object.freeze({
          guest: port.guest,
          host: port.host,
          protocol: port.protocol,
          bind: port.bind,
        }),
      ),
    ),
  });
}

/**
 * Require an explicit deny/deny policy. Missing or non-deny defaults fail closed
 * so unrestricted sandboxes are never reported as default-deny.
 */
export function assertDefaultDenyPolicy(policy: unknown): void {
  if (policy === undefined || policy === null) {
    throw new Error(
      "SandboxConfig.network.policy is required when networking is enabled; refusing to treat a missing policy as default-deny.",
    );
  }
  if (typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("SandboxConfig.network.policy must be an object.");
  }
  const record = policy as Record<string, unknown>;
  const egress = record["defaultEgress"];
  const ingress = record["defaultIngress"];
  if (egress !== "deny" || ingress !== "deny") {
    throw new Error(
      `SandboxConfig.network.policy defaults must be deny/deny (got egress=${String(egress)} ingress=${String(ingress)}).`,
    );
  }
}

function emptyDefaultDeny(): DecodedNetworkEvidence {
  return {
    mode: "default-deny",
    allow: Object.freeze([]),
    publish: Object.freeze([]),
    secrets: Object.freeze([]),
  };
}

function decodePublishedPorts(raw: unknown): readonly InspectedPublishedPort[] {
  if (raw === undefined || raw === null) {
    return Object.freeze([]);
  }
  if (!Array.isArray(raw)) {
    throw new Error("SandboxConfig.network.ports must be an array.");
  }
  const out: InspectedPublishedPort[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      throw new Error("Published port entries must be objects.");
    }
    const record = entry as Record<string, unknown>;
    const guest = requirePort(record["guestPort"] ?? record["guest"], "guestPort");
    const host = requireNonNegativePort(record["hostPort"] ?? record["host"], "hostPort");
    const protocol = requireProtocol(record["protocol"]);
    const bind =
      typeof record["hostBind"] === "string"
        ? record["hostBind"]
        : typeof record["bind"] === "string"
          ? record["bind"]
          : DEFAULT_NETWORK_BIND;
    out.push(Object.freeze({ guest, host, protocol, bind }));
  }
  return Object.freeze(out);
}

function decodeSecrets(raw: unknown): readonly SafeRuntimeSecret[] {
  if (raw === undefined || raw === null) {
    return Object.freeze([]);
  }
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)["secrets"])
      ? ((raw as Record<string, unknown>)["secrets"] as unknown[])
      : null;
  if (list === null) {
    throw new Error("SandboxConfig.network.secrets must be an array or { secrets: [] }.");
  }
  const out: SafeRuntimeSecret[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") {
      throw new Error("Secret entries must be objects.");
    }
    const record = entry as Record<string, unknown>;
    const env = record["envVar"] ?? record["env"];
    if (typeof env !== "string" || env.length === 0) {
      throw new Error("Secret envVar must be a non-empty string.");
    }
    const placeholder =
      typeof record["placeholder"] === "string" && record["placeholder"].length > 0
        ? record["placeholder"]
        : `{{${env}}}`;
    const destinations = decodeSecretDestinations(record["allowedHosts"]);
    out.push(
      Object.freeze({
        env,
        placeholder,
        destinations: Object.freeze(destinations),
      }),
    );
  }
  return Object.freeze(out);
}

function decodeSecretDestinations(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("Secret allowedHosts must be an array.");
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (entry === null || typeof entry !== "object") {
      throw new Error("Secret allowedHosts entries must be strings or objects.");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record["exact"] === "string") {
      out.push(record["exact"]);
    } else if (typeof record["wildcard"] === "string") {
      out.push(record["wildcard"]);
    } else if (typeof record["pattern"] === "string") {
      out.push(record["pattern"]);
    } else {
      throw new Error("Secret allowedHosts entry must include exact or wildcard.");
    }
  }
  return out;
}

function decodeAllowRulesFromPolicy(policy: unknown): readonly NetworkAllowRule[] {
  if (policy === null || typeof policy !== "object") {
    throw new Error("SandboxConfig.network.policy must be an object.");
  }
  const record = policy as Record<string, unknown>;
  const rules = record["rules"];
  if (rules === undefined || rules === null) {
    return Object.freeze([]);
  }
  if (!Array.isArray(rules)) {
    throw new Error("SandboxConfig.network.policy.rules must be an array.");
  }
  const out: NetworkAllowRule[] = [];
  for (const rule of rules) {
    const decoded = tryDecodeUserAllowRule(rule);
    if (decoded !== undefined) {
      out.push(decoded);
    }
  }
  return Object.freeze(out);
}

/**
 * Map native egress allow rules back to curated allow rules.
 * Skips automatic DNS/loopback mechanics and published-port ingress.
 * Emits one curated rule per native rule (already per-protocol from compile).
 */
function tryDecodeUserAllowRule(rule: unknown): NetworkAllowRule | undefined {
  if (rule === null || typeof rule !== "object") {
    return undefined;
  }
  const record = rule as Record<string, unknown>;
  if (record["direction"] !== "egress" || record["action"] !== "allow") {
    return undefined;
  }
  const destination = record["destination"];
  if (destination === null || typeof destination !== "object") {
    // Native may encode "any" as a string.
    if (destination === "any") {
      return undefined;
    }
    return undefined;
  }
  const dest = destination as Record<string, unknown>;
  const kind = typeof dest["kind"] === "string" ? dest["kind"] : undefined;
  const group = typeof dest["group"] === "string" ? dest["group"] : undefined;
  if (kind === "group" || group === "host" || group === "loopback") {
    return undefined;
  }

  const protocols = decodeProtocols(record["protocols"]);
  const ports = decodePorts(record["ports"]);

  if (kind === "domain" || typeof dest["domain"] === "string") {
    const domain = String(dest["domain"]);
    return Object.freeze({
      kind: "domain",
      domain,
      ...(protocols !== undefined ? { protocols } : {}),
      ...(ports !== undefined ? { ports } : {}),
    });
  }
  if (
    kind === "domainSuffix" ||
    kind === "domain_suffix" ||
    typeof dest["domainSuffix"] === "string" ||
    typeof dest["suffix"] === "string"
  ) {
    const suffix = normalizeSuffix(String(dest["domainSuffix"] ?? dest["suffix"]));
    return Object.freeze({
      kind: "suffix",
      suffix,
      ...(protocols !== undefined ? { protocols } : {}),
      ...(ports !== undefined ? { ports } : {}),
    });
  }
  // Exact IP may appear as { ip } (fluent) or { cidr: "x.x.x.x/32" }.
  if (typeof dest["ip"] === "string") {
    return Object.freeze({
      kind: "ip",
      ip: dest["ip"],
      ...(protocols !== undefined ? { protocols } : {}),
      ...(ports !== undefined ? { ports } : {}),
    });
  }
  if (kind === "cidr" || typeof dest["cidr"] === "string") {
    const cidr = String(dest["cidr"]);
    if (cidr.endsWith("/32") && !cidr.includes(":")) {
      const ip = cidr.slice(0, -"/32".length);
      return Object.freeze({
        kind: "ip",
        ip,
        ...(protocols !== undefined ? { protocols } : {}),
        ...(ports !== undefined ? { ports } : {}),
      });
    }
    return Object.freeze({
      kind: "cidr",
      cidr,
      ...(protocols !== undefined ? { protocols } : {}),
      ...(ports !== undefined ? { ports } : {}),
    });
  }
  return undefined;
}

function decodeProtocols(raw: unknown): readonly NetworkProtocol[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const out: NetworkProtocol[] = [];
  for (const entry of raw) {
    if (entry === "tcp" || entry === "udp") {
      out.push(entry);
    }
  }
  return out.length > 0 ? Object.freeze(out) : undefined;
}

function decodePorts(raw: unknown): readonly NetworkPortSpec[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const out: NetworkPortSpec[] = [];
  for (const entry of raw) {
    if (typeof entry === "number") {
      out.push(entry);
      continue;
    }
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const start = record["start"];
    const end = record["end"];
    if (typeof start === "number" && typeof end === "number") {
      out.push(start === end ? start : { start, end });
    }
  }
  return out.length > 0 ? Object.freeze(out) : undefined;
}

function requirePort(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }
  return value;
}

function requireNonNegativePort(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${label} must be an integer between 0 and 65535.`);
  }
  return value;
}

function requireProtocol(value: unknown): NetworkProtocol {
  if (value === "tcp" || value === "udp") {
    return value;
  }
  if (value === undefined || value === null) {
    return "tcp";
  }
  throw new Error('Published port protocol must be "tcp" or "udp".');
}
