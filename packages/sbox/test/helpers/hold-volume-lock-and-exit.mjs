/**
 * Acquires a volume lock on argv[1], prints "held", then exits without
 * release — proves OS reclaim after process death.
 *
 * Imports the built lock module (requires `pnpm build`).
 */
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const lockPath = process.argv[2];
if (typeof lockPath !== "string" || lockPath.length === 0) {
  console.error("usage: hold-volume-lock-and-exit.mjs <lock-socket-path>");
  process.exit(2);
}

const distLock = join(dirname(fileURLToPath(import.meta.url)), "../../dist/volume/lock.js");
try {
  await access(distLock);
} catch {
  console.error(`missing built module: ${distLock}`);
  process.exit(3);
}

const { acquireVolumeLock } = await import(pathToFileURL(distLock).href);
await acquireVolumeLock(lockPath);
process.stdout.write("held\n");
process.exit(0);
