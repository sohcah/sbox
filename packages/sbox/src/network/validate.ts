/**
 * Validate curated network rules and runtime secrets.
 */

import { isIP } from "node:net";
import { isEnvVarName } from "../config/scalars.js";
import type { ConfigurationIssue } from "../config/types.js";
import {
  DEFAULT_NETWORK_BIND,
  type HostNetworkConfig,
  type NetworkAllowRule,
  type NetworkPortSpec,
  type NetworkProtocol,
  type PublishedPortSpec,
  type ResolvedRuntimeSecret,
  type RuntimeSecretConfig,
} from "./types.js";

const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const CIDR_V4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\/(?:[0-9]|[12]\d|3[0-2])$/;

export function validateHostNetworkConfig(
  network: HostNetworkConfig,
  pathPrefix = "network",
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  if (network.mode !== "disabled" && network.mode !== "default-deny") {
    issues.push({
      path: `${pathPrefix}.mode`,
      message: 'Expected "disabled" or "default-deny".',
    });
  }
  if (network.mode === "disabled") {
    if (network.allow.length > 0) {
      issues.push({
        path: `${pathPrefix}.allow`,
        message: "Network allow rules are not permitted when mode is disabled.",
      });
    }
    if (network.publish.length > 0) {
      issues.push({
        path: `${pathPrefix}.publish`,
        message: "Published ports are not permitted when mode is disabled.",
      });
    }
  }
  for (let i = 0; i < network.allow.length; i += 1) {
    issues.push(...validateAllowRule(network.allow[i]!, `${pathPrefix}.allow.${i}`));
  }
  for (let i = 0; i < network.publish.length; i += 1) {
    issues.push(...validatePublishPort(network.publish[i]!, `${pathPrefix}.publish.${i}`));
  }
  return issues;
}

export function validateResolvedRuntimeSecrets(
  secrets: readonly ResolvedRuntimeSecret[],
  pathPrefix = "secrets",
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < secrets.length; i += 1) {
    const secret = secrets[i]!;
    const path = `${pathPrefix}.${i}`;
    if (!isEnvVarName(secret.env)) {
      issues.push({
        path: `${path}.env`,
        message: "Expected an environment variable name matching [A-Za-z_][A-Za-z0-9_]*.",
      });
    } else if (seen.has(secret.env)) {
      issues.push({
        path: `${path}.env`,
        message: `Duplicate secret env "${secret.env}".`,
      });
    } else {
      seen.add(secret.env);
    }
    if (secret.placeholder.length === 0) {
      issues.push({
        path: `${path}.placeholder`,
        message: "Expected a non-empty guest placeholder.",
      });
    }
    if (secret.destinations.length === 0) {
      issues.push({
        path: `${path}.destinations`,
        message: "At least one secret destination is required.",
      });
    }
    for (let d = 0; d < secret.destinations.length; d += 1) {
      issues.push(
        ...validateSecretDestination(secret.destinations[d]!, `${path}.destinations.${d}`),
      );
    }
  }
  return issues;
}

export function validateRuntimeSecretConfigs(
  secrets: readonly RuntimeSecretConfig[],
  pathPrefix: string,
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < secrets.length; i += 1) {
    const secret = secrets[i]!;
    const path = `${pathPrefix}.${i}`;
    if (!isEnvVarName(secret.env)) {
      issues.push({
        path: `${path}.env`,
        message: "Expected an environment variable name matching [A-Za-z_][A-Za-z0-9_]*.",
      });
    } else if (seen.has(secret.env)) {
      issues.push({
        path: `${path}.env`,
        message: `Duplicate secret env "${secret.env}".`,
      });
    } else {
      seen.add(secret.env);
    }
    if (secret.placeholder !== undefined && secret.placeholder.length === 0) {
      issues.push({
        path: `${path}.placeholder`,
        message: "Expected a non-empty guest placeholder.",
      });
    }
    if (!Array.isArray(secret.destinations) || secret.destinations.length === 0) {
      issues.push({
        path: `${path}.destinations`,
        message: "At least one secret destination is required.",
      });
    } else {
      for (let d = 0; d < secret.destinations.length; d += 1) {
        issues.push(
          ...validateSecretDestination(secret.destinations[d]!, `${path}.destinations.${d}`),
        );
      }
    }
  }
  return issues;
}

function validateAllowRule(rule: NetworkAllowRule, path: string): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  if (rule.kind === "domain") {
    if (!isDomainName(rule.domain)) {
      issues.push({ path: `${path}.domain`, message: "Expected a valid domain name." });
    }
  } else if (rule.kind === "suffix") {
    const suffix = normalizeSuffix(rule.suffix);
    if (!isDomainName(suffix)) {
      issues.push({
        path: `${path}.suffix`,
        message: "Expected a valid domain suffix (with or without a leading dot).",
      });
    }
  } else if (rule.kind === "ip") {
    if (!isIpAddress(rule.ip)) {
      issues.push({ path: `${path}.ip`, message: "Expected a valid IPv4 or IPv6 address." });
    }
  } else if (rule.kind === "cidr") {
    if (!isCidr(rule.cidr)) {
      issues.push({
        path: `${path}.cidr`,
        message: "Expected a valid IPv4 CIDR (e.g. 10.0.0.0/8).",
      });
    }
  } else {
    issues.push({ path, message: "Expected domain, suffix, ip, or cidr." });
  }
  if (rule.protocols !== undefined) {
    issues.push(...validateProtocols(rule.protocols, `${path}.protocols`));
  }
  if (rule.ports !== undefined) {
    issues.push(...validatePorts(rule.ports, `${path}.ports`));
  }
  return issues;
}

function validatePublishPort(port: PublishedPortSpec, path: string): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  if (!isPortNumber(port.guest)) {
    issues.push({ path: `${path}.guest`, message: "Expected a guest port between 1 and 65535." });
  }
  if (port.host !== undefined && !(port.host === 0 || isPortNumber(port.host))) {
    issues.push({
      path: `${path}.host`,
      message: "Expected a host port between 1 and 65535, or 0 for dynamic allocation.",
    });
  }
  if (port.protocol !== undefined && port.protocol !== "tcp" && port.protocol !== "udp") {
    issues.push({ path: `${path}.protocol`, message: 'Expected "tcp" or "udp".' });
  }
  if (port.bind !== undefined) {
    if (port.bind.trim().length === 0) {
      issues.push({ path: `${path}.bind`, message: "Expected a non-empty host bind address." });
    }
  }
  return issues;
}

function validateSecretDestination(value: string, path: string): ConfigurationIssue[] {
  if (typeof value !== "string" || value.length === 0) {
    return [{ path, message: "Expected a non-empty destination host or pattern." }];
  }
  if (value.includes("*")) {
    if (!/^\*\.[A-Za-z0-9.-]+$/.test(value) || !isDomainName(value.slice(2))) {
      return [
        {
          path,
          message: 'Expected a wildcard destination like "*.example.com".',
        },
      ];
    }
    return [];
  }
  if (!isDomainName(value) && !isIpAddress(value)) {
    return [{ path, message: "Expected an exact hostname or IP destination." }];
  }
  return [];
}

function validateProtocols(
  protocols: readonly NetworkProtocol[],
  path: string,
): ConfigurationIssue[] {
  if (protocols.length === 0) {
    return [{ path, message: "Expected at least one protocol when protocols is set." }];
  }
  const issues: ConfigurationIssue[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < protocols.length; i += 1) {
    const protocol = protocols[i]!;
    if (protocol !== "tcp" && protocol !== "udp") {
      issues.push({ path: `${path}.${i}`, message: 'Expected "tcp" or "udp".' });
    } else if (seen.has(protocol)) {
      issues.push({ path: `${path}.${i}`, message: `Duplicate protocol "${protocol}".` });
    } else {
      seen.add(protocol);
    }
  }
  return issues;
}

function validatePorts(ports: readonly NetworkPortSpec[], path: string): ConfigurationIssue[] {
  if (ports.length === 0) {
    return [{ path, message: "Expected at least one port when ports is set." }];
  }
  const issues: ConfigurationIssue[] = [];
  for (let i = 0; i < ports.length; i += 1) {
    const port = ports[i]!;
    if (typeof port === "number") {
      if (!isPortNumber(port)) {
        issues.push({ path: `${path}.${i}`, message: "Expected a port between 1 and 65535." });
      }
      continue;
    }
    if (
      port === null ||
      typeof port !== "object" ||
      typeof port.start !== "number" ||
      typeof port.end !== "number"
    ) {
      issues.push({
        path: `${path}.${i}`,
        message: "Expected a port number or { start, end } range.",
      });
      continue;
    }
    if (!isPortNumber(port.start) || !isPortNumber(port.end)) {
      issues.push({
        path: `${path}.${i}`,
        message: "Expected start/end ports between 1 and 65535.",
      });
    } else if (port.start > port.end) {
      issues.push({
        path: `${path}.${i}`,
        message: "Expected start <= end for a port range.",
      });
    }
  }
  return issues;
}

export function normalizeSuffix(suffix: string): string {
  return suffix.startsWith(".") ? suffix.slice(1) : suffix;
}

export function normalizePublishedPort(port: PublishedPortSpec): {
  readonly guest: number;
  readonly host: number;
  readonly protocol: NetworkProtocol;
  readonly bind: string;
} {
  return {
    guest: port.guest,
    host: port.host ?? 0,
    protocol: port.protocol ?? "tcp",
    bind: port.bind ?? DEFAULT_NETWORK_BIND,
  };
}

export function defaultPlaceholder(env: string): string {
  return `{{${env}}}`;
}

function isPortNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isDomainName(value: string): boolean {
  return DOMAIN_RE.test(value);
}

function isIpAddress(value: string): boolean {
  return isIP(value) !== 0;
}

/** IPv4 CIDR only (e.g. 10.0.0.0/8). IPv6 CIDR is not accepted in Phase 5. */
function isCidr(value: string): boolean {
  return CIDR_V4_RE.test(value);
}

export function isDynamicHostPort(port: PublishedPortSpec): boolean {
  return port.host === undefined || port.host === 0;
}
