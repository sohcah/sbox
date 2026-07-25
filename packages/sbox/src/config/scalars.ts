/**
 * Shared configuration scalars and parsers.
 */

import { SboxError } from "../errors.js";
import { isPortableSlug } from "../identity.js";

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ABSOLUTE_GUEST_PATH = /^\/(?:[^/]+(?:\/[^/]+)*)?$/;
const BINARY_SIZE = /^([1-9][0-9]*)(B|KiB|MiB|GiB|TiB)$/;
const DURATION = /^([1-9][0-9]*)(ms|s|m|h|d)$/;

export function isEnvVarName(value: string): boolean {
  return ENV_VAR_NAME.test(value);
}

export function isAbsoluteGuestPath(value: string): boolean {
  if (value.includes("\0")) {
    return false;
  }
  if (value === "/") {
    return true;
  }
  return ABSOLUTE_GUEST_PATH.test(value) && !value.includes("//") && !value.endsWith("/");
}

export function parseBinarySizeToBytes(value: string, path: string): number {
  const match = BINARY_SIZE.exec(value);
  if (match === null) {
    throw SboxError.validation(`Invalid binary size at ${path}.`, {
      details: {
        path,
        message: 'Expected a positive size such as "512MiB" or "4GiB".',
      },
    });
  }
  const amount = Number(match[1]);
  const unit = match[2]!;
  const bytes =
    unit === "B"
      ? amount
      : unit === "KiB"
        ? amount * 1024
        : unit === "MiB"
          ? amount * 1024 ** 2
          : unit === "GiB"
            ? amount * 1024 ** 3
            : amount * 1024 ** 4;
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw SboxError.validation(`Binary size at ${path} must resolve to a positive byte count.`, {
      details: { path },
    });
  }
  return bytes;
}

export function parseBinarySizeToMiB(value: string, path: string): number {
  const bytes = parseBinarySizeToBytes(value, path);
  const mib = bytes / 1024 ** 2;
  if (!Number.isInteger(mib) || mib < 1) {
    throw SboxError.validation(`Binary size at ${path} must resolve to a whole positive MiB.`, {
      details: { path },
    });
  }
  return mib;
}

export function parseDurationToSecs(value: string, path: string): number {
  const match = DURATION.exec(value);
  if (match === null) {
    throw SboxError.validation(`Invalid duration at ${path}.`, {
      details: {
        path,
        message: 'Expected a positive duration such as "30s", "10m", or "8h".',
      },
    });
  }
  const amount = Number(match[1]);
  const unit = match[2]!;
  const ms =
    unit === "ms"
      ? amount
      : unit === "s"
        ? amount * 1000
        : unit === "m"
          ? amount * 60_000
          : unit === "h"
            ? amount * 3_600_000
            : amount * 86_400_000;
  if (ms < 1000 || ms % 1000 !== 0) {
    throw SboxError.validation(`Duration at ${path} must resolve to a whole positive second.`, {
      details: { path },
    });
  }
  return ms / 1000;
}

export function assertConfigSlug(value: string, path: string): string {
  if (!isPortableSlug(value)) {
    throw SboxError.validation(`Invalid portable slug at ${path}.`, {
      details: {
        path,
        message:
          "Expected a lowercase slug matching [a-z][a-z0-9]*(-[a-z0-9]+)* up to 63 characters.",
      },
    });
  }
  return value;
}

export function assertEnvVarName(value: string, path: string): string {
  if (!isEnvVarName(value)) {
    throw SboxError.validation(`Invalid environment variable name at ${path}.`, {
      details: {
        path,
        message: "Expected a name matching [A-Za-z_][A-Za-z0-9_]*.",
      },
    });
  }
  return value;
}

export function assertAbsoluteGuestPath(value: string, path: string): string {
  if (!isAbsoluteGuestPath(value)) {
    throw SboxError.validation(`Invalid absolute guest path at ${path}.`, {
      details: {
        path,
        message: "Expected an absolute POSIX guest path without empty segments.",
      },
    });
  }
  return value;
}

export function isBinarySize(value: string): boolean {
  return BINARY_SIZE.test(value);
}

export function isPositiveDuration(value: string): boolean {
  return DURATION.test(value);
}
