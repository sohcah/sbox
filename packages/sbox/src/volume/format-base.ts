/**
 * Pinned formatter image + guest mkfs.ext4 for blank raw bases.
 *
 * The formatter image must already contain `mkfs.ext4` (no package install at
 * runtime — networking is disabled). The default tag is auto-built from the
 * shipped `formatter/Dockerfile` on first use; set
 * `SBOX_VOLUME_FORMATTER_IMAGE` to supply an equivalent image instead.
 *
 * The blank raw file is bind-mounted as a host directory (not attached as a
 * virtio-blk disk). Microsandbox tries to mount disk images at boot; an
 * unformatted raw image exits before the agent is available.
 */

import { open, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SboxError, throwIfAborted } from "../errors.js";
import type { NativeRuntime } from "../native-runtime.js";
import type { HostNetworkConfig } from "../network/types.js";
import { ensureFormatterImage } from "./ensure-formatter.js";
import { DEFAULT_VOLUME_FORMATTER_IMAGE, volumeFormatterImage } from "./formatter-image.js";
import {
  qemuImgConvertRawToQcow2,
  qemuImgInfo,
  assertBaseQcow2Info,
  type QemuImgPorts,
} from "./qemu-img.js";

export { DEFAULT_VOLUME_FORMATTER_IMAGE, volumeFormatterImage };

const DISABLED_NETWORK: HostNetworkConfig = Object.freeze({
  mode: "disabled",
  allow: Object.freeze([]),
  publish: Object.freeze([]),
});

export interface FormatBasePorts {
  readonly runtime: NativeRuntime;
  readonly qemuImg?: QemuImgPorts;
  readonly execInSandbox: (request: {
    readonly name: string;
    readonly argv: readonly string[];
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly exitCode: number; readonly stderr: string }>;
  /**
   * Ensure the formatter image is available to Microsandbox before create.
   * Defaults to {@link ensureFormatterImage} (auto-build the packaged default).
   */
  readonly ensureFormatterImage?: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
}

export interface FormatAndPublishBaseRequest {
  readonly volumeRoot: string;
  readonly basePath: string;
  readonly sizeBytes: number;
  readonly signal?: AbortSignal;
}

const GUEST_STAGING_DIR = "/sbox-format";
const RAW_BASENAME = "base.raw";
const GUEST_RAW_PATH = `${GUEST_STAGING_DIR}/${RAW_BASENAME}`;

/**
 * Create blank raw → guest mkfs.ext4 → convert qcow2 → atomic publish to basePath.
 * Caller must hold the per-base lock and prove no conflicting final base.
 */
export async function formatAndPublishBase(
  request: FormatAndPublishBaseRequest,
  ports: FormatBasePorts,
): Promise<void> {
  throwIfAborted(request.signal);
  if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 1) {
    throw SboxError.validation("Volume sizeBytes must be a positive safe integer.");
  }

  await mkdir(request.volumeRoot, { recursive: true });
  const stagingId = randomBytes(8).toString("hex");
  const stagingDir = join(request.volumeRoot, `.staging-${stagingId}`);
  const rawPath = join(stagingDir, RAW_BASENAME);
  const partialPath = join(request.volumeRoot, `base.qcow2.partial-${stagingId}`);
  const formatterName = `sbox-volfmt-${stagingId}`;
  const quotaMiB = Math.max(64, Math.ceil(request.sizeBytes / (1024 * 1024)) + 32);

  await mkdir(stagingDir, { recursive: true });
  let created = false;
  try {
    await createBlankRawFile(rawPath, request.sizeBytes);

    const ensure =
      ports.ensureFormatterImage ??
      ((opts?: { readonly signal?: AbortSignal }) => ensureFormatterImage(opts));
    await ensure(request.signal !== undefined ? { signal: request.signal } : undefined);

    const live = await ports.runtime.create({
      name: formatterName,
      image: volumeFormatterImage(),
      labels: {
        "dev.sohcah.sbox/managed": "true",
        "dev.sohcah.sbox/purpose": "volume-format",
      },
      cpus: 1,
      memoryMiB: 512,
      tmpMiB: null,
      rootMiB: null,
      workdir: null,
      user: null,
      shell: null,
      hostname: null,
      maxDurationSecs: null,
      idleTimeoutSecs: null,
      env: {},
      network: DISABLED_NETWORK,
      secrets: [],
      detached: true,
      bindMounts: [
        {
          guestPath: GUEST_STAGING_DIR,
          hostPath: stagingDir,
          readonly: false,
          quotaMiB,
        },
      ],
    });
    created = true;
    try {
      await live.detach();
    } catch {
      // Exec uses a fresh native connection by name.
    }

    const mkfs = await ports.execInSandbox({
      name: formatterName,
      argv: ["mkfs.ext4", "-F", GUEST_RAW_PATH],
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (mkfs.exitCode !== 0) {
      throw SboxError.nativeState("Guest mkfs.ext4 failed while formatting volume base.", {
        details: {
          exitCode: mkfs.exitCode,
          stderr: mkfs.stderr.slice(0, 2048),
          formatterImage: volumeFormatterImage(),
          message:
            "Formatter image must contain mkfs.ext4; the default image is auto-built from formatter/Dockerfile, or set SBOX_VOLUME_FORMATTER_IMAGE.",
        },
      });
    }

    await ports.runtime.stopLiveThenFreshGet(formatterName);
    await ports.runtime.remove(formatterName);
    created = false;

    await qemuImgConvertRawToQcow2(rawPath, partialPath, ports.qemuImg, request.signal);
    const info = await qemuImgInfo(partialPath, ports.qemuImg, request.signal);
    assertBaseQcow2Info(info, request.sizeBytes, partialPath);
    await rename(partialPath, request.basePath);
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    if (created) {
      try {
        await ports.runtime.stopLiveThenFreshGet(formatterName);
      } catch {
        // ignore
      }
      try {
        await ports.runtime.remove(formatterName);
      } catch {
        // Best-effort cleanup.
      }
    }
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function createBlankRawFile(path: string, sizeBytes: number): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.truncate(sizeBytes);
  } finally {
    await handle.close();
  }
}
