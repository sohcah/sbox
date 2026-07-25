/**
 * Node stream helpers for Sandcastle interactive and live-line exec.
 */

import { utf8ToBytes } from "@sohcah/sbox";

/** Convert a Node readable into an async byte iterable. */
export async function* readableToAsyncIterable(
  stream: NodeJS.ReadableStream,
): AsyncIterable<Uint8Array> {
  for await (const chunk of stream as AsyncIterable<string | Buffer | Uint8Array>) {
    if (typeof chunk === "string") {
      yield utf8ToBytes(chunk);
    } else if (chunk instanceof Uint8Array) {
      yield chunk;
    } else {
      yield new Uint8Array(chunk);
    }
  }
}

/** Write bytes with backpressure to a Node writable. */
export function writeAll(stream: NodeJS.WritableStream, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = stream.write(Buffer.from(data));
    if (ok) {
      resolve();
      return;
    }
    const onDrain = (): void => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      stream.off("drain", onDrain);
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

export function isReadableTty(stream: NodeJS.ReadableStream): boolean {
  return "isTTY" in stream && (stream as NodeJS.ReadStream).isTTY === true;
}

export function ttySize(stream: NodeJS.WritableStream): { rows: number; cols: number } {
  const writeStream = stream as NodeJS.WriteStream;
  return {
    rows: typeof writeStream.rows === "number" && writeStream.rows > 0 ? writeStream.rows : 24,
    cols:
      typeof writeStream.columns === "number" && writeStream.columns > 0 ? writeStream.columns : 80,
  };
}
