/**
 * YAML adapter for project and user configuration.
 */

import { parse as parseYaml } from "yaml";
import { SboxError } from "../errors.js";
import type { ConfigurationIssue, ProjectConfig, UserConfig } from "./types.js";
import {
  parseUserConfig,
  parseYamlProjectInput,
  tryParseUserConfig,
  tryParseYamlProjectInput,
} from "./validate.js";

export function loadProjectConfigFromYaml(text: string): ProjectConfig {
  const document = parseYamlDocument(text, "project");
  return parseYamlProjectInput(document);
}

export function tryLoadProjectConfigFromYaml(
  text: string,
):
  | { readonly ok: true; readonly value: ProjectConfig }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] } {
  try {
    const document = parseYamlDocument(text, "project");
    return tryParseYamlProjectInput(document);
  } catch (error) {
    if (error instanceof SboxError && error.code === "validation") {
      return {
        ok: false,
        issues: [{ path: "(root)", message: error.message }],
      };
    }
    throw error;
  }
}

export function loadUserConfigFromYaml(text: string): UserConfig {
  const document = parseYamlDocument(text, "user");
  return parseUserConfig(document);
}

export function tryLoadUserConfigFromYaml(
  text: string,
):
  | { readonly ok: true; readonly value: UserConfig }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] } {
  try {
    const document = parseYamlDocument(text, "user");
    return tryParseUserConfig(document);
  } catch (error) {
    if (error instanceof SboxError && error.code === "validation") {
      return {
        ok: false,
        issues: [{ path: "(root)", message: error.message }],
      };
    }
    throw error;
  }
}

function parseYamlDocument(text: string, kind: "project" | "user"): unknown {
  let document: unknown;
  try {
    document = parseYaml(text, {
      uniqueKeys: true,
      strict: true,
      maxAliasCount: 0,
    });
  } catch (error) {
    throw SboxError.validation(`Failed to parse ${kind} YAML.`, {
      details: {
        path: "(root)",
        message: error instanceof Error ? "YAML syntax error." : "YAML syntax error.",
      },
      cause: error,
    });
  }
  if (document === null || document === undefined) {
    throw SboxError.validation(`${kind} YAML document is empty.`, {
      details: { path: "(root)", message: "Expected a mapping document." },
    });
  }
  return document;
}
