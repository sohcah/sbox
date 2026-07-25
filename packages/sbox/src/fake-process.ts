/**
 * In-memory process/PTY/transfer behavior for FakeHost contract tests.
 */

import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SboxError, throwIfAborted } from "./errors.js";
import {
  INPUT_SETTLED,
  closeAsyncIterator,
  nextOrSettled,
  observeDetached,
} from "./process/async-input.js";
import { BoundedAsyncQueue, DEFAULT_STREAM_QUEUE_CAPACITY } from "./process/bounded-queue.js";
import { collectProcessEvents } from "./process/collect.js";
import { utf8ToBytes } from "./process/decode.js";
import { assertPtyDimension, assertTimeoutMs } from "./process/limits.js";
import type {
  HostCollectedExecOptions,
  HostPtyOptions,
  HostStreamingExecOptions,
  ProcessSession,
  ProcessStdin,
  PtySession,
  PtySize,
} from "./process/session.js";
import { permissionBits } from "./transfer/archive.js";
import {
  assertGuestAbsolutePath,
  assertStandaloneSymlinkTarget,
  assertSymlinkTargetInsideRoot,
  posixDirname,
} from "./transfer/paths.js";
import { publishHostPath, removePathQuiet, stagingNameBeside } from "./transfer/publish-host.js";
import type { HostCopyOptions } from "./transfer/types.js";
import type { ProcessEvent, ProcessResult } from "./types.js";

/** Test seam: fail once immediately before applying a transfer root directory mode. */
let failRootModeOnce = false;

/** @internal Visible for atomic-publication tests. */
export function failNextTransferRootMode(): void {
  failRootModeOnce = true;
}

function throwIfRootModeInjectedFailure(): void {
  if (!failRootModeOnce) {
    return;
  }
  failRootModeOnce = false;
  throw SboxError.nativeState("Injected root directory mode failure.");
}

export type FakeFsNode =
  | { readonly kind: "file"; mode: number; data: Uint8Array }
  | { readonly kind: "directory"; mode: number }
  | { readonly kind: "symlink"; target: string };

export class FakeSandboxFilesystem {
  private readonly nodes = new Map<string, FakeFsNode>();

  constructor() {
    this.nodes.set("/", { kind: "directory", mode: 0o755 });
  }

  clear(): void {
    this.nodes.clear();
    this.nodes.set("/", { kind: "directory", mode: 0o755 });
  }

  get(path: string): FakeFsNode | undefined {
    return this.nodes.get(normalizeGuest(path));
  }

  set(path: string, node: FakeFsNode): void {
    this.nodes.set(normalizeGuest(path), node);
  }

  delete(path: string): void {
    this.nodes.delete(normalizeGuest(path));
  }

  entriesUnder(root: string): Array<[string, FakeFsNode]> {
    const prefix = normalizeGuest(root);
    const out: Array<[string, FakeFsNode]> = [];
    for (const [path, node] of this.nodes) {
      if (path === prefix) {
        continue;
      }
      if (prefix === "/" ? path.startsWith("/") : path.startsWith(`${prefix}/`)) {
        out.push([path, node]);
      }
    }
    return out.toSorted(([a], [b]) => a.localeCompare(b));
  }
}

export async function fakeExecCollected(
  argv: readonly string[],
  options: HostCollectedExecOptions,
  hooks: FakeExecHooks,
): Promise<ProcessResult> {
  const collectedStdin =
    options.stdin !== undefined ? stdinFromCollected(options.stdin) : undefined;
  const session = await fakeExecStream(
    argv,
    {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.user !== undefined ? { user: options.user } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(collectedStdin !== undefined ? { stdin: collectedStdin } : {}),
    },
    hooks,
  );
  try {
    return await collectProcessEvents(session, {
      ...(options.stdoutMaxBytes !== undefined ? { stdoutMaxBytes: options.stdoutMaxBytes } : {}),
      ...(options.stderrMaxBytes !== undefined ? { stderrMaxBytes: options.stderrMaxBytes } : {}),
      onOverflow: () => session.cancel("output-limit"),
    });
  } finally {
    await session[Symbol.asyncDispose]();
  }
}

export interface FakeExecHooks {
  readonly run: (
    argv: readonly string[],
    stdin: Uint8Array,
  ) => Promise<{
    readonly exitCode: number;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
  }>;
}

export async function fakeExecStream(
  argv: readonly string[],
  options: HostStreamingExecOptions,
  hooks: FakeExecHooks,
): Promise<ProcessSession> {
  throwIfAborted(options.signal);
  if (argv.length === 0) {
    throw SboxError.validation("Command argv must not be empty.", { details: { path: "argv" } });
  }
  assertTimeoutMs(options.timeoutMs);
  return new FakeProcessSession(argv, options, hooks);
}

export async function fakePty(
  argv: readonly string[],
  options: HostPtyOptions,
): Promise<PtySession> {
  throwIfAborted(options.signal);
  if (argv.length === 0) {
    throw SboxError.validation("PTY argv must not be empty.", { details: { path: "argv" } });
  }
  assertTimeoutMs(options.timeoutMs);
  if (options.rows !== undefined) {
    assertPtyDimension(options.rows, "rows");
  }
  if (options.cols !== undefined) {
    assertPtyDimension(options.cols, "cols");
  }
  return new FakePtySession(options);
}

export async function fakeCopyHostToGuest(
  fs: FakeSandboxFilesystem,
  hostPath: string,
  guestPath: string,
  options: HostCopyOptions = {},
): Promise<void> {
  throwIfAborted(options.signal);
  const absHost = resolve(hostPath);
  const absGuest = assertGuestAbsolutePath(guestPath, "guestPath");
  const overwrite = options.overwrite ?? "error";
  const st = await lstat(absHost).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw SboxError.notFound("Host path was not found.", { details: { path: "hostPath" } });
    }
    throw SboxError.validation("Host path is not readable.", {
      cause: error,
      details: { path: "hostPath" },
    });
  });
  if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
    throw SboxError.validation("Special files are not supported for transfer.", {
      details: { path: "hostPath" },
    });
  }
  if (st.isSymbolicLink()) {
    const target = await readlink(absHost);
    assertStandaloneSymlinkTarget(target, absGuest, "guestPath");
    putGuestSymlink(fs, absGuest, target, posixDirname(absGuest), overwrite);
    return;
  }
  if (st.isFile()) {
    const data = new Uint8Array(await readFile(absHost));
    putGuestFile(fs, absGuest, data, permissionBits(st.mode), overwrite);
    return;
  }
  if (st.isDirectory()) {
    await copyHostDir(fs, absHost, absGuest, absGuest, overwrite, options.signal);
    return;
  }
  throw SboxError.validation("Host path type is not supported for transfer.", {
    details: { path: "hostPath" },
  });
}

export async function fakeCopyGuestToHost(
  fs: FakeSandboxFilesystem,
  guestPath: string,
  hostPath: string,
  options: HostCopyOptions = {},
): Promise<void> {
  throwIfAborted(options.signal);
  const absHost = resolve(hostPath);
  const absGuest = assertGuestAbsolutePath(guestPath, "guestPath");
  const overwrite = options.overwrite ?? "error";
  const node = fs.get(absGuest);
  if (node === undefined) {
    throw SboxError.notFound("Guest path was not found.", { details: { path: "guestPath" } });
  }
  if (node.kind === "symlink") {
    assertStandaloneSymlinkTarget(node.target, absGuest, "guestPath");
    await publishHostSymlink(absHost, node.target, overwrite);
    return;
  }
  if (node.kind === "file") {
    await publishHostFile(absHost, node.data, node.mode, overwrite);
    return;
  }
  await copyGuestDir(fs, absGuest, absHost, absGuest, overwrite, options.signal);
}

function stdinFromCollected(
  stdin: string | Uint8Array | undefined,
): AsyncIterable<Uint8Array> | undefined {
  if (stdin === undefined) {
    return undefined;
  }
  const bytes = typeof stdin === "string" ? utf8ToBytes(stdin) : stdin;
  return (async function* () {
    yield bytes;
  })();
}

class FakeProcessSession implements ProcessSession {
  private readonly events: BoundedAsyncQueue<ProcessEvent>;
  private exitCode: number | null = null;
  private failure: SboxError | null = null;
  private settled = false;
  private finishing: Promise<void> | null = null;
  private stdinChunks: Uint8Array[] = [];
  private stdinEnded = false;
  private readonly abortHandler: () => void;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly runTask: Promise<void>;
  private readonly stdinIterator?: AsyncIterator<Uint8Array>;
  private readonly stdinForward?: Promise<void>;
  private settleResolve: (() => void) | null = null;
  private readonly whenSettled: Promise<void>;

  readonly stdin: ProcessStdin;

  constructor(
    private readonly argv: readonly string[],
    options: HostStreamingExecOptions,
    private readonly hooks: FakeExecHooks,
  ) {
    this.events = new BoundedAsyncQueue(DEFAULT_STREAM_QUEUE_CAPACITY);
    this.abortSignal = options.signal;
    this.whenSettled = new Promise<void>((resolveSettle) => {
      this.settleResolve = resolveSettle;
    });
    this.stdin = {
      write: async (data) => {
        this.ensureOpen();
        this.stdinChunks.push(typeof data === "string" ? utf8ToBytes(data) : data);
      },
      end: async () => {
        this.stdinEnded = true;
      },
    };
    this.abortHandler = () => {
      void this.cancel("aborted");
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        void this.cancel("aborted");
      } else {
        options.signal.addEventListener("abort", this.abortHandler, { once: true });
      }
    }
    if (options.stdin !== undefined) {
      this.stdinIterator = options.stdin[Symbol.asyncIterator]();
      this.stdinForward = this.forwardStdin(this.stdinIterator);
    }
    this.runTask = this.run(options);
  }

  [Symbol.asyncIterator](): AsyncIterator<ProcessEvent> {
    return {
      next: async (): Promise<IteratorResult<ProcessEvent>> => {
        const result = await this.events.shift();
        if (result.kind === "value") {
          return { done: false, value: result.value };
        }
        if (result.error !== null) {
          throw result.error;
        }
        if (this.failure !== null) {
          throw this.failure;
        }
        return { done: true, value: undefined };
      },
    };
  }

  async wait(): Promise<{ readonly exitCode: number; readonly signal: string | null }> {
    await this.runTask;
    if (this.failure !== null) {
      throw this.failure;
    }
    if (this.exitCode === null) {
      throw SboxError.internal("Process ended without exit.");
    }
    return { exitCode: this.exitCode, signal: null };
  }

  async cancel(reason = "cancelled"): Promise<void> {
    if (this.settled || this.finishing !== null) {
      await this.finishing;
      return;
    }
    this.failure = SboxError.cancellation(`Process was cancelled (${reason}).`);
    await this.finish();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.settled) {
      await this.cancel("disposed");
    } else {
      await this.finishing;
    }
  }

  private async run(options: HostStreamingExecOptions): Promise<void> {
    try {
      await this.push({ type: "started", pid: 1 });
      assertTimeoutMs(options.timeoutMs);
      if (this.stdinForward !== undefined) {
        // Wait until the owned stdin forward ends or the session settles.
        await Promise.race([this.stdinForward, this.whenSettled]);
      } else {
        await this.stdin.end();
      }
      // Allow a microtask for manual stdin writes in tests.
      await Promise.resolve();
      while (!this.stdinEnded && !this.settled) {
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
      }
      if (this.settled) {
        return;
      }
      const stdin = concat(this.stdinChunks);
      const result = await this.hooks.run(this.argv, stdin);
      if (this.settled) {
        return;
      }
      if (result.stdout.byteLength > 0) {
        await this.push({ type: "stdout", data: result.stdout });
      }
      if (result.stderr.byteLength > 0) {
        await this.push({ type: "stderr", data: result.stderr });
      }
      this.exitCode = result.exitCode;
      await this.push({ type: "exited", exitCode: result.exitCode, signal: null });
      await this.finish();
    } catch (error) {
      if (!this.settled) {
        this.failure =
          error instanceof SboxError
            ? error
            : SboxError.internal("Fake process failed.", { cause: error });
        await this.finish();
      }
    }
  }

  private async forwardStdin(iterator: AsyncIterator<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        if (this.settled) {
          return;
        }
        const nextPromise = iterator.next();
        const raced = await nextOrSettled(nextPromise, this.whenSettled, () => this.settled);
        if (raced === INPUT_SETTLED || this.settled) {
          observeDetached(nextPromise);
          return;
        }
        if (raced.done) {
          await this.stdin.end();
          return;
        }
        await this.stdin.write(raced.value);
      }
    } catch (error) {
      if (!this.settled) {
        this.failure =
          error instanceof SboxError
            ? error
            : SboxError.internal("Fake stdin failed.", { cause: error });
        await this.cancel("stdin-error");
      }
    }
  }

  private async push(event: ProcessEvent): Promise<void> {
    await this.events.push(event);
  }

  private async finish(): Promise<void> {
    if (this.finishing !== null) {
      await this.finishing;
      return;
    }
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.finishing = this.finishBody();
    await this.finishing;
  }

  private async finishBody(): Promise<void> {
    this.settleResolve?.();
    this.settleResolve = null;
    if (this.abortSignal !== undefined) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
    this.events.close(this.failure ?? undefined);
    if (this.stdinIterator !== undefined) {
      closeAsyncIterator(this.stdinIterator);
    }
    if (this.stdinForward !== undefined) {
      observeDetached(this.stdinForward);
    }
  }

  private ensureOpen(): void {
    if (this.settled) {
      throw this.failure ?? SboxError.nativeState("Process session is already closed.");
    }
  }
}

class FakePtySession implements PtySession {
  private readonly outputQueue: BoundedAsyncQueue<Uint8Array>;
  private exitCode: number | null = null;
  private failure: SboxError | null = null;
  private settled = false;
  private finishing: Promise<void> | null = null;
  private size: PtySize;
  private readonly abortHandler: () => void;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly inputIterator?: AsyncIterator<Uint8Array>;
  private readonly inputTask?: Promise<void>;
  private settleResolve: (() => void) | null = null;
  private readonly whenSettled: Promise<void>;
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly timeoutMs: number | undefined;
  private pumpTask: Promise<void>;

  constructor(options: HostPtyOptions) {
    this.outputQueue = new BoundedAsyncQueue(DEFAULT_STREAM_QUEUE_CAPACITY);
    this.size = {
      rows: assertPtyDimension(options.rows ?? 24, "rows"),
      cols: assertPtyDimension(options.cols ?? 80, "cols"),
    };
    this.abortSignal = options.signal;
    this.timeoutMs = assertTimeoutMs(options.timeoutMs);
    this.whenSettled = new Promise<void>((resolveSettle) => {
      this.settleResolve = resolveSettle;
    });
    this.abortHandler = () => {
      void this.cancel("aborted");
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        void this.cancel("aborted");
      } else {
        options.signal.addEventListener("abort", this.abortHandler, { once: true });
      }
    }
    if (this.timeoutMs !== undefined) {
      this.timeoutTimer = setTimeout(() => {
        void this.failTimeout();
      }, this.timeoutMs);
      this.timeoutTimer.unref?.();
    }
    if (options.input !== undefined) {
      this.inputIterator = options.input[Symbol.asyncIterator]();
      this.inputTask = this.forward(this.inputIterator);
    }
    this.pumpTask = Promise.resolve();
  }

  get output(): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => ({
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          const result = await this.outputQueue.shift();
          if (result.kind === "value") {
            return { done: false, value: result.value };
          }
          if (result.error !== null) {
            throw result.error;
          }
          if (this.failure !== null) {
            throw this.failure;
          }
          return { done: true, value: undefined };
        },
      }),
    };
  }

  async write(data: Uint8Array | string): Promise<void> {
    this.ensureOpen();
    const bytes = typeof data === "string" ? utf8ToBytes(data) : data;
    await this.outputQueue.push(bytes);
  }

  async resize(size: PtySize): Promise<void> {
    this.ensureOpen();
    this.size = {
      rows: assertPtyDimension(size.rows, "rows"),
      cols: assertPtyDimension(size.cols, "cols"),
    };
    await this.outputQueue.push(utf8ToBytes(`\x1b[8;${this.size.rows};${this.size.cols}t`));
  }

  async wait(): Promise<{ readonly exitCode: number; readonly signal: string | null }> {
    await this.pumpTask;
    if (!this.settled) {
      // With an abort signal or timeout, behave like a real PTY: wait for the
      // process to settle. Remote sessions always pass a signal, so the server
      // can await wait() without immediately ending the fake session.
      // Without either, wait() completes with exit 0 for simple local tests.
      // Remote clients send `{type:"complete"}` which calls complete().
      if (this.timeoutMs !== undefined || this.abortSignal !== undefined) {
        await this.whenSettled;
      } else {
        this.exitCode = 0;
        await this.finish();
      }
    }
    if (this.failure !== null) {
      throw this.failure;
    }
    return { exitCode: this.exitCode ?? 0, signal: null };
  }

  /** Settle successfully (remote client `wait()` / local wait without a live child). */
  async complete(): Promise<void> {
    if (this.settled || this.finishing !== null) {
      await this.finishing;
      return;
    }
    this.exitCode = 0;
    await this.finish();
  }

  async cancel(reason = "cancelled"): Promise<void> {
    if (this.settled || this.finishing !== null) {
      await this.finishing;
      return;
    }
    this.failure = SboxError.cancellation(`PTY session was cancelled (${reason}).`);
    await this.finish();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.settled) {
      await this.cancel("disposed");
    } else {
      await this.finishing;
    }
  }

  private async failTimeout(): Promise<void> {
    if (this.settled || this.finishing !== null) {
      return;
    }
    this.failure = SboxError.timeout("PTY session timed out.");
    await this.finish();
  }

  private async forward(iterator: AsyncIterator<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        if (this.settled) {
          return;
        }
        const nextPromise = iterator.next();
        const raced = await nextOrSettled(nextPromise, this.whenSettled, () => this.settled);
        if (raced === INPUT_SETTLED || this.settled) {
          observeDetached(nextPromise);
          return;
        }
        if (raced.done) {
          return;
        }
        await this.write(raced.value);
      }
    } catch {
      // Ignore late input errors after settlement.
    }
  }

  private async finish(): Promise<void> {
    if (this.finishing !== null) {
      await this.finishing;
      return;
    }
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.finishing = this.finishBody();
    await this.finishing;
  }

  private async finishBody(): Promise<void> {
    this.settleResolve?.();
    this.settleResolve = null;
    if (this.timeoutTimer !== undefined) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
    if (this.abortSignal !== undefined) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
    this.outputQueue.close(this.failure ?? undefined);
    if (this.inputIterator !== undefined) {
      closeAsyncIterator(this.inputIterator);
    }
    if (this.inputTask !== undefined) {
      observeDetached(this.inputTask);
    }
  }

  private ensureOpen(): void {
    if (this.settled) {
      throw this.failure ?? SboxError.nativeState("PTY session is already closed.");
    }
  }
}

function normalizeGuest(path: string): string {
  if (path === "/") {
    return "/";
  }
  return path.replace(/\/+$/, "") || "/";
}

function putGuestFile(
  fs: FakeSandboxFilesystem,
  path: string,
  data: Uint8Array,
  mode: number,
  overwrite: "error" | "replace",
): void {
  ensureGuestParent(fs, path);
  const existing = fs.get(path);
  if (existing !== undefined) {
    if (existing.kind === "directory") {
      throw SboxError.validation("Cannot overwrite a guest directory with a file.", {
        details: { path: "guestPath" },
      });
    }
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Guest destination already exists.", {
        details: { path: "guestPath" },
      });
    }
  }
  fs.set(path, { kind: "file", mode: permissionBits(mode), data });
}

function putGuestSymlink(
  fs: FakeSandboxFilesystem,
  path: string,
  target: string,
  root: string,
  overwrite: "error" | "replace",
): void {
  assertSymlinkTargetInsideRoot(target, posixDirname(path), root, "guestPath");
  ensureGuestParent(fs, path);
  const existing = fs.get(path);
  if (existing !== undefined) {
    if (existing.kind === "directory") {
      throw SboxError.validation("Cannot overwrite a guest directory with a symlink.", {
        details: { path: "guestPath" },
      });
    }
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Guest destination already exists.", {
        details: { path: "guestPath" },
      });
    }
  }
  fs.set(path, { kind: "symlink", target });
}

function ensureGuestParent(fs: FakeSandboxFilesystem, path: string): void {
  const parent = posixDirname(path);
  if (parent === "/") {
    return;
  }
  if (fs.get(parent) === undefined) {
    ensureGuestParent(fs, parent);
    fs.set(parent, { kind: "directory", mode: 0o755 });
  }
}

async function copyHostDir(
  fs: FakeSandboxFilesystem,
  hostRoot: string,
  guestRoot: string,
  transferRoot: string,
  overwrite: "error" | "replace",
  signal: AbortSignal | undefined,
): Promise<void> {
  const existing = fs.get(guestRoot);
  if (existing !== undefined) {
    if (existing.kind !== "directory") {
      throw SboxError.validation("Cannot overwrite a guest file with a directory.", {
        details: { path: "guestPath" },
      });
    }
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Guest destination already exists.", {
        details: { path: "guestPath" },
      });
    }
  }

  const planned = new Map<string, FakeFsNode>();
  const rootStat = await lstat(hostRoot);
  await planHostTree(hostRoot, "", transferRoot, planned, signal);

  // In-memory commit is atomic: root-mode injection runs before any live
  // destination mutation (equivalent to beforeCommit failing before backup is
  // discarded on the real host path).
  throwIfRootModeInjectedFailure();

  // Atomic commit: clear destination only after the full plan succeeds.
  if (existing !== undefined) {
    for (const [path] of fs.entriesUnder(guestRoot)) {
      fs.delete(path);
    }
  } else {
    ensureGuestParent(fs, guestRoot);
  }
  fs.set(guestRoot, { kind: "directory", mode: permissionBits(rootStat.mode) });

  for (const [rel, node] of planned) {
    const guestPath =
      rel === "" ? guestRoot : guestRoot === "/" ? `/${rel}` : `${guestRoot}/${rel}`;
    if (node.kind === "directory") {
      ensureGuestParent(fs, guestPath === "/" ? "/." : guestPath);
    } else {
      ensureGuestParent(fs, guestPath);
    }
    fs.set(guestPath, node);
  }
}

async function planHostTree(
  hostRoot: string,
  relPrefix: string,
  transferRoot: string,
  planned: Map<string, FakeFsNode>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (relPrefix !== "") {
    const st = await lstat(hostRoot);
    planned.set(relPrefix, { kind: "directory", mode: permissionBits(st.mode) });
  }
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(hostRoot, { withFileTypes: true })) {
    throwIfAborted(signal);
    const hostChild = join(hostRoot, entry.name);
    const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      const target = await readlink(hostChild);
      const parentRel = relPrefix === "" ? "/" : `/${relPrefix}`;
      const guestLinkDir =
        transferRoot === "/"
          ? parentRel
          : parentRel === "/"
            ? transferRoot
            : `${transferRoot}${parentRel}`;
      assertSymlinkTargetInsideRoot(target, guestLinkDir, transferRoot, "hostPath");
      planned.set(rel, { kind: "symlink", target });
    } else if (entry.isFile()) {
      const st = await lstat(hostChild);
      if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
        throw SboxError.validation("Special files are not supported for transfer.", {
          details: { path: "hostPath" },
        });
      }
      const data = new Uint8Array(await readFile(hostChild));
      planned.set(rel, { kind: "file", mode: permissionBits(st.mode), data });
    } else if (entry.isDirectory()) {
      await planHostTree(hostChild, rel, transferRoot, planned, signal);
    } else {
      throw SboxError.validation("Special files are not supported for transfer.", {
        details: { path: "hostPath" },
      });
    }
  }
}

async function copyGuestDir(
  fs: FakeSandboxFilesystem,
  guestRoot: string,
  hostRoot: string,
  transferRoot: string,
  overwrite: "error" | "replace",
  signal: AbortSignal | undefined,
): Promise<void> {
  let hostExists = false;
  try {
    const st = await lstat(hostRoot);
    hostExists = true;
    if (!st.isDirectory()) {
      throw SboxError.validation("Cannot overwrite a host file with a directory.", {
        details: { path: "hostPath" },
      });
    }
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Host destination already exists.", {
        details: { path: "hostPath" },
      });
    }
  } catch (error) {
    if (error instanceof SboxError) {
      throw error;
    }
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw SboxError.validation("Host destination is not accessible.", {
        cause: error,
        details: { path: "hostPath" },
      });
    }
  }

  // Plan/prevalidate by walking guest entries before touching the destination.
  const planned: Array<{ rel: string; node: FakeFsNode }> = [];
  await planGuestTree(fs, guestRoot, "", transferRoot, planned, signal);

  const parent = dirname(hostRoot);
  await mkdir(parent, { recursive: true });
  const stagingRoot = stagingNameBeside(hostRoot, "dir");
  await mkdir(stagingRoot, { recursive: true });
  await chmod(stagingRoot, 0o700);
  try {
    const dirModes: Array<{ path: string; mode: number }> = [];
    for (const entry of planned) {
      throwIfAborted(signal);
      const hostChild = join(stagingRoot, entry.rel);
      if (entry.node.kind === "directory") {
        await mkdir(hostChild, { recursive: true });
        await chmod(hostChild, 0o700);
        dirModes.push({ path: hostChild, mode: entry.node.mode });
      } else if (entry.node.kind === "file") {
        await mkdir(dirname(hostChild), { recursive: true });
        const staging = stagingNameBeside(hostChild, "file");
        await writeFile(staging, entry.node.data);
        await chmod(staging, permissionBits(entry.node.mode));
        await rename(staging, hostChild);
      } else {
        await mkdir(dirname(hostChild), { recursive: true });
        await symlink(entry.node.target, hostChild);
      }
    }
    // Apply nested directory modes post-order (children before parents).
    for (const dir of dirModes.toReversed()) {
      await chmod(dir.path, permissionBits(dir.mode));
    }
    const rootNode = fs.get(guestRoot);
    // Keep staged root writable through rename; apply final root mode in
    // beforeCommit so failure restores any previous destination (Darwin cannot
    // rename a directory after a restrictive chmod).
    await publishHostPath({
      stagingPath: stagingRoot,
      destPath: hostRoot,
      destExists: hostExists,
      remove: removePathQuiet,
      beforeCommit: async (published) => {
        throwIfRootModeInjectedFailure();
        if (rootNode?.kind === "directory") {
          await chmod(published, permissionBits(rootNode.mode));
        }
      },
    });
  } catch (error) {
    await removePathQuiet(stagingRoot, true).catch(() => undefined);
    throw error;
  }
}

async function planGuestTree(
  fs: FakeSandboxFilesystem,
  guestRoot: string,
  relPrefix: string,
  transferRoot: string,
  planned: Array<{ rel: string; node: FakeFsNode }>,
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const [path, node] of fs.entriesUnder(guestRoot)) {
    throwIfAborted(signal);
    const rel = path.slice(guestRoot === "/" ? 1 : guestRoot.length + 1);
    if (rel.includes("/")) {
      continue;
    }
    const childRel = relPrefix === "" ? rel : `${relPrefix}/${rel}`;
    if (node.kind === "directory") {
      planned.push({ rel: childRel, node });
      await planGuestTree(fs, path, childRel, transferRoot, planned, signal);
    } else if (node.kind === "file") {
      planned.push({ rel: childRel, node });
    } else {
      assertSymlinkTargetInsideRoot(node.target, guestRoot, transferRoot, "guestPath");
      planned.push({ rel: childRel, node });
    }
  }
}

async function publishHostFile(
  hostPath: string,
  data: Uint8Array,
  mode: number,
  overwrite: "error" | "replace",
): Promise<void> {
  let hostExists = false;
  try {
    const st = await lstat(hostPath);
    hostExists = true;
    if (st.isDirectory()) {
      throw SboxError.validation("Cannot overwrite a host directory with a file.", {
        details: { path: "hostPath" },
      });
    }
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Host destination already exists.", {
        details: { path: "hostPath" },
      });
    }
  } catch (error) {
    if (error instanceof SboxError) {
      throw error;
    }
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw SboxError.validation("Host destination is not accessible.", {
        cause: error,
        details: { path: "hostPath" },
      });
    }
  }
  await mkdir(dirname(hostPath), { recursive: true });
  const staging = stagingNameBeside(hostPath, "file");
  try {
    await writeFile(staging, data);
    await chmod(staging, permissionBits(mode));
    await publishHostPath({
      stagingPath: staging,
      destPath: hostPath,
      destExists: hostExists,
      remove: removePathQuiet,
    });
  } catch (error) {
    await removePathQuiet(staging, false).catch(() => undefined);
    throw error;
  }
}

async function publishHostSymlink(
  hostPath: string,
  target: string,
  overwrite: "error" | "replace",
): Promise<void> {
  let hostExists = false;
  try {
    const st = await lstat(hostPath);
    hostExists = true;
    if (overwrite === "error") {
      throw SboxError.alreadyExists("Host destination already exists.", {
        details: { path: "hostPath" },
      });
    }
    if (st.isDirectory()) {
      throw SboxError.validation("Cannot overwrite a host directory with a symlink.", {
        details: { path: "hostPath" },
      });
    }
  } catch (error) {
    if (error instanceof SboxError) {
      throw error;
    }
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw SboxError.validation("Host destination is not accessible.", {
        cause: error,
        details: { path: "hostPath" },
      });
    }
  }
  await mkdir(dirname(hostPath), { recursive: true });
  const staging = stagingNameBeside(hostPath, "file");
  try {
    await symlink(target, staging);
    await publishHostPath({
      stagingPath: staging,
      destPath: hostPath,
      destExists: hostExists,
      remove: removePathQuiet,
    });
  } catch (error) {
    await removePathQuiet(staging, false).catch(() => undefined);
    throw error;
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Default fake exec: echo argv on stdout; `false` exits 1; `cat` echoes stdin. */
export async function defaultFakeExec(
  argv: readonly string[],
  stdin: Uint8Array,
): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
  const cmd = argv[0] ?? "";
  if (cmd === "false") {
    return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() };
  }
  if (cmd === "cat") {
    return { exitCode: 0, stdout: stdin, stderr: new Uint8Array() };
  }
  if (cmd === "/bin/sh" && argv[1] === "-c") {
    const script = argv[2] ?? "";
    return {
      exitCode: 0,
      stdout: utf8ToBytes(`shell:${script}`),
      stderr: new Uint8Array(),
    };
  }
  return {
    exitCode: 0,
    stdout: utf8ToBytes(argv.map((part) => JSON.stringify(part)).join(" ")),
    stderr: new Uint8Array(),
  };
}
