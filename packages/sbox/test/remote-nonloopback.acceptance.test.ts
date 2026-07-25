/**
 * Acceptance: non-loopback HTTP serve gating and unencrypted-data warning.
 *
 * Uses FakeHost (no Microsandbox). Opt-in via `pnpm test:acceptance`.
 */

import { describe, expect, it } from "vitest";
import {
  createRemoteHost,
  createSboxServer,
  isSboxError,
  SBOX_PROTOCOL_VERSION,
} from "../src/index.js";
import { formatRemoteUrlCheckDetail } from "../src/cli/commands/doctor.js";
import { FakeHost } from "../src/fake-host.js";
import { collectingLogger } from "../src/logging.js";
import { formatAcceptanceStatusLine } from "./helpers/acceptance-status.js";

const TOKEN = "acceptance-nonloopback-token-01";

describe("non-loopback HTTP acceptance", () => {
  it("rejects unbound allow, warns when allowed, and doctor flags cleartext URLs", async ({
    skip,
  }) => {
    const forced = process.env["SBOX_ACCEPTANCE_FORCE"];
    if (forced === "unavailable" || forced === "passed" || forced === "failed") {
      console.log(
        formatAcceptanceStatusLine(forced, forced === "unavailable" ? "forced" : undefined),
      );
      if (forced === "unavailable") {
        skip(true, "Non-loopback acceptance unavailable: forced");
      }
      if (forced === "failed") {
        throw new Error("forced acceptance failure");
      }
      return;
    }

    await using fake = new FakeHost();

    await expect(
      createSboxServer({
        host: fake,
        bearerToken: TOKEN,
        bind: "0.0.0.0",
      }),
    ).rejects.toSatisfy((error: unknown) => isSboxError(error) && error.code === "validation");

    const { logger, events } = collectingLogger();
    await using server = await createSboxServer({
      host: fake,
      bearerToken: TOKEN,
      bind: "0.0.0.0",
      allowNonLoopback: true,
      logger,
    });

    expect(
      events.some(
        (event) =>
          event.level === "warn" &&
          event.message.includes("non-loopback") &&
          event.message.includes("unencrypted"),
      ),
    ).toBe(true);

    expect(formatRemoteUrlCheckDetail(server.url)).toContain("non-loopback HTTP is unencrypted");
    expect(formatRemoteUrlCheckDetail("http://203.0.113.10:8787")).toContain(
      "non-loopback HTTP is unencrypted",
    );
    expect(formatRemoteUrlCheckDetail("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");

    const clientUrl = new URL(server.url);
    clientUrl.hostname = "127.0.0.1";
    await using remote = createRemoteHost({ url: clientUrl.toString(), bearerToken: TOKEN });
    const caps = await remote.capabilities();
    expect(caps.notes.join(" ")).toContain("FakeHost");
    expect(caps.qemuImg).toBe(true);

    const health = await fetch(new URL("/health", clientUrl));
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; protocolVersion: number };
    expect(body.ok).toBe(true);
    expect(body.protocolVersion).toBe(SBOX_PROTOCOL_VERSION);

    console.log(formatAcceptanceStatusLine("passed"));
  });
});
