/**
 * Per-base exclusive lock using an OS-released listen socket/pipe.
 *
 * Holding an exclusive Unix-domain (or Windows named-pipe) listener releases
 * automatically when the process exits, without stale lock files.
 *
 * The `lockKey` argument is a stable identity string (typically the logical
 * `…/base.qcow2.lock.sock` path beside the base). The actual listen address is
 * always a short hashed name: Windows named pipes, or `/tmp/sbox-vl-<hash>.sock`
 * on POSIX, so deep `SBOX_VOLUME_DATA_ROOT` values cannot exceed `sun_path`.
 */

import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import net from "node:net";
import { SboxError, throwIfAborted } from "../errors.js";

export interface VolumeLockHandle {
  release(): Promise<void>;
}

export type AcquireVolumeLock = (
  lockKey: string,
  options?: { readonly signal?: AbortSignal },
) => Promise<VolumeLockHandle>;

/** BSD `sun_path` is 104; keep comfortably under that (and Linux's 108). */
export const POSIX_VOLUME_LOCK_LISTEN_MAX = 96;

function hashKey(lockKey: string): string {
  return createHash("sha256").update(lockKey, "utf8").digest("hex").slice(0, 40);
}

function windowsPipeName(lockKey: string): string {
  return `\\\\.\\pipe\\sbox-vol-${hashKey(lockKey)}`;
}

/**
 * Resolve the OS listen address for a volume lock key.
 * Exported for tests that assert path-length safety.
 */
export function volumeLockListenPath(lockKey: string): string {
  if (process.platform === "win32") {
    return windowsPipeName(lockKey);
  }
  const path = `/tmp/sbox-vl-${hashKey(lockKey)}.sock`;
  if (path.length > POSIX_VOLUME_LOCK_LISTEN_MAX) {
    throw SboxError.internal("Volume lock listen path exceeds Unix socket limit.", {
      details: { path, length: path.length, max: POSIX_VOLUME_LOCK_LISTEN_MAX },
    });
  }
  return path;
}

function listenOnce(server: net.Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "EADDRINUSE" ||
      (error as { code?: string }).code === "EEXIST")
  );
}

/** True when something accepts connections on the lock path (holder alive). */
function probeLockHolder(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const done = (alive: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function acquireVolumeLock(
  lockKey: string,
  options?: { readonly signal?: AbortSignal },
): Promise<VolumeLockHandle> {
  throwIfAborted(options?.signal);

  const path = volumeLockListenPath(lockKey);
  const server = net.createServer();
  server.unref();

  try {
    try {
      await listenOnce(server, path);
    } catch (error) {
      if (!isAddressInUse(error)) {
        throw SboxError.internal("Failed to acquire managed volume lock.", {
          cause: error,
          details: { lockKey, listenPath: path },
        });
      }
      const alive = process.platform === "win32" ? true : await probeLockHolder(path);
      if (alive) {
        throw SboxError.busy("Managed volume base is locked by another process.", {
          details: { lockKey, listenPath: path },
        });
      }
      // Stale socket node left after process death — reclaim once.
      if (process.platform !== "win32") {
        await unlink(path).catch(() => undefined);
      }
      await listenOnce(server, path);
    }
  } catch (error) {
    server.close();
    if (error instanceof SboxError) {
      throw error;
    }
    if (isAddressInUse(error)) {
      throw SboxError.busy("Managed volume base is locked by another process.", {
        details: { lockKey, listenPath: path },
      });
    }
    throw SboxError.internal("Failed to acquire managed volume lock.", {
      cause: error,
      details: { lockKey, listenPath: path },
    });
  }

  throwIfAborted(options?.signal);

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (process.platform !== "win32") {
        try {
          await unlink(path);
        } catch {
          // Best-effort cleanup of the socket path node.
        }
      }
    },
  };
}

export async function withVolumeLock<T>(
  lockKey: string,
  run: () => Promise<T>,
  options?: { readonly signal?: AbortSignal },
): Promise<T> {
  const lock = await acquireVolumeLock(lockKey, options);
  try {
    return await run();
  } finally {
    await lock.release();
  }
}
