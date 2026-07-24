/**
 * CLI exit codes for operational results.
 *
 * - 0: success
 * - 1: general operational failure
 * - 2: validation / configuration error
 * - 3: ownership conflict or creation drift
 * - 4: not found
 * - 5: already exists
 * - 130: cancellation (AbortError)
 */

import { isAbortError, isSboxError, type SboxError } from "../errors.js";

export const EXIT_SUCCESS = 0;
export const EXIT_OPERATIONAL = 1;
export const EXIT_VALIDATION = 2;
export const EXIT_OWNERSHIP = 3;
export const EXIT_NOT_FOUND = 4;
export const EXIT_ALREADY_EXISTS = 5;
export const EXIT_CANCELLED = 130;

export function exitCodeForError(error: unknown): number {
  if (isAbortError(error)) {
    return EXIT_CANCELLED;
  }
  if (!isSboxError(error)) {
    return EXIT_OPERATIONAL;
  }
  return exitCodeForSboxError(error);
}

export function exitCodeForSboxError(error: SboxError): number {
  switch (error.code) {
    case "validation":
      return EXIT_VALIDATION;
    case "ownership_conflict":
      return EXIT_OWNERSHIP;
    case "not_found":
      return EXIT_NOT_FOUND;
    case "already_exists":
      return EXIT_ALREADY_EXISTS;
    case "cancellation":
      return EXIT_CANCELLED;
    default:
      return EXIT_OPERATIONAL;
  }
}
