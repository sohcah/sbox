/**
 * Real local volume acceptance (qemu-img + Microsandbox).
 */

import { describe, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalHostInternal } from "../src/local-host-internal.js";
import { probeQemuImg } from "../src/volume/qemu-img.js";
import { assertSandboxIdentity } from "../src/identity.js";
import { classifyAcceptanceFailure } from "./helpers/acceptance-outcome.js";
import { formatAcceptanceStatusLine } from "./helpers/acceptance-status.js";

describe("volume acceptance", () => {
  it("ensures a base, creates a child-backed sandbox, and removes overlays with the sandbox", async ({
    skip,
  }) => {
    const forced = process.env["SBOX_ACCEPTANCE_FORCE"];
    if (forced === "unavailable" || forced === "passed" || forced === "failed") {
      console.log(
        formatAcceptanceStatusLine(forced, forced === "unavailable" ? "forced" : undefined),
      );
      if (forced === "unavailable") {
        skip(true, "Microsandbox acceptance unavailable: forced");
      }
      if (forced === "failed") {
        throw new Error("forced acceptance failure");
      }
      return;
    }

    const qemu = await probeQemuImg();
    if (!qemu.available) {
      console.log(formatAcceptanceStatusLine("unavailable", "capability:qemu_img"));
      skip(true, "qemu-img unavailable");
      return;
    }

    const dataRoot = await mkdtemp(join(tmpdir(), "sbox-vol-accept-"));
    await using host = createLocalHostInternal({ volumeDataRoot: dataRoot });

    const identity = assertSandboxIdentity({
      project: "volaccept",
      profile: "default",
      instance: "default",
    });
    const sizeBytes = 64 * 1024 * 1024;
    try {
      await host.ensureVolume({
        project: identity.project,
        volume: "cache",
        sizeBytes,
      });
      const created = await host.create({
        identity,
        image: "alpine:3.20",
        volumes: [{ volume: "cache", path: "/cache", sizeBytes }],
      });
      if (
        created.creation.volumes.length !== 1 ||
        created.creation.volumes[0]?.volume !== "cache"
      ) {
        throw new Error("expected volume attachment on inspection");
      }
      await host.remove(created.identity);
      await host.removeVolume({ project: identity.project, volume: "cache" });
      console.log(formatAcceptanceStatusLine("passed"));
    } catch (error) {
      const status = classifyAcceptanceFailure(error);
      const reason =
        error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
      console.log(formatAcceptanceStatusLine(status, reason));
      if (status === "unavailable") {
        skip(true, `Microsandbox acceptance unavailable: ${reason}`);
        return;
      }
      throw error;
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
