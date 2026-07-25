/**
 * Compile curated network + secrets into Microsandbox NetworkBuilder callbacks.
 *
 * Kept inside the package; SDK types are not re-exported.
 */

import { NetworkPolicyBuilder } from "microsandbox";
import {
  DEFAULT_DOMAIN_PORTS,
  DEFAULT_DOMAIN_PROTOCOLS,
  type HostNetworkConfig,
  type NetworkAllowRule,
  type NetworkPortSpec,
  type NetworkProtocol,
  type ResolvedRuntimeSecret,
} from "./types.js";
import { normalizePublishedPort, normalizeSuffix } from "./validate.js";

/** Structural subset of microsandbox NetworkBuilder used at create time. */
export interface NetworkBuilderLike {
  enabled(enabled: boolean): this;
  policy(policy: unknown): this;
  portBind(bind: string, host: number, guest: number): this;
  portUdpBind(bind: string, host: number, guest: number): this;
  secret(configure: (sb: SecretBuilderLike) => SecretBuilderLike): this;
}

/** Structural subset of microsandbox SecretBuilder. */
export interface SecretBuilderLike {
  env(varName: string): this;
  value(value: string): this;
  placeholder(placeholder: string): this;
  allowHost(host: string): this;
  allowHostPattern(pattern: string): this;
}

export function applyNetworkToBuilder<T extends NetworkBuilderLike>(
  builder: T,
  network: HostNetworkConfig,
  secrets: readonly ResolvedRuntimeSecret[],
): T {
  if (network.mode === "disabled") {
    let next: T = builder.enabled(false);
    for (const secret of secrets) {
      next = next.secret((sb) => configureSecret(sb, secret)) as T;
    }
    return next;
  }

  let next: T = builder.enabled(true).policy(compileDefaultDenyPolicy(network)) as T;
  for (const published of network.publish) {
    const port = normalizePublishedPort(published);
    if (port.protocol === "udp") {
      next = next.portUdpBind(port.bind, port.host, port.guest);
    } else {
      next = next.portBind(port.bind, port.host, port.guest);
    }
  }
  for (const secret of secrets) {
    next = next.secret((sb) => configureSecret(sb, secret)) as T;
  }
  return next;
}

export function compileDefaultDenyPolicy(network: HostNetworkConfig): unknown {
  let policy = new NetworkPolicyBuilder().defaultDeny();
  // Automatic DNS (host resolver) without general outbound bypass.
  policy = policy.egress((rb) => rb.udp().port(53).allowHost());
  policy = policy.egress((rb) => rb.tcp().port(53).allowHost());
  // Guest loopback remains usable.
  policy = policy.egress((rb) => rb.allowLoopback());
  policy = policy.ingress((rb) => rb.allowLoopback());

  for (const rule of network.allow) {
    for (const { protocol, ports } of expandAllowRule(rule)) {
      policy = policy.egress((rb) => {
        let next = protocol === "udp" ? rb.udp() : rb.tcp();
        next = applyPorts(next, ports);
        return applyDestination(next, rule);
      });
    }
  }

  for (const published of network.publish) {
    const port = normalizePublishedPort(published);
    policy = policy.ingress((rb) => {
      const next = port.protocol === "udp" ? rb.udp() : rb.tcp();
      return next.port(port.guest).allow((d) => d.any());
    });
  }

  return policy.build();
}

function expandAllowRule(rule: NetworkAllowRule): readonly {
  readonly protocol: NetworkProtocol;
  readonly ports: readonly NetworkPortSpec[] | undefined;
}[] {
  const isDomainLike = rule.kind === "domain" || rule.kind === "suffix";
  const protocols =
    rule.protocols ?? (isDomainLike ? DEFAULT_DOMAIN_PROTOCOLS : (["tcp", "udp"] as const));
  const ports = rule.ports ?? (isDomainLike ? DEFAULT_DOMAIN_PORTS : undefined);
  return protocols.map((protocol) => ({ protocol, ports }));
}

function applyPorts<
  T extends {
    port(port: number): T;
    ports(ports: number[]): T;
    portRange(lo: number, hi: number): T;
  },
>(builder: T, ports: readonly NetworkPortSpec[] | undefined): T {
  if (ports === undefined || ports.length === 0) {
    return builder;
  }
  // Apply in canonical sorted order so native policy decode matches fingerprints.
  let next = builder;
  for (const port of sortPortsForCanonical(ports)) {
    if (typeof port === "number") {
      next = next.port(port);
    } else if (port.start === port.end) {
      next = next.port(port.start);
    } else {
      next = next.portRange(port.start, port.end);
    }
  }
  return next;
}

function applyDestination<
  T extends {
    allowDomain(name: string): T;
    allowDomainSuffix(suffix: string): T;
    allow(configure: (d: { ip(ip: string): unknown; cidr(cidr: string): unknown }) => unknown): T;
  },
>(builder: T, rule: NetworkAllowRule): T {
  if (rule.kind === "domain") {
    return builder.allowDomain(rule.domain);
  }
  if (rule.kind === "suffix") {
    return builder.allowDomainSuffix(normalizeSuffix(rule.suffix));
  }
  if (rule.kind === "ip") {
    return builder.allow((d) => d.ip(rule.ip));
  }
  return builder.allow((d) => d.cidr(rule.cidr));
}

function configureSecret(
  builder: SecretBuilderLike,
  secret: ResolvedRuntimeSecret,
): SecretBuilderLike {
  let next = builder.env(secret.env).value(secret.value).placeholder(secret.placeholder);
  for (const destination of secret.destinations) {
    if (destination.startsWith("*.")) {
      next = next.allowHostPattern(destination);
    } else {
      next = next.allowHost(destination);
    }
  }
  return next;
}

/**
 * Canonical JSON-stable form for ownership fingerprints (no secret values).
 *
 * Allow rules are expanded to one entry per protocol — the same shape
 * `compileDefaultDenyPolicy` emits and `decodeAllowRulesFromPolicy` returns —
 * so requested ↔ decoded round-trips compare equal.
 */
export function canonicalNetworkFingerprint(network: HostNetworkConfig): unknown {
  return {
    mode: network.mode,
    allow: expandAllowRulesForCanonical(network.allow),
    publish: network.publish.map((port) => normalizePublishedPort(port)),
  };
}

export function canonicalSecretsFingerprint(
  secrets: readonly {
    readonly env: string;
    readonly placeholder: string;
    readonly destinations: readonly string[];
  }[],
): unknown {
  return secrets
    .map((secret) => ({
      env: secret.env,
      placeholder: secret.placeholder,
      destinations: [...secret.destinations].toSorted(),
    }))
    .toSorted((left, right) => left.env.localeCompare(right.env));
}

/**
 * Expand curated allow rules into the per-protocol form used at compile time
 * and produced by native policy decode.
 */
export function expandAllowRulesForCanonical(
  allow: readonly NetworkAllowRule[],
): readonly unknown[] {
  const expanded: unknown[] = [];
  for (const rule of allow) {
    for (const { protocol, ports } of expandAllowRule(rule)) {
      expanded.push(canonicalExpandedAllowRule(rule, protocol, ports));
    }
  }
  return expanded.toSorted((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function canonicalExpandedAllowRule(
  rule: NetworkAllowRule,
  protocol: NetworkProtocol,
  ports: readonly NetworkPortSpec[] | undefined,
): unknown {
  const normalizedPorts = ports === undefined ? undefined : sortPortsForCanonical(ports);
  const base = {
    protocols: [protocol],
    ...(normalizedPorts !== undefined ? { ports: normalizedPorts } : {}),
  };
  if (rule.kind === "domain") {
    return { kind: "domain", domain: rule.domain, ...base };
  }
  if (rule.kind === "suffix") {
    return { kind: "suffix", suffix: normalizeSuffix(rule.suffix), ...base };
  }
  if (rule.kind === "ip") {
    return { kind: "ip", ip: rule.ip, ...base };
  }
  return { kind: "cidr", cidr: rule.cidr, ...base };
}

/**
 * Stable port order for fingerprints. Native compile may emit ranges before
 * singles when both appear in one rule; sorting by start then end keeps
 * requested and decoded forms equivalent.
 */
function sortPortsForCanonical(
  ports: readonly NetworkPortSpec[],
): readonly (number | { readonly start: number; readonly end: number })[] {
  return [...ports]
    .map((port) =>
      typeof port === "number"
        ? { start: port, end: port, asSingle: true as const }
        : { start: port.start, end: port.end, asSingle: port.start === port.end },
    )
    .toSorted((left, right) => left.start - right.start || left.end - right.end)
    .map((port) =>
      port.asSingle && port.start === port.end ? port.start : { start: port.start, end: port.end },
    );
}
