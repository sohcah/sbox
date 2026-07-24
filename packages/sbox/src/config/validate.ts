/**
 * Validate typed configuration and convert Zod issues into accumulated errors.
 */

import type {
  ConfigurationIssue,
  ProfileConfig,
  ProjectConfig,
  SafeProjectConfig,
  SafeUserConfig,
  UserConfig,
  ExternalValueRef,
} from "./types.js";
import { projectConfigSchema, userConfigSchema, yamlProjectInputSchema } from "./schema.js";
import { parseBinarySizeToMiB, parseDurationToSecs } from "./scalars.js";
import { SboxError } from "../errors.js";
import type { ZodError, ZodType } from "zod";

export function issuesFromZodError(error: ZodError): ConfigurationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

export function throwAccumulatedValidation(
  issues: readonly ConfigurationIssue[],
  message = "Configuration validation failed.",
): never {
  throw SboxError.validation(message, {
    details: {
      issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
      issueCount: issues.length,
    },
  });
}

export function parseWithIssues<T>(
  schema: ZodType<T>,
  input: unknown,
):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: ConfigurationIssue[] } {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, issues: issuesFromZodError(result.error) };
}

/** Validate typed in-memory project configuration. */
export function parseProjectConfig(input: unknown): ProjectConfig {
  const parsed = parseWithIssues(projectConfigSchema, input);
  if (!parsed.ok) {
    throwAccumulatedValidation(parsed.issues, "Project configuration validation failed.");
  }
  return freezeProjectConfig(normalizeProjectShape(parsed.value));
}

export function tryParseProjectConfig(
  input: unknown,
):
  | { readonly ok: true; readonly value: ProjectConfig }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] } {
  const parsed = parseWithIssues(projectConfigSchema, input);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, value: freezeProjectConfig(normalizeProjectShape(parsed.value)) };
}

export function parseUserConfig(input: unknown): UserConfig {
  const parsed = parseWithIssues(userConfigSchema, input);
  if (!parsed.ok) {
    throwAccumulatedValidation(parsed.issues, "User configuration validation failed.");
  }
  return freezeUserConfig(normalizeUserShape(parsed.value));
}

export function tryParseUserConfig(
  input: unknown,
):
  | { readonly ok: true; readonly value: UserConfig }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] } {
  const parsed = parseWithIssues(userConfigSchema, input);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, value: freezeUserConfig(normalizeUserShape(parsed.value)) };
}

/** Normalize YAML input into the typed project model. */
function normalizeYamlProjectInput(input: {
  readonly version: 1;
  readonly project: string;
  readonly defaultProfile?: string;
  readonly target?: string;
  readonly volumes?: Readonly<Record<string, { readonly size: string }>>;
  readonly profiles: Readonly<
    Record<
      string,
      {
        readonly image: string;
        readonly cpus?: number;
        readonly memoryMiB?: number;
        readonly memory?: string;
        readonly workdir?: string;
        readonly user?: string;
        readonly shell?: string;
        readonly hostname?: string;
        readonly environment?: Readonly<Record<string, string | ExternalValueRef>>;
        readonly maxDurationSecs?: number | null;
        readonly idleTimeoutSecs?: number | null;
        readonly maxDuration?: string | null;
        readonly idleTimeout?: string | null;
      }
    >
  >;
}): ProjectConfig {
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, profile] of Object.entries(input.profiles)) {
    const memoryMiB =
      profile.memoryMiB ??
      (profile.memory !== undefined
        ? parseBinarySizeToMiB(profile.memory, `profiles.${name}.memory`)
        : undefined);
    const maxDurationSecs =
      profile.maxDurationSecs !== undefined
        ? profile.maxDurationSecs
        : profile.maxDuration === undefined
          ? undefined
          : profile.maxDuration === null
            ? null
            : parseDurationToSecs(profile.maxDuration, `profiles.${name}.maxDuration`);
    const idleTimeoutSecs =
      profile.idleTimeoutSecs !== undefined
        ? profile.idleTimeoutSecs
        : profile.idleTimeout === undefined
          ? undefined
          : profile.idleTimeout === null
            ? null
            : parseDurationToSecs(profile.idleTimeout, `profiles.${name}.idleTimeout`);

    profiles[name] = {
      image: profile.image,
      ...(profile.cpus !== undefined ? { cpus: profile.cpus } : {}),
      ...(memoryMiB !== undefined ? { memoryMiB } : {}),
      ...(profile.workdir !== undefined ? { workdir: profile.workdir } : {}),
      ...(profile.user !== undefined ? { user: profile.user } : {}),
      ...(profile.shell !== undefined ? { shell: profile.shell } : {}),
      ...(profile.hostname !== undefined ? { hostname: profile.hostname } : {}),
      ...(profile.environment !== undefined ? { environment: { ...profile.environment } } : {}),
      ...(maxDurationSecs !== undefined ? { maxDurationSecs } : {}),
      ...(idleTimeoutSecs !== undefined ? { idleTimeoutSecs } : {}),
    };
  }

  return freezeProjectConfig({
    version: 1,
    project: input.project,
    ...(input.defaultProfile !== undefined ? { defaultProfile: input.defaultProfile } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.volumes !== undefined ? { volumes: { ...input.volumes } } : {}),
    profiles,
  });
}

export function parseYamlProjectInput(input: unknown): ProjectConfig {
  const parsed = parseWithIssues(yamlProjectInputSchema, input);
  if (!parsed.ok) {
    throwAccumulatedValidation(parsed.issues, "Project YAML validation failed.");
  }
  return normalizeYamlProjectInput(parsed.value as Parameters<typeof normalizeYamlProjectInput>[0]);
}

export function tryParseYamlProjectInput(
  input: unknown,
):
  | { readonly ok: true; readonly value: ProjectConfig }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] } {
  const parsed = parseWithIssues(yamlProjectInputSchema, input);
  if (!parsed.ok) {
    return parsed;
  }
  try {
    return {
      ok: true,
      value: normalizeYamlProjectInput(
        parsed.value as Parameters<typeof normalizeYamlProjectInput>[0],
      ),
    };
  } catch (error) {
    if (error instanceof SboxError && error.code === "validation") {
      const issues = error.details["issues"];
      if (Array.isArray(issues)) {
        return {
          ok: false,
          issues: issues.map((issue) => {
            const record = issue as { path?: unknown; message?: unknown };
            return {
              path: typeof record.path === "string" ? record.path : "(root)",
              message: typeof record.message === "string" ? record.message : "Invalid value.",
            };
          }),
        };
      }
      return {
        ok: false,
        issues: [{ path: "(root)", message: error.message }],
      };
    }
    throw error;
  }
}

export function toSafeProjectConfig(config: ProjectConfig): SafeProjectConfig {
  const profiles: Record<
    string,
    {
      readonly image: string;
      readonly cpus?: number;
      readonly memoryMiB?: number;
      readonly workdir?: string;
      readonly user?: string;
      readonly shell?: string;
      readonly hostname?: string;
      readonly environment: Readonly<Record<string, "literal" | "env" | "file" | "invocation">>;
      readonly maxDurationSecs?: number | null;
      readonly idleTimeoutSecs?: number | null;
    }
  > = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    const environment: Record<string, "literal" | "env" | "file" | "invocation"> = {};
    for (const [key, value] of Object.entries(profile.environment ?? {})) {
      environment[key] = classifyConfigValue(value);
    }
    profiles[name] = {
      image: profile.image,
      ...(profile.cpus !== undefined ? { cpus: profile.cpus } : {}),
      ...(profile.memoryMiB !== undefined ? { memoryMiB: profile.memoryMiB } : {}),
      ...(profile.workdir !== undefined ? { workdir: profile.workdir } : {}),
      ...(profile.user !== undefined ? { user: profile.user } : {}),
      ...(profile.shell !== undefined ? { shell: profile.shell } : {}),
      ...(profile.hostname !== undefined ? { hostname: profile.hostname } : {}),
      environment,
      ...(profile.maxDurationSecs !== undefined
        ? { maxDurationSecs: profile.maxDurationSecs }
        : {}),
      ...(profile.idleTimeoutSecs !== undefined
        ? { idleTimeoutSecs: profile.idleTimeoutSecs }
        : {}),
    };
  }
  return {
    version: 1,
    project: config.project,
    ...(config.defaultProfile !== undefined ? { defaultProfile: config.defaultProfile } : {}),
    ...(config.target !== undefined ? { target: config.target } : {}),
    volumes: { ...config.volumes },
    profiles,
  };
}

export function toSafeUserConfig(config: UserConfig): SafeUserConfig {
  const targets: Record<
    string,
    | { readonly kind: "local" }
    | {
        readonly kind: "remote";
        readonly url: string;
        readonly token: "env" | "file" | "invocation";
      }
  > = {};
  for (const [name, target] of Object.entries(config.targets)) {
    if (target.kind === "local") {
      targets[name] = { kind: "local" };
    } else {
      targets[name] = {
        kind: "remote",
        url: target.url,
        token: classifyExternalRef(target.token),
      };
    }
  }
  return {
    version: 1,
    ...(config.defaultTarget !== undefined ? { defaultTarget: config.defaultTarget } : {}),
    targets,
  };
}

function classifyConfigValue(
  value: string | ExternalValueRef,
): "literal" | "env" | "file" | "invocation" {
  if (typeof value === "string") {
    return "literal";
  }
  return classifyExternalRef(value);
}

function classifyExternalRef(value: ExternalValueRef): "env" | "file" | "invocation" {
  if ("env" in value) {
    return "env";
  }
  if ("file" in value) {
    return "file";
  }
  return "invocation";
}

function normalizeProjectShape(value: {
  version: 1;
  project: string;
  defaultProfile?: string | undefined;
  target?: string | undefined;
  volumes?: Record<string, { size: string }> | undefined;
  profiles: Record<string, Record<string, unknown>>;
}): {
  readonly version: 1;
  readonly project: string;
  readonly defaultProfile?: string;
  readonly target?: string;
  readonly volumes?: Readonly<Record<string, { readonly size: string }>>;
  readonly profiles: Readonly<Record<string, ProfileConfig>>;
} {
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, profile] of Object.entries(value.profiles)) {
    profiles[name] = stripUndefined(profile) as unknown as ProfileConfig;
  }
  return {
    version: 1,
    project: value.project,
    ...(value.defaultProfile !== undefined ? { defaultProfile: value.defaultProfile } : {}),
    ...(value.target !== undefined ? { target: value.target } : {}),
    ...(value.volumes !== undefined ? { volumes: value.volumes } : {}),
    profiles,
  };
}

function normalizeUserShape(value: {
  version: 1;
  defaultTarget?: string | undefined;
  targets: Record<string, Record<string, unknown>>;
}): {
  readonly version: 1;
  readonly defaultTarget?: string;
  readonly targets: UserConfig["targets"];
} {
  const targets: Record<string, UserConfig["targets"][string]> = {};
  for (const [name, target] of Object.entries(value.targets)) {
    targets[name] = stripUndefined(target) as unknown as UserConfig["targets"][string];
  }
  return {
    version: 1,
    ...(value.defaultTarget !== undefined ? { defaultTarget: value.defaultTarget } : {}),
    targets,
  };
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function freezeProjectConfig(config: {
  readonly version: 1;
  readonly project: string;
  readonly defaultProfile?: string;
  readonly target?: string;
  readonly volumes?: Readonly<Record<string, { readonly size: string }>>;
  readonly profiles: Readonly<Record<string, ProfileConfig>>;
}): ProjectConfig {
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    profiles[name] = Object.freeze({
      ...profile,
      ...(profile.environment !== undefined
        ? { environment: Object.freeze({ ...profile.environment }) }
        : {}),
    });
  }
  return Object.freeze({
    version: 1 as const,
    project: config.project,
    ...(config.defaultProfile !== undefined ? { defaultProfile: config.defaultProfile } : {}),
    ...(config.target !== undefined ? { target: config.target } : {}),
    ...(config.volumes !== undefined
      ? {
          volumes: Object.freeze(
            Object.fromEntries(
              Object.entries(config.volumes).map(([key, value]) => [
                key,
                Object.freeze({ ...value }),
              ]),
            ),
          ),
        }
      : {}),
    profiles: Object.freeze(profiles),
  });
}

function freezeUserConfig(config: {
  readonly version: 1;
  readonly defaultTarget?: string;
  readonly targets: UserConfig["targets"];
}): UserConfig {
  const targets = Object.fromEntries(
    Object.entries(config.targets).map(([name, target]) => [name, Object.freeze({ ...target })]),
  );
  return Object.freeze({
    version: 1 as const,
    ...(config.defaultTarget !== undefined ? { defaultTarget: config.defaultTarget } : {}),
    targets: Object.freeze(targets),
  });
}
