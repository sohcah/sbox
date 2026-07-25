/**
 * Scripted qemu-img for LocalHost volume unit tests (no real qemu-img).
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import type { RunExactCommand } from "../../src/image/subprocess.js";
import { SboxError } from "../../src/errors.js";

interface ImageMeta {
  format: string;
  virtualSize: number;
  backingFilename: string | null;
  fullBackingFilename: string | null;
}

export function createFakeQemuImgPorts(sizeBytes: number): {
  readonly ports: { readonly runCommand: RunExactCommand };
  readonly seedBase: (basePath: string) => Promise<void>;
  readonly registerWrongBacking: (childPath: string, wrongBacking: string) => Promise<void>;
  readonly registerSizeMismatch: (imagePath: string, wrongSize: number) => Promise<void>;
} {
  const meta = new Map<string, ImageMeta>();

  const runCommand: RunExactCommand = async (request) => {
    const [op, ...rest] = request.args;
    if (op === "--version") {
      return { exitCode: 0, stdout: "qemu-img version fake\n", stderr: "" };
    }
    if (op === "info" && rest[0] === "--output" && rest[1] === "json") {
      const imagePath = rest[2]!;
      let stored = meta.get(imagePath);
      if (stored === undefined && (await pathExists(imagePath))) {
        stored = {
          format: "qcow2",
          virtualSize: sizeBytes,
          backingFilename: null,
          fullBackingFilename: null,
        };
        meta.set(imagePath, stored);
      }
      if (stored === undefined) {
        throw SboxError.nativeState("qemu-img info failed.", { details: { imagePath } });
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: stored.format,
          "virtual-size": stored.virtualSize,
          ...(stored.backingFilename !== null
            ? { "backing-filename": stored.backingFilename }
            : {}),
          ...(stored.fullBackingFilename !== null
            ? { "full-backing-filename": stored.fullBackingFilename }
            : {}),
        }),
        stderr: "",
      };
    }
    if (op === "create" && rest[0] === "-f" && rest[1] === "qcow2") {
      // create -f qcow2 -b <base> -F qcow2 <child> <size>
      const backing = rest[3]!;
      const child = rest[6]!;
      const size = Number(rest[7]);
      await mkdir(dirname(child), { recursive: true });
      await writeFile(child, "fake-child");
      meta.set(child, {
        format: "qcow2",
        virtualSize: size,
        backingFilename: backing,
        fullBackingFilename: backing,
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (op === "convert") {
      // convert -f raw -O qcow2 <raw> <qcow2>
      const qcow = rest[5]!;
      await mkdir(dirname(qcow), { recursive: true });
      await writeFile(qcow, "fake-base");
      meta.set(qcow, {
        format: "qcow2",
        virtualSize: sizeBytes,
        backingFilename: null,
        fullBackingFilename: null,
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw SboxError.internal(`Unexpected fake qemu-img args: ${request.args.join(" ")}`);
  };

  return {
    ports: { runCommand },
    seedBase: async (basePath: string) => {
      await mkdir(dirname(basePath), { recursive: true });
      await writeFile(basePath, "fake-base");
      meta.set(basePath, {
        format: "qcow2",
        virtualSize: sizeBytes,
        backingFilename: null,
        fullBackingFilename: null,
      });
    },
    registerWrongBacking: async (childPath, wrongBacking) => {
      await mkdir(dirname(childPath), { recursive: true });
      await writeFile(childPath, "fake-child");
      meta.set(childPath, {
        format: "qcow2",
        virtualSize: sizeBytes,
        backingFilename: wrongBacking,
        fullBackingFilename: wrongBacking,
      });
    },
    registerSizeMismatch: async (imagePath, wrongSize) => {
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, "fake");
      meta.set(imagePath, {
        format: "qcow2",
        virtualSize: wrongSize,
        backingFilename: null,
        fullBackingFilename: null,
      });
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
