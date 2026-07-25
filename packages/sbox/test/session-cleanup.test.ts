/**
 * Focused session cleanup / backpressure tests for SdkProcessSession and
 * AgentPtySession.
 */

import { describe, expect, it } from "vitest";
import { agentPtySessionDiagnostics, createAgentPtySession } from "../src/internal/agent-pty.js";
import {
  FLAG_TERMINAL,
  MSG_EXEC_EXITED,
  MSG_EXEC_STARTED,
  MSG_EXEC_STDOUT,
  encodeEnvelope,
} from "../src/internal/agent-protocol.js";
import {
  createSdkProcessSession,
  sdkProcessSessionDiagnostics,
  type SdkNativeProcessHandle,
} from "../src/local-process.js";
import { BoundedAsyncQueue } from "../src/process/bounded-queue.js";
import { utf8ToBytes } from "../src/process/decode.js";

const SETTLE_MS = 250;

function hangingIterable(options?: { hangReturn?: boolean }): {
  iterable: AsyncIterable<Uint8Array>;
  returnCalls: number;
} {
  let returnCalls = 0;
  const hangReturn = options?.hangReturn === true;
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      return: () => {
        returnCalls += 1;
        if (hangReturn) {
          return new Promise<IteratorResult<Uint8Array>>(() => undefined);
        }
        return Promise.resolve({ done: true as const, value: undefined });
      },
    }),
  };
  return {
    iterable,
    get returnCalls() {
      return returnCalls;
    },
  };
}

function mockProcessHandle(
  events: Array<
    | { kind: "started"; pid: number }
    | { kind: "stdout"; data: Uint8Array }
    | { kind: "stderr"; data: Uint8Array }
    | { kind: "exited"; code: number }
    | null
  >,
): SdkNativeProcessHandle & { killCount: number; disposeCount: number } {
  let index = 0;
  let killCount = 0;
  let disposeCount = 0;
  const handle: SdkNativeProcessHandle & { killCount: number; disposeCount: number } = {
    get killCount() {
      return killCount;
    },
    get disposeCount() {
      return disposeCount;
    },
    recv: async () => {
      if (index >= events.length) {
        return null;
      }
      return events[index++]!;
    },
    takeStdin: async () => ({
      write: async () => undefined,
      close: async () => undefined,
    }),
    signal: async () => undefined,
    kill: async () => {
      killCount += 1;
    },
    [Symbol.asyncDispose]: async () => {
      disposeCount += 1;
    },
  };
  return handle;
}

describe("BoundedAsyncQueue", () => {
  it("blocks producers at capacity and unblocks on cancel", async () => {
    const queue = new BoundedAsyncQueue<number>(2);
    expect(await queue.push(1)).toBe("ok");
    expect(await queue.push(2)).toBe("ok");
    let thirdResolved = false;
    const third = queue.push(3).then((result) => {
      thirdResolved = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(thirdResolved).toBe(false);
    expect(queue.size).toBe(2);
    queue.close();
    await expect(third).resolves.toBe("closed");
    expect(thirdResolved).toBe(true);
  });
});

describe("SdkProcessSession cleanup and backpressure", () => {
  it("settles promptly when caller stdin next() never resolves", async () => {
    const hanging = hangingIterable();
    const handle = mockProcessHandle([
      { kind: "started", pid: 7 },
      { kind: "exited", code: 0 },
    ]);
    const session = createSdkProcessSession(handle, {
      stdin: hanging.iterable,
      queueCapacity: 8,
    });

    const drain = (async () => {
      for await (const event of session) {
        void event;
      }
    })();

    await expect(Promise.race([session.wait(), timeout(SETTLE_MS)])).resolves.toEqual({
      exitCode: 0,
      signal: null,
    });
    await expect(
      Promise.race([session.cancel("late"), timeout(SETTLE_MS)]),
    ).resolves.toBeUndefined();
    await expect(
      Promise.race([session[Symbol.asyncDispose](), timeout(SETTLE_MS)]),
    ).resolves.toBeUndefined();
    await drain;

    expect(hanging.returnCalls).toBe(1);
    const diag = sdkProcessSessionDiagnostics(session);
    expect(diag).toEqual({ killCount: 0, disposeCount: 1 });
    expect(handle.disposeCount).toBe(1);
    expect(handle.killCount).toBe(0);
  });

  it("settles promptly when both next() and return() never resolve", async () => {
    const hanging = hangingIterable({ hangReturn: true });
    const handle = mockProcessHandle([
      { kind: "started", pid: 3 },
      { kind: "exited", code: 0 },
    ]);
    const session = createSdkProcessSession(handle, { stdin: hanging.iterable });

    const drain = (async () => {
      for await (const event of session) {
        void event;
      }
    })();

    await expect(Promise.race([session.wait(), timeout(SETTLE_MS)])).resolves.toEqual({
      exitCode: 0,
      signal: null,
    });
    await expect(
      Promise.race([session[Symbol.asyncDispose](), timeout(SETTLE_MS)]),
    ).resolves.toBeUndefined();
    await drain;

    expect(hanging.returnCalls).toBe(1);
    expect(sdkProcessSessionDiagnostics(session)).toEqual({ killCount: 0, disposeCount: 1 });
    expect(handle.disposeCount).toBe(1);
  });

  it("kills once on cancel while stdin is hanging", async () => {
    const hanging = hangingIterable();
    let killCount = 0;
    let disposeCount = 0;
    let started = false;
    let killWake: (() => void) | undefined;
    let killed = false;

    const handle: SdkNativeProcessHandle = {
      recv: async () => {
        if (!started) {
          started = true;
          return { kind: "started", pid: 1 };
        }
        await new Promise<void>((resolve) => {
          if (killed) {
            resolve();
            return;
          }
          killWake = resolve;
        });
        return { kind: "exited", code: 137 };
      },
      takeStdin: async () => ({
        write: async () => undefined,
        close: async () => undefined,
      }),
      signal: async () => undefined,
      kill: async () => {
        killCount += 1;
        killed = true;
        killWake?.();
      },
      [Symbol.asyncDispose]: async () => {
        disposeCount += 1;
      },
    };

    const session = createSdkProcessSession(handle, { stdin: hanging.iterable });
    const drain = (async () => {
      try {
        for await (const event of session) {
          void event;
        }
      } catch {
        // Cancellation may surface through the iterator.
      }
    })();

    await expect.poll(() => started).toBe(true);
    await expect(
      Promise.race([session.cancel("test"), timeout(SETTLE_MS)]),
    ).resolves.toBeUndefined();
    await expect(Promise.race([session.wait(), timeout(SETTLE_MS)])).rejects.toMatchObject({
      code: "cancellation",
    });
    await expect(
      Promise.race([session[Symbol.asyncDispose](), timeout(SETTLE_MS)]),
    ).resolves.toBeUndefined();
    await drain;

    expect(hanging.returnCalls).toBe(1);
    expect(killCount).toBe(1);
    expect(disposeCount).toBe(1);
    expect(sdkProcessSessionDiagnostics(session)).toEqual({ killCount: 1, disposeCount: 1 });
  });

  it("cannot enqueue beyond the configured stream queue bound", async () => {
    const capacity = 2;
    let pushCount = 0;
    let releaseRecv: (() => void) | undefined;
    const recvGate = new Promise<void>((resolve) => {
      releaseRecv = resolve;
    });

    const handle: SdkNativeProcessHandle = {
      recv: async () => {
        if (pushCount === 0) {
          pushCount += 1;
          return { kind: "started", pid: 1 };
        }
        if (pushCount <= capacity + 2) {
          // Emit more stdout than capacity; pump must pause in push().
          pushCount += 1;
          return { kind: "stdout", data: utf8ToBytes(`c${pushCount}`) };
        }
        await recvGate;
        return { kind: "exited", code: 0 };
      },
      takeStdin: async () => null,
      signal: async () => undefined,
      kill: async () => undefined,
      [Symbol.asyncDispose]: async () => undefined,
    };

    const session = createSdkProcessSession(handle, { queueCapacity: capacity });
    const iterator = session[Symbol.asyncIterator]();

    // Read started to make room tracking clear.
    await expect(iterator.next()).resolves.toMatchObject({ done: false });

    // Allow pump to fill the queue without consuming further.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    // pushCount: started(1) + capacity stdout attempts that filled queue + maybe one blocked
    // After started consumed, queue can hold `capacity` stdout events. Pump may be blocked
    // trying to push capacity+1.
    expect(pushCount).toBeLessThanOrEqual(1 + capacity + 1);

    await session.cancel("bound-test");
    releaseRecv?.();
    await expect(session.wait()).rejects.toMatchObject({ code: "cancellation" });
  });
});

describe("AgentPtySession cleanup, backpressure, and timeout", () => {
  it("settles promptly when input next() never resolves", async () => {
    const hanging = hangingIterable();
    let closeCount = 0;
    let signalCount = 0;
    const frames = (async function* () {
      yield {
        flags: 0,
        body: encodeEnvelope(MSG_EXEC_STARTED, { pid: 1 }),
      };
      yield {
        flags: FLAG_TERMINAL,
        body: encodeEnvelope(MSG_EXEC_EXITED, { code: 0 }),
      };
    })();

    const session = createAgentPtySession(
      {
        send: async () => {
          signalCount += 1;
        },
        frames,
        close: async () => {
          closeCount += 1;
        },
      },
      { input: hanging.iterable, queueCapacity: 8 },
    );

    const drain = (async () => {
      for await (const chunk of session.output) {
        void chunk;
      }
    })();

    await expect(Promise.race([session.wait(), timeout(SETTLE_MS)])).resolves.toEqual({
      exitCode: 0,
      signal: null,
    });
    await expect(
      Promise.race([session.cancel("late"), timeout(SETTLE_MS)]),
    ).resolves.toBeUndefined();
    await expect(
      Promise.race([session[Symbol.asyncDispose](), timeout(SETTLE_MS)]),
    ).resolves.toBeUndefined();
    await drain;

    expect(hanging.returnCalls).toBe(1);
    expect(closeCount).toBe(1);
    expect(agentPtySessionDiagnostics(session)).toEqual({ signalCount: 0, closeCount: 1 });
  });

  it("settles promptly when PTY input next() and return() never resolve", async () => {
    const hanging = hangingIterable({ hangReturn: true });
    let closeCount = 0;
    const frames = (async function* () {
      yield {
        flags: 0,
        body: encodeEnvelope(MSG_EXEC_STARTED, { pid: 1 }),
      };
      yield {
        flags: FLAG_TERMINAL,
        body: encodeEnvelope(MSG_EXEC_EXITED, { code: 0 }),
      };
    })();

    const session = createAgentPtySession(
      {
        send: async () => undefined,
        frames,
        close: async () => {
          closeCount += 1;
        },
      },
      { input: hanging.iterable },
    );

    const drain = (async () => {
      for await (const chunk of session.output) {
        void chunk;
      }
    })();

    await expect(Promise.race([session.wait(), timeout(SETTLE_MS)])).resolves.toEqual({
      exitCode: 0,
      signal: null,
    });
    await expect(
      Promise.race([session[Symbol.asyncDispose](), timeout(SETTLE_MS)]),
    ).resolves.toBeUndefined();
    await drain;

    expect(hanging.returnCalls).toBe(1);
    expect(closeCount).toBe(1);
  });

  it("times out distinctly from cancel and closes once", async () => {
    let closeCount = 0;
    let signalCount = 0;
    let closed = false;
    let wakeFrames: (() => void) | undefined;

    const frames = (async function* () {
      yield {
        flags: 0,
        body: encodeEnvelope(MSG_EXEC_STARTED, { pid: 1 }),
      };
      await new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        wakeFrames = resolve;
      });
    })();

    const session = createAgentPtySession(
      {
        send: async () => {
          signalCount += 1;
        },
        frames,
        close: async () => {
          closeCount += 1;
          closed = true;
          wakeFrames?.();
        },
      },
      { timeoutMs: 40, queueCapacity: 4 },
    );

    const drain = (async () => {
      try {
        for await (const chunk of session.output) {
          void chunk;
        }
      } catch {
        // Timeout may surface on the output iterator.
      }
    })();

    await expect(session.wait()).rejects.toMatchObject({ code: "timeout" });
    await session[Symbol.asyncDispose]();
    await drain;

    expect(closeCount).toBe(1);
    expect(signalCount).toBe(1);
    expect(agentPtySessionDiagnostics(session)).toEqual({ signalCount: 1, closeCount: 1 });
  });

  it("bounds PTY output and unblocks producers on cancel", async () => {
    const capacity = 2;
    let emitted = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const frames = (async function* () {
      yield {
        flags: 0,
        body: encodeEnvelope(MSG_EXEC_STARTED, { pid: 1 }),
      };
      for (let i = 0; i < capacity + 5; i += 1) {
        emitted += 1;
        yield {
          flags: 0,
          body: encodeEnvelope(MSG_EXEC_STDOUT, { data: utf8ToBytes(`x${i}`) }),
        };
      }
      await gate;
      yield {
        flags: FLAG_TERMINAL,
        body: encodeEnvelope(MSG_EXEC_EXITED, { code: 0 }),
      };
    })();

    const session = createAgentPtySession(
      {
        send: async () => undefined,
        frames,
        close: async () => undefined,
      },
      { queueCapacity: capacity },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(emitted).toBeLessThanOrEqual(capacity + 1);

    await session.cancel("pty-bound");
    release?.();
    await expect(session.wait()).rejects.toMatchObject({ code: "cancellation" });
  });
});

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref?.();
  });
}
