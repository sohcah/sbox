import { decode } from "cbor-x";
import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_VERSION,
  MSG_EXEC_REQUEST,
  MSG_EXEC_RESIZE,
  MSG_EXEC_STDIN,
  decodeEnvelope,
  decodePayload,
  encodeEnvelope,
  encodeExecRequest,
  encodeExecResize,
  encodeExecStdin,
  type ExecRequestPayload,
  type ExecResizePayload,
} from "../src/internal/agent-protocol.js";

describe("agent-protocol codec (PROTOCOL_VERSION 6)", () => {
  it("pins protocol generation 6 on envelopes", () => {
    expect(AGENT_PROTOCOL_VERSION).toBe(6);
    const body = encodeEnvelope("fixture.type", { ok: true });
    const envelope = decodeEnvelope(body);
    expect(envelope.v).toBe(6);
    expect(envelope.t).toBe("fixture.type");
    expect(decodePayload<{ ok: boolean }>(envelope)).toEqual({ ok: true });
  });

  it("round-trips exec request payloads", () => {
    const payload: ExecRequestPayload = {
      cmd: "/bin/sh",
      args: ["-c", "echo hi"],
      env: ["PATH=/usr/bin"],
      cwd: "/root",
      user: "root",
      tty: true,
      rows: 24,
      cols: 80,
    };
    const body = encodeExecRequest(payload);
    const envelope = decodeEnvelope(body);
    expect(envelope.v).toBe(AGENT_PROTOCOL_VERSION);
    expect(envelope.t).toBe(MSG_EXEC_REQUEST);
    const decoded = decodePayload<ExecRequestPayload & { rlimits: unknown[] }>(envelope);
    expect(decoded.cmd).toBe("/bin/sh");
    expect(decoded.args).toEqual(["-c", "echo hi"]);
    expect(decoded.env).toEqual(["PATH=/usr/bin"]);
    expect(decoded.cwd).toBe("/root");
    expect(decoded.user).toBe("root");
    expect(decoded.tty).toBe(true);
    expect(decoded.rows).toBe(24);
    expect(decoded.cols).toBe(80);
    expect(decoded.rlimits).toEqual([]);
  });

  it("encodes stdin EOF-sized empty payloads and binary chunks", () => {
    const empty = encodeExecStdin(new Uint8Array());
    const emptyEnv = decodeEnvelope(empty);
    expect(emptyEnv.t).toBe(MSG_EXEC_STDIN);
    expect(decodePayload<{ data: Uint8Array }>(emptyEnv).data.byteLength).toBe(0);

    const bytes = new Uint8Array([0, 1, 255, 10]);
    const body = encodeExecStdin(bytes);
    const envelope = decodeEnvelope(body);
    expect(envelope.t).toBe(MSG_EXEC_STDIN);
    expect(Buffer.from(decodePayload<{ data: Uint8Array }>(envelope).data)).toEqual(
      Buffer.from(bytes),
    );
  });

  it("round-trips resize messages", () => {
    const body = encodeExecResize(40, 120);
    const envelope = decodeEnvelope(body);
    expect(envelope.t).toBe(MSG_EXEC_RESIZE);
    expect(envelope.v).toBe(6);
    expect(decodePayload<ExecResizePayload>(envelope)).toEqual({ rows: 40, cols: 120 });
  });

  it("nests CBOR payload bytes inside the outer envelope", () => {
    const body = encodeEnvelope("core.exec.request", { cmd: "true", args: [] });
    const outer = decode(body) as { v: number; t: string; p: Uint8Array };
    expect(outer.v).toBe(6);
    expect(outer.t).toBe("core.exec.request");
    expect(outer.p).toBeInstanceOf(Uint8Array);
    expect(decode(outer.p)).toMatchObject({ cmd: "true" });
  });

  it("rejects malformed envelopes", () => {
    expect(() => decodeEnvelope(Buffer.from("not-cbor"))).toThrowError(/protocol/i);
    // CBOR empty map lacks v/t/p.
    expect(() => decodeEnvelope(Buffer.from([0xa0]))).toThrowError(/protocol/i);
  });
});
