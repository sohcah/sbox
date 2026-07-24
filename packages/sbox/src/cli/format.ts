/**
 * Consistent text and JSON CLI result formatting.
 */

import { isSboxError } from "../errors.js";

export type CliOutputFormat = "text" | "json";

export interface CliResult {
  readonly ok: boolean;
  readonly command: string;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

export function formatCliResult(result: CliResult, format: CliOutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (!result.ok) {
    const code = result.error?.code ?? "error";
    const message = result.error?.message ?? "Command failed.";
    return `error(${code}): ${message}\n`;
  }
  return formatTextData(result.command, result.data);
}

export function cliErrorResult(command: string, error: unknown): CliResult {
  if (isSboxError(error)) {
    const safe = error.toSafeJSON();
    return {
      ok: false,
      command,
      error: {
        code: safe.code,
        message: safe.message,
        details: safe.details,
      },
    };
  }
  return {
    ok: false,
    command,
    error: {
      code: "internal",
      message: error instanceof Error ? error.message : "Command failed.",
      details: {},
    },
  };
}

function formatTextData(command: string, data: unknown): string {
  if (data === undefined || data === null) {
    return `ok: ${command}\n`;
  }
  if (typeof data === "string") {
    return data.endsWith("\n") ? data : `${data}\n`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return "(none)\n";
    }
    return `${data.map((entry) => formatTextLine(entry)).join("\n")}\n`;
  }
  if (typeof data === "object") {
    return `${formatTextLine(data)}\n`;
  }
  return `${String(data)}\n`;
}

function formatTextLine(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return String(value);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["project"] === "string" &&
    typeof record["profile"] === "string" &&
    typeof record["instance"] === "string"
  ) {
    const state = record["state"] !== undefined ? ` ${String(record["state"])}` : "";
    const image = record["image"] !== undefined ? ` ${String(record["image"])}` : "";
    return `${record["project"]}/${record["profile"]}/${record["instance"]}${state}${image}`;
  }
  return JSON.stringify(value);
}
