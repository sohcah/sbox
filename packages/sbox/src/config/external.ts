/**
 * Resolve structured external references before lifecycle mutation.
 *
 * Missing references are accumulated where practical. Resolved values are never
 * logged or placed in public diagnostics.
 *
 * Empty string values from present env vars, invocation keys, or files are
 * preserved. Only absent/unreadable sources are missing.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SboxError } from "../errors.js";
import type { ConfigurationIssue, ExternalValueRef } from "./types.js";

export interface ExternalResolutionContext {
  readonly configDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly invocation?: Readonly<Record<string, string>>;
  readonly readFile?: (path: string) => Promise<string>;
}

export type ResolvedExternalValue = {
  readonly path: string;
  readonly value: string;
};

export type ExternalResolutionResult =
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] };

export function isExternalValueRef(value: unknown): value is ExternalValueRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["env"] === "string" ||
    typeof record["file"] === "string" ||
    typeof record["invocation"] === "string"
  );
}

export async function resolveExternalValue(
  ref: ExternalValueRef,
  path: string,
  context: ExternalResolutionContext,
): Promise<
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly issue: ConfigurationIssue }
> {
  if ("env" in ref) {
    const value = context.env[ref.env];
    if (value === undefined) {
      return {
        ok: false,
        issue: {
          path,
          message: `Environment variable ${ref.env} is missing.`,
        },
      };
    }
    return { ok: true, value };
  }

  if ("invocation" in ref) {
    if (
      context.invocation === undefined ||
      !Object.prototype.hasOwnProperty.call(context.invocation, ref.invocation)
    ) {
      return {
        ok: false,
        issue: {
          path,
          message: `Invocation value ${JSON.stringify(ref.invocation)} is missing.`,
        },
      };
    }
    return { ok: true, value: context.invocation[ref.invocation]! };
  }

  const absolute = resolve(context.configDirectory, ref.file);
  try {
    const read = context.readFile ?? ((filePath: string) => readFile(filePath, "utf8"));
    const contents = await read(absolute);
    return { ok: true, value: stripTrailingNewline(contents) };
  } catch {
    return {
      ok: false,
      issue: {
        path,
        message: `File reference could not be read.`,
      },
    };
  }
}

export async function resolveEnvironmentMap(
  environment: Readonly<Record<string, string | ExternalValueRef>> | undefined,
  context: ExternalResolutionContext,
  pathPrefix = "environment",
): Promise<ExternalResolutionResult> {
  if (environment === undefined) {
    return { ok: true, values: {} };
  }

  const values: Record<string, string> = {};
  const issues: ConfigurationIssue[] = [];

  for (const [key, entry] of Object.entries(environment)) {
    const path = `${pathPrefix}.${key}`;
    if (typeof entry === "string") {
      values[key] = entry;
      continue;
    }
    const resolved = await resolveExternalValue(entry, path, context);
    if (!resolved.ok) {
      issues.push(resolved.issue);
      continue;
    }
    values[key] = resolved.value;
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, values: Object.freeze(values) };
}

export function throwMissingExternalReferences(
  issues: readonly ConfigurationIssue[],
  message = "One or more external references could not be resolved.",
): never {
  throw SboxError.validation(message, {
    details: {
      issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
      issueCount: issues.length,
    },
  });
}

function stripTrailingNewline(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n") || value.endsWith("\r")) {
    return value.slice(0, -1);
  }
  return value;
}
