/**
 * Ensure the default volume formatter image is loaded into Microsandbox.
 *
 * Lazily builds `packages/sbox/formatter/Dockerfile` (shipped with the package)
 * via Docker and loads it with `msb image load` when the default tag is missing.
 * Custom `SBOX_VOLUME_FORMATTER_IMAGE` overrides are never auto-built.
 */

import { access, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SboxError, throwIfAborted } from "../errors.js";
import { encodeDockerBuild, encodeDockerSave } from "../image/docker-argv.js";
import { nativeImageGet, nativeImageLoad } from "../image/native-images.js";
import { hostDockerPlatform } from "../image/platform.js";
import { runExactCommand, type RunExactCommand } from "../image/subprocess.js";
import { DEFAULT_VOLUME_FORMATTER_IMAGE, volumeFormatterImage } from "./formatter-image.js";

export interface EnsureFormatterImagePorts {
  readonly get?: (reference: string) => Promise<unknown | null>;
  readonly load?: (
    archivePath: string,
    tag: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<void>;
  readonly runCommand?: RunExactCommand;
  readonly dockerfilePath?: string;
  readonly platform?: string;
}

export interface EnsureFormatterImageResult {
  readonly image: string;
  /** True when this call performed docker build + msb load. */
  readonly built: boolean;
}

type Inflight = {
  readonly promise: Promise<EnsureFormatterImageResult>;
};

/** In-process coalescing for concurrent first-use builds. */
let inflight: Inflight | undefined;

/**
 * Resolve the shipped formatter Dockerfile next to the package root.
 * From `dist/volume/*.js` that is `../../formatter/Dockerfile`.
 */
export function defaultFormatterDockerfilePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../formatter/Dockerfile");
}

export async function ensureFormatterImage(
  options?: { readonly signal?: AbortSignal },
  ports: EnsureFormatterImagePorts = {},
): Promise<EnsureFormatterImageResult> {
  throwIfAborted(options?.signal);
  const image = volumeFormatterImage();
  if (image !== DEFAULT_VOLUME_FORMATTER_IMAGE) {
    return { image, built: false };
  }

  const get = ports.get ?? nativeImageGet;
  const existing = await get(image);
  if (existing !== null) {
    return { image, built: false };
  }

  if (inflight !== undefined) {
    return inflight.promise;
  }

  const promise = runBuildAndLoad(image, options?.signal, ports).finally(() => {
    if (inflight?.promise === promise) {
      inflight = undefined;
    }
  });
  inflight = { promise };
  return promise;
}

/** Test seam: clear coalescing state between cases. */
export function clearEnsureFormatterImageCoalescing(): void {
  inflight = undefined;
}

async function runBuildAndLoad(
  image: string,
  signal: AbortSignal | undefined,
  ports: EnsureFormatterImagePorts,
): Promise<EnsureFormatterImageResult> {
  throwIfAborted(signal);
  const dockerfilePath = ports.dockerfilePath ?? defaultFormatterDockerfilePath();
  try {
    await access(dockerfilePath, fsConstants.F_OK);
  } catch (error) {
    throw SboxError.capability("Volume formatter Dockerfile is missing from the package.", {
      cause: error,
      details: {
        unavailableReason: "image_unavailable",
        dockerfilePath,
        image,
      },
    });
  }

  const runCommand = ports.runCommand ?? runExactCommand;
  const load = ports.load ?? nativeImageLoad;
  const platform = ports.platform ?? hostDockerPlatform();
  const context = dirname(dockerfilePath);
  const staging = await mkdtemp(join(tmpdir(), "sbox-volfmt-"));
  const archivePath = join(staging, "formatter.tar");

  try {
    const build = encodeDockerBuild({
      context,
      dockerfile: dockerfilePath,
      tag: image,
      platform,
    });
    try {
      await runCommand({
        executable: build.executable,
        args: build.args,
        ...(signal !== undefined ? { signal } : {}),
        failureCode: "capability",
        failureMessage: "Failed to build the volume formatter image.",
        failureDetails: {
          unavailableReason: "image_unavailable",
          phase: "docker",
          image,
        },
      });
    } catch (error) {
      if (error instanceof SboxError) {
        throw error;
      }
      throw SboxError.capability("Failed to build the volume formatter image.", {
        cause: error,
        details: {
          unavailableReason: "image_unavailable",
          phase: "docker",
          image,
        },
      });
    }

    const save = encodeDockerSave(image, archivePath);
    await runCommand({
      executable: save.executable,
      args: save.args,
      ...(signal !== undefined ? { signal } : {}),
      failureCode: "capability",
      failureMessage: "Failed to export the volume formatter image.",
      failureDetails: {
        unavailableReason: "image_unavailable",
        phase: "export",
        image,
      },
    });

    await load(archivePath, image, signal !== undefined ? { signal } : undefined);

    const get = ports.get ?? nativeImageGet;
    const after = await get(image);
    if (after === null) {
      throw SboxError.capability("Volume formatter image was not available after load.", {
        details: {
          unavailableReason: "image_unavailable",
          phase: "load",
          image,
        },
      });
    }

    return { image, built: true };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
