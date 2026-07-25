/**
 * Local process execution over Microsandbox 0.6.6 high-level exec APIs.
 *
 * Exact argv uses `execStreamWith`. Explicit guest shell uses argv
 * `[shell, "-c", script]` so shell interpretation is never implicit.
 *
 * Streaming output is pull-driven through a bounded queue: producers pause when
 * full. Callers must consume events or cancel; `wait()` does not drain output.
 * Caller stdin is owned by the session and closed on settlement so cleanup never
 * hangs on a pending `next()`.
 */

import type { Sandbox } from "microsandbox";
import { SboxError, isAbortError, throwIfAborted } from "./errors.js";
import { mapNativeError } from "./microsandbox-runtime.js";
import {
  INPUT_SETTLED,
  closeAsyncIterator,
  nextOrSettled,
  observeDetached,
} from "./process/async-input.js";
import { BoundedAsyncQueue, DEFAULT_STREAM_QUEUE_CAPACITY } from "./process/bounded-queue.js";
import { collectProcessEvents } from "./process/collect.js";
import { utf8ToBytes } from "./process/decode.js";
import { assertTimeoutMs } from "./process/limits.js";
import type {
  HostCollectedExecOptions,
  HostStreamingExecOptions,
  ProcessSession,
  ProcessStdin,
} from "./process/session.js";
import type { ProcessEvent, ProcessResult } from "./types.js";

const SIGKILL = 9;
const DEFAULT_SHELL = "/bin/sh";

export async function withConnectedSandbox<T>(
  nativeName: string,
  fn: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
  const { Sandbox: SandboxCtor } = await import("microsandbox");
  let sandbox: Sandbox;
  try {
    const handle = await SandboxCtor.get(nativeName);
    sandbox = await handle.connect();
  } catch (error) {
    throw mapNativeError(error);
  }
  try {
    return await fn(sandbox);
  } finally {
    try {
      await sandbox.detach();
    } catch {
      // Local cleanup only.
    }
  }
}

export async function execArgvCollected(
  nativeName: string,
  argv: readonly string[],
  options: HostCollectedExecOptions = {},
): Promise<ProcessResult> {
  validateArgv(argv);
  throwIfAborted(options.signal);
  return withConnectedSandbox(nativeName, async (sandbox) => {
    const streamOptions: HostStreamingExecOptions = {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.user !== undefined ? { user: options.user } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.stdin !== undefined
        ? {
            stdin: (async function* () {
              yield typeof options.stdin === "string" ? utf8ToBytes(options.stdin) : options.stdin!;
            })(),
          }
        : {}),
    };
    const session = await startSdkProcessSession(sandbox, argv, streamOptions);
    try {
      return await collectProcessEvents(session, {
        ...(options.stdoutMaxBytes !== undefined ? { stdoutMaxBytes: options.stdoutMaxBytes } : {}),
        ...(options.stderrMaxBytes !== undefined ? { stderrMaxBytes: options.stderrMaxBytes } : {}),
        onOverflow: () => session.cancel("output-limit"),
      });
    } finally {
      await session[Symbol.asyncDispose]();
    }
  });
}

export async function execArgvStream(
  nativeName: string,
  argv: readonly string[],
  options: HostStreamingExecOptions = {},
): Promise<ProcessSession> {
  validateArgv(argv);
  throwIfAborted(options.signal);
  const { Sandbox: SandboxCtor } = await import("microsandbox");
  let sandbox: Sandbox;
  try {
    const handle = await SandboxCtor.get(nativeName);
    sandbox = await handle.connect();
  } catch (error) {
    throw mapNativeError(error);
  }
  try {
    const session = await startSdkProcessSession(sandbox, argv, options);
    return wrapSessionWithDetach(session, sandbox);
  } catch (error) {
    try {
      await sandbox.detach();
    } catch {
      // Prefer original error.
    }
    throw error;
  }
}

export async function execShellCollected(
  nativeName: string,
  script: string,
  options: HostCollectedExecOptions & { readonly shell?: string } = {},
): Promise<ProcessResult> {
  const shell = options.shell ?? DEFAULT_SHELL;
  return execArgvCollected(nativeName, [shell, "-c", script], options);
}

export async function execShellStream(
  nativeName: string,
  script: string,
  options: HostStreamingExecOptions & { readonly shell?: string } = {},
): Promise<ProcessSession> {
  const shell = options.shell ?? DEFAULT_SHELL;
  return execArgvStream(nativeName, [shell, "-c", script], options);
}

function validateArgv(argv: readonly string[]): void {
  if (argv.length === 0) {
    throw SboxError.validation("Command argv must not be empty.", {
      details: { path: "argv" },
    });
  }
  if (argv[0] === undefined || argv[0].length === 0) {
    throw SboxError.validation("Command path must not be empty.", {
      details: { path: "argv" },
    });
  }
}

async function startSdkProcessSession(
  sandbox: Sandbox,
  argv: readonly string[],
  options: HostStreamingExecOptions,
): Promise<ProcessSession> {
  const timeoutMs = assertTimeoutMs(options.timeoutMs);
  const [cmd, ...args] = argv;
  let handle;
  try {
    handle = await sandbox.execStreamWith(cmd!, (builder) => {
      let next = builder.args([...args]);
      if (options.cwd !== undefined) {
        next = next.cwd(options.cwd);
      }
      if (options.user !== undefined) {
        next = next.user(options.user);
      }
      if (options.env !== undefined && Object.keys(options.env).length > 0) {
        next = next.envs({ ...options.env });
      }
      if (timeoutMs !== undefined) {
        next = next.timeout(timeoutMs);
      }
      next = next.stdinPipe();
      return next;
    });
  } catch (error) {
    throw mapNativeError(error);
  }

  return createSdkProcessSession(handle, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
  });
}

function wrapSessionWithDetach(session: ProcessSession, sandbox: Sandbox): ProcessSession {
  const dispose = async () => {
    try {
      await session[Symbol.asyncDispose]();
    } finally {
      try {
        await sandbox.detach();
      } catch {
        // Local cleanup only.
      }
    }
  };
  return {
    stdin: session.stdin,
    wait: () => session.wait(),
    cancel: (reason) => session.cancel(reason),
    [Symbol.asyncIterator]: () => session[Symbol.asyncIterator](),
    [Symbol.asyncDispose]: dispose,
  };
}

/** Native handle surface used by {@link createSdkProcessSession} (also for tests). */
export interface SdkNativeProcessHandle {
  recv(): Promise<
    | { kind: "started"; pid: number }
    | { kind: "stdout"; data: Uint8Array }
    | { kind: "stderr"; data: Uint8Array }
    | { kind: "exited"; code: number }
    | null
  >;
  takeStdin(): Promise<{
    write(data: Uint8Array | string): Promise<void>;
    close(): Promise<void>;
  } | null>;
  signal(signal: number): Promise<void>;
  kill(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface CreateSdkProcessSessionOptions {
  readonly signal?: AbortSignal;
  readonly stdin?: AsyncIterable<Uint8Array>;
  readonly queueCapacity?: number;
}

/**
 * Build a process session over a native handle. Exported for focused unit tests;
 * not part of the public package declaration graph.
 */
export function createSdkProcessSession(
  handle: SdkNativeProcessHandle,
  options: CreateSdkProcessSessionOptions = {},
): ProcessSession {
  return new SdkProcessSession(handle, options);
}

const sdkSessionDiagnostics = new WeakMap<
  ProcessSession,
  () => { killCount: number; disposeCount: number }
>();

/** Test seam for native cleanup counts (null when not an SDK session). */
export function sdkProcessSessionDiagnostics(
  session: ProcessSession,
): { killCount: number; disposeCount: number } | null {
  return sdkSessionDiagnostics.get(session)?.() ?? null;
}

class SdkProcessSession implements ProcessSession {
  private readonly events: BoundedAsyncQueue<ProcessEvent>;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private settled = false;
  private finishing: Promise<void> | null = null;
  private failure: SboxError | null = null;
  private readonly abortHandler: () => void;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly pumpTask: Promise<void>;
  private readonly stdinForward?: Promise<void>;
  private readonly stdinIterator?: AsyncIterator<Uint8Array>;
  private stdinEnded = false;
  private lateEventsIgnored = false;
  private settleResolve: (() => void) | null = null;
  private readonly whenSettled: Promise<void>;
  private killCount = 0;
  private disposeCount = 0;

  readonly stdin: ProcessStdin;

  constructor(
    private readonly handle: SdkNativeProcessHandle,
    options: CreateSdkProcessSessionOptions,
  ) {
    this.events = new BoundedAsyncQueue(options.queueCapacity ?? DEFAULT_STREAM_QUEUE_CAPACITY);
    this.abortSignal = options.signal;
    this.whenSettled = new Promise<void>((resolve) => {
      this.settleResolve = resolve;
    });
    sdkSessionDiagnostics.set(this, () => ({
      killCount: this.killCount,
      disposeCount: this.disposeCount,
    }));
    let sinkPromise: Promise<{
      write(data: Uint8Array | string): Promise<void>;
      close(): Promise<void>;
    } | null> | null = null;
    const getSink = async () => {
      sinkPromise ??= this.handle.takeStdin();
      return sinkPromise;
    };

    this.stdin = {
      write: async (data) => {
        this.ensureOpen();
        const sink = await getSink();
        if (sink === null) {
          throw SboxError.nativeState("Process stdin is not available.");
        }
        try {
          await sink.write(data);
        } catch (error) {
          throw mapNativeError(error);
        }
      },
      end: async () => {
        if (this.stdinEnded) {
          return;
        }
        this.stdinEnded = true;
        const sink = await getSink();
        if (sink === null) {
          return;
        }
        try {
          await sink.close();
        } catch (error) {
          throw mapNativeError(error);
        }
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

    this.pumpTask = this.pump();
    if (options.stdin !== undefined) {
      this.stdinIterator = options.stdin[Symbol.asyncIterator]();
      this.stdinForward = this.forwardStdin(this.stdinIterator);
    } else {
      // No caller stdin: close immediately so programs waiting for EOF can exit.
      void this.stdin.end().catch(() => undefined);
    }
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
    await this.pumpTask;
    if (this.failure !== null) {
      throw this.failure;
    }
    if (this.exitCode === null) {
      throw SboxError.internal("Process ended without an exit status.");
    }
    return { exitCode: this.exitCode, signal: this.exitSignal };
  }

  async cancel(reason = "cancelled"): Promise<void> {
    if (this.settled || this.finishing !== null) {
      await this.finishing;
      return;
    }
    this.failure = SboxError.cancellation(`Process was cancelled (${reason}).`);
    await this.killNative();
    await this.finish();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.settled) {
      await this.cancel("disposed");
    } else {
      await this.finishing;
    }
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        if (this.lateEventsIgnored) {
          break;
        }
        const raw = await this.handle.recv();
        if (raw === null) {
          break;
        }
        if (this.settled) {
          // Late native events must not mutate a completed public result.
          continue;
        }
        switch (raw.kind) {
          case "started": {
            const pushed = await this.pushEvent({ type: "started", pid: raw.pid });
            if (pushed === "closed") {
              return;
            }
            break;
          }
          case "stdout": {
            const pushed = await this.pushEvent({ type: "stdout", data: raw.data });
            if (pushed === "closed") {
              return;
            }
            break;
          }
          case "stderr": {
            const pushed = await this.pushEvent({ type: "stderr", data: raw.data });
            if (pushed === "closed") {
              return;
            }
            break;
          }
          case "exited": {
            this.exitCode = raw.code;
            this.exitSignal = null;
            await this.pushEvent({ type: "exited", exitCode: raw.code, signal: null });
            await this.finish();
            return;
          }
        }
      }
      if (!this.settled) {
        if (this.exitCode === null && this.failure === null) {
          this.failure = SboxError.internal("Process stream ended without exit.");
        }
        await this.finish();
      }
    } catch (error) {
      if (!this.settled) {
        if (isTimeoutLike(error)) {
          this.failure = SboxError.timeout("Process timed out.", { cause: error });
        } else if (isAbortError(error)) {
          this.failure = SboxError.cancellation("Process was aborted.");
        } else {
          this.failure = mapNativeError(error);
        }
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
        this.failure = mapNativeError(error);
        await this.cancel("stdin-error");
      }
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
    this.lateEventsIgnored = true;
    this.finishing = this.finishBody();
    await this.finishing;
  }

  private async finishBody(): Promise<void> {
    this.settleResolve?.();
    this.settleResolve = null;
    this.removeAbortListener();
    this.events.close(this.failure ?? undefined);

    if (this.stdinIterator !== undefined) {
      closeAsyncIterator(this.stdinIterator);
    }

    await this.closeNative();

    // Input forwarding exits via settlement race; never block cleanup on it.
    if (this.stdinForward !== undefined) {
      observeDetached(this.stdinForward);
    }
  }

  private async killNative(): Promise<void> {
    if (this.killCount > 0) {
      return;
    }
    this.killCount = 1;
    try {
      await this.handle.kill();
    } catch {
      try {
        await this.handle.signal(SIGKILL);
      } catch {
        // Best effort.
      }
    }
  }

  private async closeNative(): Promise<void> {
    if (this.disposeCount > 0) {
      return;
    }
    this.disposeCount = 1;
    try {
      await this.handle[Symbol.asyncDispose]();
    } catch {
      // Cleanup failures must not expose raw native errors.
    }
  }

  private removeAbortListener(): void {
    if (this.abortSignal !== undefined) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
  }

  private async pushEvent(event: ProcessEvent): Promise<"ok" | "closed"> {
    return this.events.push(event);
  }

  private ensureOpen(): void {
    if (this.settled) {
      throw this.failure ?? SboxError.nativeState("Process session is already closed.");
    }
  }
}

function isTimeoutLike(error: unknown): boolean {
  if (error instanceof SboxError) {
    return error.code === "timeout";
  }
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();
    return name.includes("timeout") || message.includes("timeout") || message.includes("timed out");
  }
  return false;
}
