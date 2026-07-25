/**
 * Isolated Microsandbox 0.6.6 low-level PTY adapter (private).
 *
 * The SDK `attach*` APIs bridge the host terminal and return only an exit code,
 * so they cannot satisfy arbitrary Node streams + resize. This adapter speaks
 * the pinned agent protocol (`core.exec.*`) via `AgentClient`.
 *
 * Replacement condition: remove when Microsandbox exposes a stable high-level
 * API for arbitrary-stream PTY sessions with resize.
 *
 * Output is pull-driven through a bounded queue. Callers must consume `output`
 * or cancel; `wait()` does not drain. Caller input is owned and closed on
 * settlement so cleanup never hangs on a pending `next()`.
 */

import { AgentClient, FLAG_SESSION_START, type AgentStream } from "microsandbox";
import { SboxError, isAbortError, throwIfAborted } from "../errors.js";
import { mapNativeError } from "../microsandbox-runtime.js";
import {
  INPUT_SETTLED,
  closeAsyncIterator,
  nextOrSettled,
  observeDetached,
} from "../process/async-input.js";
import { BoundedAsyncQueue, DEFAULT_STREAM_QUEUE_CAPACITY } from "../process/bounded-queue.js";
import type { PtySession, PtySize } from "../process/session.js";
import { utf8ToBytes } from "../process/decode.js";
import { assertPtyDimension, assertTimeoutMs } from "../process/limits.js";
import {
  FLAG_TERMINAL,
  MSG_EXEC_EXITED,
  MSG_EXEC_FAILED,
  MSG_EXEC_STARTED,
  MSG_EXEC_STDERR,
  MSG_EXEC_STDIN_ERROR,
  MSG_EXEC_STDOUT,
  decodeEnvelope,
  decodePayload,
  encodeExecRequest,
  encodeExecResize,
  encodeExecSignal,
  encodeExecStdin,
  type ExecBytesPayload,
  type ExecExitedPayload,
  type ExecFailedPayload,
  type ExecStartedPayload,
} from "./agent-protocol.js";

const SIGKILL = 9;
const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;

export interface AgentPtyStartOptions {
  readonly nativeName: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly user?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly rows?: number;
  readonly cols?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly input?: AsyncIterable<Uint8Array>;
  readonly queueCapacity?: number;
}

export async function startAgentPty(options: AgentPtyStartOptions): Promise<PtySession> {
  throwIfAborted(options.signal);
  if (options.argv.length === 0) {
    throw SboxError.validation("PTY argv must not be empty.", { details: { path: "argv" } });
  }
  const [cmd, ...args] = options.argv;
  if (cmd === undefined || cmd.length === 0) {
    throw SboxError.validation("PTY command must not be empty.", { details: { path: "argv" } });
  }
  const timeoutMs = assertTimeoutMs(options.timeoutMs);
  const rows = assertPtyDimension(options.rows ?? DEFAULT_ROWS, "rows");
  const cols = assertPtyDimension(options.cols ?? DEFAULT_COLS, "cols");

  let client: AgentClient;
  try {
    client = await AgentClient.connectSandbox(options.nativeName);
  } catch (error) {
    throw mapNativeError(error);
  }

  const envPairs = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
  const body = encodeExecRequest({
    cmd,
    args,
    env: envPairs,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.user !== undefined ? { user: options.user } : {}),
    tty: true,
    rows,
    cols,
  });

  let stream: AgentStream;
  try {
    stream = await client.stream(FLAG_SESSION_START, body);
  } catch (error) {
    try {
      await client.close();
    } catch {
      // Prefer the original failure.
    }
    throw mapNativeError(error);
  }

  return createAgentPtySession(
    {
      send: async (payload) => {
        await client.send(stream.id, 0, Buffer.from(payload));
      },
      frames: stream,
      close: async () => {
        try {
          await stream.close();
        } catch {
          // Ignore.
        }
        try {
          await client.close();
        } catch {
          // Ignore.
        }
      },
    },
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(options.queueCapacity !== undefined ? { queueCapacity: options.queueCapacity } : {}),
    },
  );
}

/** Transport seam for {@link createAgentPtySession} (also for tests). */
export interface AgentPtyTransport {
  send(payload: Uint8Array): Promise<void>;
  frames: AsyncIterable<{ readonly flags: number; readonly body: Uint8Array }>;
  close(): Promise<void>;
}

export interface CreateAgentPtySessionOptions {
  readonly signal?: AbortSignal;
  readonly input?: AsyncIterable<Uint8Array>;
  readonly timeoutMs?: number;
  readonly queueCapacity?: number;
}

const ptySessionDiagnostics = new WeakMap<
  PtySession,
  () => { signalCount: number; closeCount: number }
>();

/** Test seam for protocol cleanup counts. */
export function agentPtySessionDiagnostics(
  session: PtySession,
): { signalCount: number; closeCount: number } | null {
  return ptySessionDiagnostics.get(session)?.() ?? null;
}

/**
 * Build a PTY session over an abstract transport. Exported for focused unit
 * tests; not part of the public package declaration graph.
 */
export function createAgentPtySession(
  transport: AgentPtyTransport,
  options: CreateAgentPtySessionOptions = {},
): PtySession {
  const timeoutMs = assertTimeoutMs(options.timeoutMs);
  return new AgentPtySession(transport, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(options.queueCapacity !== undefined ? { queueCapacity: options.queueCapacity } : {}),
  });
}

class AgentPtySession implements PtySession {
  private readonly outputQueue: BoundedAsyncQueue<Uint8Array>;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private settled = false;
  private finishing: Promise<void> | null = null;
  private cancelled = false;
  private failure: SboxError | null = null;
  private readonly abortHandler: () => void;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly inputTask: Promise<void> | undefined;
  private readonly inputIterator: AsyncIterator<Uint8Array> | undefined;
  private readonly pumpTask: Promise<void>;
  private settleResolve: (() => void) | null = null;
  private readonly whenSettled: Promise<void>;
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private signalCount = 0;
  private closeCount = 0;

  constructor(
    private readonly transport: AgentPtyTransport,
    options: CreateAgentPtySessionOptions,
  ) {
    this.outputQueue = new BoundedAsyncQueue(
      options.queueCapacity ?? DEFAULT_STREAM_QUEUE_CAPACITY,
    );
    this.abortSignal = options.signal;
    this.whenSettled = new Promise<void>((resolve) => {
      this.settleResolve = resolve;
    });
    ptySessionDiagnostics.set(this, () => ({
      signalCount: this.signalCount,
      closeCount: this.closeCount,
    }));

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

    if (options.timeoutMs !== undefined) {
      this.timeoutTimer = setTimeout(() => {
        void this.failTimeout();
      }, options.timeoutMs);
      this.timeoutTimer.unref?.();
    }

    this.pumpTask = this.pump();
    if (options.input !== undefined) {
      this.inputIterator = options.input[Symbol.asyncIterator]();
      this.inputTask = this.forwardInput(this.inputIterator);
    }
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
    if (bytes.byteLength === 0) {
      return;
    }
    try {
      await this.transport.send(encodeExecStdin(bytes));
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async resize(size: PtySize): Promise<void> {
    this.ensureOpen();
    assertPtyDimension(size.rows, "rows");
    assertPtyDimension(size.cols, "cols");
    try {
      await this.transport.send(encodeExecResize(size.rows, size.cols));
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async wait(): Promise<{ readonly exitCode: number; readonly signal: string | null }> {
    await this.pumpTask;
    if (this.failure !== null) {
      throw this.failure;
    }
    if (this.exitCode === null) {
      throw SboxError.internal("PTY session ended without an exit status.");
    }
    return { exitCode: this.exitCode, signal: this.exitSignal };
  }

  async cancel(reason = "cancelled"): Promise<void> {
    if (this.settled || this.finishing !== null) {
      await this.finishing;
      return;
    }
    this.cancelled = true;
    this.failure = SboxError.cancellation(`PTY session was cancelled (${reason}).`);
    await this.signalKill();
    await this.cleanup();
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
    await this.signalKill();
    await this.cleanup();
  }

  private async pump(): Promise<void> {
    try {
      for await (const frame of this.transport.frames) {
        if (this.settled) {
          break;
        }
        const envelope = decodeEnvelope(frame.body);
        switch (envelope.t) {
          case MSG_EXEC_STARTED: {
            decodePayload<ExecStartedPayload>(envelope);
            break;
          }
          case MSG_EXEC_STDOUT:
          case MSG_EXEC_STDERR: {
            // PTY merges to the master; accept either stream name as output.
            const payload = decodePayload<ExecBytesPayload>(envelope);
            const data = toUint8Array(payload.data);
            if (data.byteLength > 0) {
              const pushed = await this.outputQueue.push(data);
              if (pushed === "closed") {
                return;
              }
            }
            break;
          }
          case MSG_EXEC_STDIN_ERROR:
            // Non-terminal; ignore for public session.
            break;
          case MSG_EXEC_EXITED: {
            const payload = decodePayload<ExecExitedPayload>(envelope);
            this.exitCode = payload.code;
            this.exitSignal = null;
            await this.cleanup();
            break;
          }
          case MSG_EXEC_FAILED: {
            const payload = decodePayload<ExecFailedPayload>(envelope);
            this.failure = SboxError.nativeState("Guest process failed to start.", {
              details: { kind: payload.kind },
            });
            await this.cleanup();
            break;
          }
          default:
            break;
        }
        if ((frame.flags & FLAG_TERMINAL) !== 0 && !this.settled) {
          await this.cleanup();
        }
      }
    } catch (error) {
      if (!this.settled) {
        this.failure = isAbortError(error)
          ? SboxError.cancellation("PTY session was aborted.")
          : mapNativeError(error);
        await this.cleanup();
      }
    } finally {
      if (!this.settled) {
        await this.cleanup();
      }
    }
  }

  private async forwardInput(iterator: AsyncIterator<Uint8Array>): Promise<void> {
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
    } catch (error) {
      if (!this.settled) {
        this.failure = mapNativeError(error);
        await this.cancel("input-error");
      }
    }
  }

  private async cleanup(): Promise<void> {
    if (this.finishing !== null) {
      await this.finishing;
      return;
    }
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.finishing = this.cleanupBody();
    await this.finishing;
  }

  private async cleanupBody(): Promise<void> {
    this.settleResolve?.();
    this.settleResolve = null;
    this.clearTimeoutTimer();
    this.removeAbortListener();
    this.outputQueue.close(this.failure ?? undefined);

    if (this.inputIterator !== undefined) {
      closeAsyncIterator(this.inputIterator);
    }

    await this.closeTransport();

    if (this.inputTask !== undefined) {
      observeDetached(this.inputTask);
    }
  }

  private async signalKill(): Promise<void> {
    if (this.signalCount > 0) {
      return;
    }
    this.signalCount = 1;
    try {
      await this.transport.send(encodeExecSignal(SIGKILL));
    } catch {
      // Best-effort cleanup.
    }
  }

  private async closeTransport(): Promise<void> {
    if (this.closeCount > 0) {
      return;
    }
    this.closeCount = 1;
    try {
      await this.transport.close();
    } catch {
      // Ignore.
    }
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer !== undefined) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
  }

  private removeAbortListener(): void {
    if (this.abortSignal !== undefined) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
  }

  private ensureOpen(): void {
    if (this.settled) {
      throw this.failure ?? SboxError.nativeState("PTY session is already closed.");
    }
    if (this.cancelled) {
      throw SboxError.cancellation("PTY session was cancelled.");
    }
  }
}

function toUint8Array(data: Uint8Array | Buffer): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}
