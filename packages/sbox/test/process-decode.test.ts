import { describe, expect, it } from "vitest";
import {
  IncrementalUtf8Decoder,
  LineDecoder,
  bytesToUtf8,
  concatBytes,
  utf8ToBytes,
} from "../src/index.js";

describe("concatBytes / bytesToUtf8", () => {
  it("concatenates chunks in order", () => {
    const a = utf8ToBytes("hel");
    const b = utf8ToBytes("lo");
    expect(bytesToUtf8(concatBytes([a, b]))).toBe("hello");
  });

  it("handles empty chunk lists", () => {
    expect(concatBytes([])).toEqual(new Uint8Array());
    expect(bytesToUtf8(new Uint8Array())).toBe("");
  });

  it("preserves binary bytes that are not valid UTF-8", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x61]);
    const text = bytesToUtf8(bytes);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("\u0000");
  });
});

describe("IncrementalUtf8Decoder", () => {
  it("decodes a multibyte character split across chunk boundaries", () => {
    // U+1F600 😀 is F0 9F 98 80
    const full = utf8ToBytes("😀");
    expect(full.byteLength).toBe(4);
    const decoder = new IncrementalUtf8Decoder();
    expect(decoder.push(full.subarray(0, 2))).toBe("");
    expect(decoder.push(full.subarray(2))).toBe("😀");
    expect(decoder.finish()).toBe("");
  });

  it("accumulates ASCII across pushes and finish()", () => {
    const decoder = new IncrementalUtf8Decoder();
    expect(decoder.push(utf8ToBytes("ab"))).toBe("ab");
    expect(decoder.push(utf8ToBytes("cd"))).toBe("cd");
    expect(decoder.finish()).toBe("");
  });
});

describe("LineDecoder", () => {
  it("emits complete lines ending in \\n and strips \\r", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(utf8ToBytes("a\r\nb\n"))).toEqual(["a", "b"]);
    expect(decoder.finish()).toEqual([]);
  });

  it("holds a final partial line until finish()", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(utf8ToBytes("hello"))).toEqual([]);
    expect(decoder.push(utf8ToBytes(" world"))).toEqual([]);
    expect(decoder.finish()).toEqual(["hello world"]);
  });

  it("decodes a split UTF-8 sequence that straddles a line boundary", () => {
    // "café\n" — é is C3 A9; split after C3 so the line break is not yet complete
    const line = utf8ToBytes("café\nmore");
    const decoder = new LineDecoder();
    const idx = line.indexOf(0xa9); // second byte of é
    expect(decoder.push(line.subarray(0, idx))).toEqual([]);
    expect(decoder.push(line.subarray(idx))).toEqual(["café"]);
    expect(decoder.finish()).toEqual(["more"]);
  });
});
