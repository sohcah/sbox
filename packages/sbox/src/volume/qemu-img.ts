/**
 * Host `qemu-img` wrappers for create/convert/info validation.
 */

import { SboxError, throwIfAborted } from "../errors.js";
import { runExactCommand, type RunExactCommand } from "../image/subprocess.js";

export interface QemuImgInfo {
  readonly format: string;
  readonly virtualSize: number;
  readonly backingFilename: string | null;
  readonly fullBackingFilename: string | null;
}

export interface QemuImgPorts {
  readonly runCommand?: RunExactCommand;
  readonly executable?: string;
}

function executable(ports?: QemuImgPorts): string {
  return ports?.executable ?? process.env["SBOX_QEMU_IMG"] ?? "qemu-img";
}

function runner(ports?: QemuImgPorts): RunExactCommand {
  return ports?.runCommand ?? runExactCommand;
}

export async function probeQemuImg(
  ports?: QemuImgPorts,
  signal?: AbortSignal,
): Promise<{ readonly available: boolean; readonly notes: readonly string[] }> {
  throwIfAborted(signal);
  const exe = executable(ports);
  try {
    const result = await runner(ports)({
      executable: exe,
      args: ["--version"],
      ...(signal !== undefined ? { signal } : {}),
      retainOutput: true,
      maxRetainBytes: 4096,
      failureCode: "capability",
      failureMessage: `${exe} is not available.`,
    });
    const version = result.stdout.trim().split("\n")[0] ?? result.stdout.trim();
    return {
      available: true,
      notes: [`${exe} available${version.length > 0 ? `: ${version}` : "."}`],
    };
  } catch (error) {
    return {
      available: false,
      notes: [
        error instanceof Error ? `${exe} probe failed: ${error.message}` : `${exe} probe failed.`,
      ],
    };
  }
}

export async function requireQemuImg(ports?: QemuImgPorts, signal?: AbortSignal): Promise<void> {
  const probe = await probeQemuImg(ports, signal);
  if (!probe.available) {
    throw SboxError.capability("Host qemu-img is required for managed volumes.", {
      details: { notes: probe.notes },
    });
  }
}

export async function qemuImgCreateOverlay(
  childPath: string,
  basePath: string,
  sizeBytes: number,
  ports?: QemuImgPorts,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const exe = executable(ports);
  await runner(ports)({
    executable: exe,
    args: ["create", "-f", "qcow2", "-b", basePath, "-F", "qcow2", childPath, String(sizeBytes)],
    ...(signal !== undefined ? { signal } : {}),
    retainOutput: true,
    failureCode: "native_state",
    failureMessage: "qemu-img create overlay failed.",
    failureDetails: { childPath, basePath, sizeBytes },
  });
}

export async function qemuImgConvertRawToQcow2(
  rawPath: string,
  qcow2Path: string,
  ports?: QemuImgPorts,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const exe = executable(ports);
  await runner(ports)({
    executable: exe,
    args: ["convert", "-f", "raw", "-O", "qcow2", rawPath, qcow2Path],
    ...(signal !== undefined ? { signal } : {}),
    retainOutput: true,
    failureCode: "native_state",
    failureMessage: "qemu-img convert to qcow2 failed.",
    failureDetails: { rawPath, qcow2Path },
  });
}

export async function qemuImgInfo(
  imagePath: string,
  ports?: QemuImgPorts,
  signal?: AbortSignal,
): Promise<QemuImgInfo> {
  throwIfAborted(signal);
  const exe = executable(ports);
  const result = await runner(ports)({
    executable: exe,
    args: ["info", "--output", "json", imagePath],
    ...(signal !== undefined ? { signal } : {}),
    retainOutput: true,
    failureCode: "native_state",
    failureMessage: "qemu-img info failed.",
    failureDetails: { imagePath },
  });
  return parseQemuImgInfoJson(result.stdout, imagePath);
}

export function parseQemuImgInfoJson(stdout: string, imagePath: string): QemuImgInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw SboxError.nativeState("qemu-img info returned invalid JSON.", {
      cause: error,
      details: { imagePath },
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw SboxError.nativeState("qemu-img info JSON must be an object.", {
      details: { imagePath },
    });
  }
  const root = parsed as Record<string, unknown>;
  const format = root["format"];
  const virtualSize = root["virtual-size"];
  if (typeof format !== "string" || format.length === 0) {
    throw SboxError.nativeState("qemu-img info missing format.", { details: { imagePath } });
  }
  if (typeof virtualSize !== "number" || !Number.isSafeInteger(virtualSize) || virtualSize < 1) {
    throw SboxError.nativeState("qemu-img info missing virtual-size.", {
      details: { imagePath },
    });
  }
  const backing = typeof root["backing-filename"] === "string" ? root["backing-filename"] : null;
  const fullBacking =
    typeof root["full-backing-filename"] === "string" ? root["full-backing-filename"] : null;
  return {
    format,
    virtualSize,
    backingFilename: backing,
    fullBackingFilename: fullBacking,
  };
}

export function assertBaseQcow2Info(
  info: QemuImgInfo,
  expectedSizeBytes: number,
  imagePath: string,
): void {
  if (info.format !== "qcow2") {
    throw SboxError.ownershipConflict("Managed volume base must be qcow2.", {
      details: { imagePath, format: info.format },
    });
  }
  if (info.virtualSize !== expectedSizeBytes) {
    throw SboxError.ownershipConflict(
      "Managed volume base virtual size does not match the declared size.",
      {
        details: {
          imagePath,
          expectedSizeBytes,
          actualSizeBytes: info.virtualSize,
          message: "Remove descendants and the base, then recreate with the new size.",
        },
      },
    );
  }
  if (info.backingFilename !== null || info.fullBackingFilename !== null) {
    throw SboxError.ownershipConflict("Managed volume base must not have a backing file.", {
      details: { imagePath },
    });
  }
}

export function assertChildQcow2Info(
  info: QemuImgInfo,
  expectedSizeBytes: number,
  expectedBackingPath: string,
  imagePath: string,
): void {
  if (info.format !== "qcow2") {
    throw SboxError.ownershipConflict("Managed volume child must be qcow2.", {
      details: { imagePath, format: info.format },
    });
  }
  if (info.virtualSize !== expectedSizeBytes) {
    throw SboxError.ownershipConflict("Managed volume child virtual size mismatch.", {
      details: {
        imagePath,
        expectedSizeBytes,
        actualSizeBytes: info.virtualSize,
      },
    });
  }
  const backing = info.fullBackingFilename ?? info.backingFilename;
  if (backing === null) {
    throw SboxError.ownershipConflict("Managed volume child is missing a backing file.", {
      details: { imagePath, expectedBackingPath },
    });
  }
  // Compare resolved paths after normalization of separators.
  const normalizedActual = backing.replaceAll("\\", "/");
  const normalizedExpected = expectedBackingPath.replaceAll("\\", "/");
  if (normalizedActual !== normalizedExpected) {
    throw SboxError.ownershipConflict("Managed volume child backing path mismatch.", {
      details: {
        imagePath,
        expectedBackingPath: normalizedExpected,
        actualBackingPath: normalizedActual,
      },
    });
  }
}
