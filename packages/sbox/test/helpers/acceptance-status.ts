/**
 * Stable, always-visible acceptance status lines for `pnpm test:acceptance`.
 */

import { stripVTControlCharacters } from "node:util";

export const ACCEPTANCE_STATUS_PREFIX = "sbox-acceptance-status:";

export type AcceptanceStatus = "passed" | "unavailable" | "failed";

export function formatAcceptanceStatusLine(status: AcceptanceStatus, detail?: string): string {
  if (detail !== undefined && detail.length > 0) {
    return `${ACCEPTANCE_STATUS_PREFIX} ${status} ${detail}`;
  }
  return `${ACCEPTANCE_STATUS_PREFIX} ${status}`;
}

export function findAcceptanceStatusLine(output: string): string | undefined {
  return output
    .split("\n")
    .map((line) => stripVTControlCharacters(line).trim())
    .find((line) => line.startsWith(ACCEPTANCE_STATUS_PREFIX));
}

export function parseAcceptanceStatusLine(line: string): AcceptanceStatus | undefined {
  const trimmed = stripVTControlCharacters(line).trim();
  if (!trimmed.startsWith(ACCEPTANCE_STATUS_PREFIX)) {
    return undefined;
  }
  const rest = trimmed.slice(ACCEPTANCE_STATUS_PREFIX.length).trim();
  const status = rest.split(/\s+/)[0];
  if (status === "passed" || status === "unavailable" || status === "failed") {
    return status;
  }
  return undefined;
}
