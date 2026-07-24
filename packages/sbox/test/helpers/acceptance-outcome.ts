import { isSboxError, type SboxError } from "../../src/errors.js";

export type AcceptanceOutcome = "unavailable" | "failed";

const UNAVAILABLE_REASONS = new Set([
  "registry_unavailable",
  "image_unavailable",
  "missing_runtime",
  "unsupported_hypervisor",
]);

/**
 * Classify acceptance failures using application error codes/details.
 * Does not widen message regexes over raw native text.
 */
export function classifyAcceptanceFailure(error: unknown): AcceptanceOutcome {
  if (!isSboxError(error)) {
    return "failed";
  }
  return classifySboxAcceptanceFailure(error);
}

export function classifySboxAcceptanceFailure(error: SboxError): AcceptanceOutcome {
  if (error.code !== "capability") {
    return "failed";
  }
  const reason = error.details["unavailableReason"];
  if (typeof reason === "string" && UNAVAILABLE_REASONS.has(reason)) {
    return "unavailable";
  }
  return "failed";
}
