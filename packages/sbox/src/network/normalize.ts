/**
 * Normalize Zod/YAML network + secret shapes into typed curated models.
 */

import type { ExternalValueRef } from "../config/types.js";
import {
  defaultNetworkConfig,
  type HostNetworkConfig,
  type NetworkAllowRule,
  type NetworkConfig,
  type NetworkPortSpec,
  type NetworkProtocol,
  type PublishedPortSpec,
  type RuntimeSecretConfig,
} from "./types.js";
import { normalizeSuffix } from "./validate.js";

export type RawNetworkAllowRule = {
  readonly domain?: string;
  readonly suffix?: string;
  readonly ip?: string;
  readonly cidr?: string;
  readonly ports?: readonly NetworkPortSpec[];
  readonly protocols?: readonly NetworkProtocol[];
};

export type RawNetworkConfig = {
  readonly mode?: "disabled" | "default-deny";
  readonly allow?: readonly RawNetworkAllowRule[];
  readonly publish?: readonly PublishedPortSpec[];
};

export function normalizeNetworkConfig(
  raw: RawNetworkConfig | NetworkConfig | undefined,
): NetworkConfig {
  if (raw === undefined) {
    return defaultNetworkConfig();
  }
  return Object.freeze({
    mode: raw.mode ?? "default-deny",
    allow: Object.freeze(
      (raw.allow ?? []).map((rule) =>
        normalizeAllowRule(rule as RawNetworkAllowRule | NetworkAllowRule),
      ),
    ),
    publish: Object.freeze((raw.publish ?? []).map((port) => Object.freeze({ ...port }))),
  });
}

function freezeExistingAllowRule(rule: NetworkAllowRule): NetworkAllowRule {
  if (rule.kind === "domain") {
    return Object.freeze({
      kind: "domain",
      domain: rule.domain,
      ...(rule.ports !== undefined ? { ports: Object.freeze([...rule.ports]) } : {}),
      ...(rule.protocols !== undefined ? { protocols: Object.freeze([...rule.protocols]) } : {}),
    });
  }
  if (rule.kind === "suffix") {
    return Object.freeze({
      kind: "suffix",
      suffix: normalizeSuffix(rule.suffix),
      ...(rule.ports !== undefined ? { ports: Object.freeze([...rule.ports]) } : {}),
      ...(rule.protocols !== undefined ? { protocols: Object.freeze([...rule.protocols]) } : {}),
    });
  }
  if (rule.kind === "ip") {
    return Object.freeze({
      kind: "ip",
      ip: rule.ip,
      ...(rule.ports !== undefined ? { ports: Object.freeze([...rule.ports]) } : {}),
      ...(rule.protocols !== undefined ? { protocols: Object.freeze([...rule.protocols]) } : {}),
    });
  }
  return Object.freeze({
    kind: "cidr",
    cidr: rule.cidr,
    ...(rule.ports !== undefined ? { ports: Object.freeze([...rule.ports]) } : {}),
    ...(rule.protocols !== undefined ? { protocols: Object.freeze([...rule.protocols]) } : {}),
  });
}

export function normalizeAllowRule(raw: RawNetworkAllowRule | NetworkAllowRule): NetworkAllowRule {
  if ("kind" in raw && typeof raw.kind === "string") {
    return freezeExistingAllowRule(raw);
  }
  const ports = raw.ports !== undefined ? Object.freeze([...raw.ports]) : undefined;
  const protocols = raw.protocols !== undefined ? Object.freeze([...raw.protocols]) : undefined;
  if (raw.domain !== undefined) {
    return Object.freeze({
      kind: "domain",
      domain: raw.domain,
      ...(ports !== undefined ? { ports } : {}),
      ...(protocols !== undefined ? { protocols } : {}),
    });
  }
  if (raw.suffix !== undefined) {
    return Object.freeze({
      kind: "suffix",
      suffix: normalizeSuffix(raw.suffix),
      ...(ports !== undefined ? { ports } : {}),
      ...(protocols !== undefined ? { protocols } : {}),
    });
  }
  if (raw.ip !== undefined) {
    return Object.freeze({
      kind: "ip",
      ip: raw.ip,
      ...(ports !== undefined ? { ports } : {}),
      ...(protocols !== undefined ? { protocols } : {}),
    });
  }
  if (raw.cidr !== undefined) {
    return Object.freeze({
      kind: "cidr",
      cidr: raw.cidr,
      ...(ports !== undefined ? { ports } : {}),
      ...(protocols !== undefined ? { protocols } : {}),
    });
  }
  throw new Error("Expected exactly one of domain, suffix, ip, or cidr.");
}

export function normalizeRuntimeSecrets(
  raw:
    | readonly {
        readonly env: string;
        readonly value: ExternalValueRef;
        readonly placeholder?: string;
        readonly destinations: readonly string[];
      }[]
    | undefined,
): readonly RuntimeSecretConfig[] {
  if (raw === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(
    raw.map((secret) =>
      Object.freeze({
        env: secret.env,
        value: secret.value,
        ...(secret.placeholder !== undefined ? { placeholder: secret.placeholder } : {}),
        destinations: Object.freeze([...secret.destinations]),
      }),
    ),
  );
}

export function mergeNetworkConfigs(
  base: HostNetworkConfig,
  extraAllow: readonly NetworkAllowRule[] = [],
  extraPublish: readonly PublishedPortSpec[] = [],
): HostNetworkConfig {
  if (base.mode === "disabled" && (extraAllow.length > 0 || extraPublish.length > 0)) {
    throw new Error("Cannot add network allow rules or published ports when mode is disabled.");
  }
  return Object.freeze({
    mode: base.mode,
    allow: Object.freeze([...base.allow, ...extraAllow]),
    publish: Object.freeze([...base.publish, ...extraPublish]),
  });
}
