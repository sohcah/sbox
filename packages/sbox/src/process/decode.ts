/**
 * Byte-preserving UTF-8 and line decoding helpers.
 *
 * Core streams remain byte-oriented. These helpers decode for callers that want
 * UTF-8 text or live lines across arbitrary chunk boundaries.
 */

export function bytesToUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
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

/**
 * Incremental UTF-8 decoder that preserves incomplete trailing multibyte
 * sequences across chunk boundaries.
 */
export class IncrementalUtf8Decoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  push(chunk: Uint8Array): string {
    return this.decoder.decode(chunk, { stream: true });
  }

  finish(): string {
    return this.decoder.decode();
  }
}

/**
 * Live line decoder. Emits complete lines ending in `\n` (stripping the
 * terminator). A final unterminated fragment is emitted by `finish()`.
 */
export class LineDecoder {
  private readonly utf8 = new IncrementalUtf8Decoder();
  private buffer = "";

  push(chunk: Uint8Array): string[] {
    this.buffer += this.utf8.push(chunk);
    return this.drain(false);
  }

  finish(): string[] {
    this.buffer += this.utf8.finish();
    return this.drain(true);
  }

  private drain(emitPartial: boolean): string[] {
    const lines: string[] = [];
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) {
        break;
      }
      let line = this.buffer.slice(0, idx);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      lines.push(line);
      this.buffer = this.buffer.slice(idx + 1);
    }
    if (emitPartial && this.buffer.length > 0) {
      lines.push(this.buffer);
      this.buffer = "";
    }
    return lines;
  }
}

/**
 * Collect UTF-8 text from an async byte stream using an incremental decoder.
 */
export async function collectUtf8(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new IncrementalUtf8Decoder();
  let text = "";
  for await (const chunk of chunks) {
    text += decoder.push(chunk);
  }
  text += decoder.finish();
  return text;
}

/**
 * Collect complete lines from an async byte stream, including a final
 * unterminated line when present.
 */
export async function collectLines(chunks: AsyncIterable<Uint8Array>): Promise<string[]> {
  const decoder = new LineDecoder();
  const lines: string[] = [];
  for await (const chunk of chunks) {
    lines.push(...decoder.push(chunk));
  }
  lines.push(...decoder.finish());
  return lines;
}
