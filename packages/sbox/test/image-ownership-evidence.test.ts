import { describe, expect, it } from "vitest";
import {
  buildImageOwnershipEnv,
  buildImageOwnershipLabels,
  inspectImageOwnershipEvidence,
} from "../src/image/naming.js";

const DIGEST = "a".repeat(64);
const OTHER = "b".repeat(64);

function envLines(digestHex: string): string[] {
  return Object.entries(buildImageOwnershipEnv(digestHex)).map(([key, value]) => `${key}=${value}`);
}

describe("inspectImageOwnershipEvidence", () => {
  it("accepts both complete matching label and ENV sets", () => {
    expect(
      inspectImageOwnershipEvidence(buildImageOwnershipLabels(DIGEST), envLines(DIGEST), DIGEST),
    ).toMatchObject({ ok: true, source: "labels" });
  });

  it("accepts ENV-only when reserved labels are entirely absent", () => {
    expect(inspectImageOwnershipEvidence({}, envLines(DIGEST), DIGEST)).toMatchObject({
      ok: true,
      source: "env",
    });
  });

  it("accepts labels-only when reserved ENV markers are entirely absent", () => {
    expect(
      inspectImageOwnershipEvidence(buildImageOwnershipLabels(DIGEST), [], DIGEST),
    ).toMatchObject({ ok: true, source: "labels" });
  });

  it("rejects wrong label identity even when ENV matches", () => {
    expect(
      inspectImageOwnershipEvidence(buildImageOwnershipLabels(OTHER), envLines(DIGEST), DIGEST),
    ).toMatchObject({ ok: false });
  });

  it("rejects wrong ENV identity even when labels match", () => {
    expect(
      inspectImageOwnershipEvidence(buildImageOwnershipLabels(DIGEST), envLines(OTHER), DIGEST),
    ).toMatchObject({ ok: false });
  });

  it("rejects partial labels even when ENV matches", () => {
    expect(
      inspectImageOwnershipEvidence(
        { "dev.sohcah.sbox/managed": "true" },
        envLines(DIGEST),
        DIGEST,
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects partial ENV even when labels match", () => {
    expect(
      inspectImageOwnershipEvidence(
        buildImageOwnershipLabels(DIGEST),
        ["DEV_SOHCAH_SBOX_MANAGED=true"],
        DIGEST,
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects when both channels are absent", () => {
    expect(inspectImageOwnershipEvidence({}, [], DIGEST)).toMatchObject({
      ok: false,
      reason: "Image ownership evidence is missing.",
    });
  });
});
