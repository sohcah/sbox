/**
 * Bridges remote WebSocket stdin frames into a Host streaming exec iterable.
 *
 * LocalHost closes native stdin immediately when no iterable is provided; the
 * remote server therefore must supply this bridge so prompt bytes that arrive
 * after `ready` still reach the guest (e.g. Codex `codex exec` via stdin).
 */

import {
  BoundedAsyncQueue,
  DEFAULT_STREAM_QUEUE_CAPACITY,
} from "../process/bounded-queue.js";

export interface StdinBridge {
  readonly iterable: AsyncIterable<Uint8Array>;
  push(data: Uint8Array): Promise<void>;
  end(): void;
}

export function createStdinBridge(
  capacity: number = DEFAULT_STREAM_QUEUE_CAPACITY,
): StdinBridge {
  const queue = new BoundedAsyncQueue<Uint8Array>(capacity);
  return {
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            const result = await queue.shift();
            if (result.kind === "value") {
              return { done: false, value: result.value };
            }
            if (result.error !== null) {
              throw result.error;
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
    async push(data: Uint8Array): Promise<void> {
      await queue.push(data);
    },
    end(): void {
      queue.close();
    },
  };
}
