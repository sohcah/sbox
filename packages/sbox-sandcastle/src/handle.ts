/**
 * IsolatedSandboxHandle backed by an owned SboxClient sandbox.
 */

import type {
  ExecResult,
  InteractiveExecOptions,
  IsolatedSandboxHandle,
} from "@ai-hero/sandcastle";
import {
  LineDecoder,
  SboxError,
  bytesToUtf8,
  concatBytes,
  isSboxError,
  utf8ToBytes,
  type ProcessEvent,
  type ProcessSession,
  type PtySession,
  type SandboxHandle,
} from "@sohcah/sbox";
import { isReadableTty, readableToAsyncIterable, ttySize, writeAll } from "./streams.js";

const DEFAULT_SHELL = "/bin/sh";

export interface SboxIsolatedHandleOptions {
  readonly handle: SandboxHandle;
  readonly worktreePath: string;
  readonly shell: string;
}

type BeginSession = <T extends AsyncDisposable>(create: () => Promise<T>) => Promise<T>;

export function createSboxIsolatedHandle(
  options: SboxIsolatedHandleOptions,
): IsolatedSandboxHandle {
  const { handle, worktreePath } = options;
  const shell = options.shell.length > 0 ? options.shell : DEFAULT_SHELL;
  const children = new Set<AsyncDisposable>();
  /** In-flight session creations registered before their first await. */
  const pendingStarts = new Set<Promise<void>>();
  let closed = false;
  /** Set on the first close attempt; never cleared. Rejects new operations. */
  let closeStarted = false;
  let childrenDisposed = false;
  let closePromise: Promise<void> | undefined;

  const untrack = (session: AsyncDisposable): void => {
    children.delete(session);
  };

  const beginSession: BeginSession = async (create) => {
    ensureAvailable();
    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    pendingStarts.add(pending);
    try {
      const session = await create();
      if (closeStarted || closed) {
        try {
          await session[Symbol.asyncDispose]();
        } catch {
          // Best-effort: close already owns teardown.
        }
        throw closedError();
      }
      children.add(session);
      return session;
    } finally {
      pendingStarts.delete(pending);
      resolvePending();
    }
  };

  return {
    worktreePath,

    exec(command, execOptions): Promise<ExecResult> {
      return (async () => {
        ensureAvailable();
        const cwd = execOptions?.cwd ?? worktreePath;
        const user = execOptions?.sudo === true ? "root" : undefined;
        const collectedBase = {
          cwd,
          ...(user !== undefined ? { user } : {}),
          ...(execOptions?.stdin !== undefined ? { stdin: execOptions.stdin } : {}),
          shell,
        };

        if (execOptions?.onLine === undefined) {
          const result = await handle.shell(command, collectedBase);
          return {
            stdout: bytesToUtf8(result.stdout),
            stderr: bytesToUtf8(result.stderr),
            exitCode: result.exitCode,
          };
        }

        const onLine = execOptions.onLine;
        const session = await beginSession(() =>
          handle.shellStream(command, {
            cwd,
            shell,
            ...(user !== undefined ? { user } : {}),
            ...(execOptions.stdin !== undefined
              ? {
                  stdin: (async function* () {
                    yield utf8ToBytes(execOptions.stdin!);
                  })(),
                }
              : {}),
          }),
        );
        try {
          return await collectLiveLines(session, onLine);
        } finally {
          untrack(session);
          await session[Symbol.asyncDispose]();
        }
      })();
    },

    async interactiveExec(args, interactiveOptions): Promise<{ exitCode: number }> {
      ensureAvailable();
      if (isReadableTty(interactiveOptions.stdin)) {
        return runPtyInteractive(
          handle,
          worktreePath,
          args,
          interactiveOptions,
          beginSession,
          untrack,
        );
      }
      return runPipeInteractive(
        handle,
        worktreePath,
        args,
        interactiveOptions,
        beginSession,
        untrack,
      );
    },

    async copyIn(hostPath, sandboxPath): Promise<void> {
      ensureAvailable();
      await handle.copyToGuest(hostPath, sandboxPath, { overwrite: "replace" });
    },

    async copyFileOut(sandboxPath, hostPath): Promise<void> {
      ensureAvailable();
      const probe = await handle.exec(["test", "-f", sandboxPath]);
      if (probe.exitCode !== 0) {
        throw SboxError.validation("copyFileOut requires a single guest file path.", {
          details: { path: "sandboxPath", message: sandboxPath },
        });
      }
      await handle.copyFromGuest(sandboxPath, hostPath, { overwrite: "replace" });
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closeStarted = true;
      if (closePromise !== undefined) {
        return closePromise;
      }
      closePromise = performClose();
      try {
        await closePromise;
      } catch (error) {
        // Allow a later close() to retry exact removal. New operations stay rejected.
        closePromise = undefined;
        throw error;
      }
    },
  };

  async function performClose(): Promise<void> {
    // Wait for session creations that began before closeStarted.
    while (pendingStarts.size > 0) {
      await Promise.all(pendingStarts);
    }
    if (!childrenDisposed) {
      childrenDisposed = true;
      const pending = [...children];
      children.clear();
      for (const session of pending) {
        try {
          await session[Symbol.asyncDispose]();
        } catch {
          // Child cleanup is best-effort before exact remove.
        }
      }
    }
    try {
      await handle.remove();
    } catch (error) {
      if (isNotFoundError(error)) {
        closed = true;
        return;
      }
      throw error;
    }
    closed = true;
  }

  function ensureAvailable(): void {
    if (closed || closeStarted) {
      throw closedError();
    }
  }
}

function closedError(): SboxError {
  return SboxError.validation("Sandcastle sandbox handle is closed.", {
    details: { path: "close" },
  });
}

function isNotFoundError(error: unknown): boolean {
  if (isSboxError(error)) {
    return error.code === "not_found";
  }
  // Duck-type across possible dual package instances in tests (src vs dist).
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "not_found"
  );
}

async function collectLiveLines(
  session: ProcessSession,
  onLine: (line: string) => void,
): Promise<ExecResult> {
  const stdoutDecoder = new LineDecoder();
  const stderrDecoder = new LineDecoder();
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const pump = (async () => {
    for await (const event of session) {
      applyProcessEvent(event, stdoutChunks, stderrChunks, stdoutDecoder, stderrDecoder, onLine);
    }
    for (const line of stdoutDecoder.finish()) {
      onLine(line);
    }
    for (const line of stderrDecoder.finish()) {
      onLine(line);
    }
  })();

  const exit = await session.wait();
  await pump;
  return {
    stdout: bytesToUtf8(concatBytes(stdoutChunks)),
    stderr: bytesToUtf8(concatBytes(stderrChunks)),
    exitCode: exit.exitCode,
  };
}

function applyProcessEvent(
  event: ProcessEvent,
  stdoutChunks: Uint8Array[],
  stderrChunks: Uint8Array[],
  stdoutDecoder: LineDecoder,
  stderrDecoder: LineDecoder,
  onLine: (line: string) => void,
): void {
  if (event.type === "stdout") {
    stdoutChunks.push(event.data);
    for (const line of stdoutDecoder.push(event.data)) {
      onLine(line);
    }
    return;
  }
  if (event.type === "stderr") {
    stderrChunks.push(event.data);
    for (const line of stderrDecoder.push(event.data)) {
      onLine(line);
    }
  }
}

async function runPtyInteractive(
  handle: SandboxHandle,
  worktreePath: string,
  args: readonly string[],
  options: InteractiveExecOptions,
  beginSession: BeginSession,
  untrack: (session: AsyncDisposable) => void,
): Promise<{ exitCode: number }> {
  const cwd = options.cwd ?? worktreePath;
  const size = ttySize(options.stdout);
  const session = await beginSession(() =>
    handle.pty(args, {
      cwd,
      rows: size.rows,
      cols: size.cols,
      input: readableToAsyncIterable(options.stdin),
    }),
  );
  const stdout = options.stdout as NodeJS.WriteStream;
  const onResize = (): void => {
    const next = ttySize(stdout);
    void session.resize(next);
  };
  if (typeof stdout.on === "function") {
    stdout.on("resize", onResize);
  }
  try {
    const pump = pumpPtyOutput(session, options.stdout);
    const exit = await session.wait();
    await pump;
    return { exitCode: exit.exitCode };
  } finally {
    if (typeof stdout.off === "function") {
      stdout.off("resize", onResize);
    } else if (typeof stdout.removeListener === "function") {
      stdout.removeListener("resize", onResize);
    }
    untrack(session);
    await session[Symbol.asyncDispose]();
  }
}

async function runPipeInteractive(
  handle: SandboxHandle,
  worktreePath: string,
  args: readonly string[],
  options: InteractiveExecOptions,
  beginSession: BeginSession,
  untrack: (session: AsyncDisposable) => void,
): Promise<{ exitCode: number }> {
  const cwd = options.cwd ?? worktreePath;
  const session = await beginSession(() =>
    handle.execStream(args, {
      cwd,
      stdin: readableToAsyncIterable(options.stdin),
    }),
  );
  try {
    const pump = (async () => {
      for await (const event of session) {
        if (event.type === "stdout") {
          await writeAll(options.stdout, event.data);
        } else if (event.type === "stderr") {
          await writeAll(options.stderr, event.data);
        }
      }
    })();
    const exit = await session.wait();
    await pump;
    return { exitCode: exit.exitCode };
  } finally {
    untrack(session);
    await session[Symbol.asyncDispose]();
  }
}

async function pumpPtyOutput(session: PtySession, stdout: NodeJS.WritableStream): Promise<void> {
  for await (const chunk of session.output) {
    await writeAll(stdout, chunk);
  }
}
