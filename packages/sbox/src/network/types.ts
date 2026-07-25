/**
 * Curated Phase 5 network and runtime-secret models.
 *
 * These are application-owned DTOs, not a mirror of the full Microsandbox
 * network-policy language.
 */

export type NetworkMode = "disabled" | "default-deny";

export type NetworkProtocol = "tcp" | "udp";

/** Inclusive guest destination port or range. */
export type NetworkPortSpec = number | { readonly start: number; readonly end: number };

export type NetworkAllowRule =
  | {
      readonly kind: "domain";
      readonly domain: string;
      readonly ports?: readonly NetworkPortSpec[];
      readonly protocols?: readonly NetworkProtocol[];
    }
  | {
      readonly kind: "suffix";
      readonly suffix: string;
      readonly ports?: readonly NetworkPortSpec[];
      readonly protocols?: readonly NetworkProtocol[];
    }
  | {
      readonly kind: "ip";
      readonly ip: string;
      readonly ports?: readonly NetworkPortSpec[];
      readonly protocols?: readonly NetworkProtocol[];
    }
  | {
      readonly kind: "cidr";
      /** IPv4 CIDR only (e.g. 10.0.0.0/8). */
      readonly cidr: string;
      readonly ports?: readonly NetworkPortSpec[];
      readonly protocols?: readonly NetworkProtocol[];
    };

export interface PublishedPortSpec {
  readonly guest: number;
  /**
   * Host port. Omit or `0` requests a dynamic allocation when the Host
   * advertises `dynamicHostPorts`.
   */
  readonly host?: number;
  readonly protocol?: NetworkProtocol;
  /** Host bind address. Defaults to loopback. */
  readonly bind?: string;
}

/**
 * Profile / YAML runtime secret interception entry. Values resolve from
 * external refs only (never literals in config).
 */
export interface RuntimeSecretConfig {
  /** Guest env / interception name. */
  readonly env: string;
  readonly value:
    | { readonly env: string }
    | { readonly file: string }
    | { readonly invocation: string };
  /** Guest placeholder text. Defaults to `{{env}}` when omitted. */
  readonly placeholder?: string;
  /**
   * Allowed secret destinations. Exact hosts, or `*.example.com` patterns.
   * Does not grant network access.
   */
  readonly destinations: readonly string[];
}

/** Resolved create-time secret (value present only on the Host create path). */
export interface ResolvedRuntimeSecret {
  readonly env: string;
  readonly value: string;
  readonly placeholder: string;
  readonly destinations: readonly string[];
}

/** Safe secret projection: never includes values. */
export interface SafeRuntimeSecret {
  readonly env: string;
  readonly placeholder: string;
  readonly destinations: readonly string[];
}

export interface NetworkConfig {
  readonly mode: NetworkMode;
  readonly allow: readonly NetworkAllowRule[];
  readonly publish: readonly PublishedPortSpec[];
}

/** Normalized create request network (always explicit). */
export interface HostNetworkConfig {
  readonly mode: NetworkMode;
  readonly allow: readonly NetworkAllowRule[];
  readonly publish: readonly PublishedPortSpec[];
}

/** Inspectable published port after create (host may be allocated). */
export interface InspectedPublishedPort {
  readonly guest: number;
  readonly host: number;
  readonly protocol: NetworkProtocol;
  readonly bind: string;
}

/** Safe network projection on inspection / resolved config. */
export interface SafeNetworkConfig {
  readonly mode: NetworkMode;
  readonly allow: readonly NetworkAllowRule[];
  readonly publish: readonly InspectedPublishedPort[];
}

export const DEFAULT_NETWORK_BIND = "127.0.0.1";
export const DEFAULT_DOMAIN_PORTS: readonly number[] = [80, 443];
export const DEFAULT_DOMAIN_PROTOCOLS: readonly NetworkProtocol[] = ["tcp"];

export function defaultNetworkConfig(): HostNetworkConfig {
  return Object.freeze({
    mode: "default-deny",
    allow: Object.freeze([]),
    publish: Object.freeze([]),
  });
}

export function toSafeRuntimeSecret(secret: {
  readonly env: string;
  readonly placeholder: string;
  readonly destinations: readonly string[];
}): SafeRuntimeSecret {
  return Object.freeze({
    env: secret.env,
    placeholder: secret.placeholder,
    destinations: Object.freeze([...secret.destinations]),
  });
}

export function toSafeNetworkConfig(
  network: HostNetworkConfig,
  publish: readonly InspectedPublishedPort[] = network.publish.map((port) => ({
    guest: port.guest,
    host: port.host ?? 0,
    protocol: port.protocol ?? "tcp",
    bind: port.bind ?? DEFAULT_NETWORK_BIND,
  })),
): SafeNetworkConfig {
  return Object.freeze({
    mode: network.mode,
    allow: Object.freeze(network.allow.map(freezeAllowRule)),
    publish: Object.freeze(publish.map((port) => Object.freeze({ ...port }))),
  });
}

function freezeAllowRule(rule: NetworkAllowRule): NetworkAllowRule {
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
      suffix: rule.suffix,
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
