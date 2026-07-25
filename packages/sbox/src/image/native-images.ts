/**
 * Native Microsandbox image seam (SDK Image + msb load CLI).
 *
 * SDK classes stay inside this module and are never re-exported.
 */

import { Image, ImageNotFoundError, MicrosandboxError } from "microsandbox";
import { SboxError } from "../errors.js";
import { mapNativeError } from "../microsandbox-runtime.js";
import { encodeMsbImageLoad } from "./docker-argv.js";
import {
  IMAGE_IDENTITY_ALGORITHM_VERSION,
  IMAGE_LABEL_KEYS,
  inspectImageOwnershipEvidence,
  parseNativeImageReference,
  formatImageContentDigest,
} from "./naming.js";
import { runExactCommand } from "./subprocess.js";
import type { HostImageSummary } from "./types.js";

export interface NativeImageEvidence {
  readonly reference: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly env: readonly string[];
  readonly contentIdentity?: string;
  readonly algorithmVersion?: number;
  readonly owned: boolean;
}

export async function nativeImageGet(reference: string): Promise<NativeImageEvidence | null> {
  try {
    await Image.get(reference);
  } catch (error) {
    if (error instanceof ImageNotFoundError) {
      return null;
    }
    if (error instanceof MicrosandboxError && error.code === "imageNotFound") {
      return null;
    }
    throw mapNativeError(error);
  }

  try {
    const detail = await Image.inspect(reference);
    const labels = normalizeLabels(detail.config?.labels ?? null);
    const env = detail.config?.env ?? [];
    const parsed = parseNativeImageReference(reference);
    const ownership =
      parsed === undefined
        ? { ok: false as const, reason: "Not a generated sbox image reference." }
        : inspectImageOwnershipEvidence(labels, env, parsed.digestHex);
    return {
      reference,
      labels,
      env,
      ...(ownership.ok
        ? {
            contentIdentity: formatImageContentDigest(ownership.digestHex),
            algorithmVersion: IMAGE_IDENTITY_ALGORITHM_VERSION,
            owned: true,
          }
        : { owned: false }),
    };
  } catch (error) {
    throw mapNativeError(error);
  }
}

export async function nativeImageList(): Promise<readonly NativeImageEvidence[]> {
  try {
    const handles = await Image.list();
    const out: NativeImageEvidence[] = [];
    for (const handle of handles) {
      const evidence = await nativeImageGet(handle.reference);
      if (evidence !== null) {
        out.push(evidence);
      }
    }
    return out;
  } catch (error) {
    throw mapNativeError(error);
  }
}

export async function nativeImageRemove(reference: string, force = false): Promise<void> {
  try {
    await Image.remove(reference, { force });
  } catch (error) {
    if (error instanceof ImageNotFoundError) {
      throw SboxError.notFound("Native image was not found.", {
        cause: error,
        details: { reference },
      });
    }
    throw mapNativeError(error);
  }
}

export async function nativeImageLoad(
  archivePath: string,
  tag: string,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
): Promise<void> {
  const encoded = encodeMsbImageLoad(archivePath, tag);
  const env = { ...process.env };
  await runExactCommand({
    executable: resolveMsbExecutable(),
    args: encoded.args,
    env,
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    failureCode: "native_state",
    failureMessage: "Failed to load image archive into Microsandbox.",
    failureDetails: { phase: "load" },
  });
}

export function toHostImageSummary(evidence: NativeImageEvidence): HostImageSummary | null {
  if (!evidence.owned || evidence.contentIdentity === undefined) {
    return null;
  }
  return {
    reference: evidence.reference,
    contentIdentity: evidence.contentIdentity as HostImageSummary["contentIdentity"],
    algorithmVersion: evidence.algorithmVersion ?? IMAGE_IDENTITY_ALGORITHM_VERSION,
    owned: true,
  };
}

function normalizeLabels(labels: Record<string, unknown> | null): Readonly<Record<string, string>> {
  if (labels === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (value !== null && value !== undefined) {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Resolve `msb` without importing microsandbox private modules.
 * Prefers MSB_PATH, then PATH lookup via spawning `msb`.
 */
function resolveMsbExecutable(): string {
  const fromEnv = process.env["MSB_PATH"];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return "msb";
}

export { IMAGE_LABEL_KEYS };
