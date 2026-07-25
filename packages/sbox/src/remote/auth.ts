/**
 * Timing-safe bearer token authentication for the trusted-host API.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { SboxError } from "../errors.js";

export function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export function authorizeBearer(
  req: Pick<IncomingMessage, "headers">,
  expectedToken: string,
): void {
  const provided = extractBearerToken(
    typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
  );
  if (provided === undefined) {
    throw SboxError.authentication("Missing bearer token.");
  }
  const left = Buffer.from(provided);
  const right = Buffer.from(expectedToken);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw SboxError.authentication("Invalid bearer token.");
  }
}
