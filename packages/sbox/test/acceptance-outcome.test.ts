import { describe, expect, it } from "vitest";
import { SboxError } from "../src/errors.js";
import { classifyAcceptanceFailure } from "./helpers/acceptance-outcome.js";

describe("acceptance outcome classification", () => {
  it("reports registry/network, missing runtime, and unsupported hypervisor as unavailable", () => {
    expect(
      classifyAcceptanceFailure(
        SboxError.capability("Microsandbox prerequisite is unavailable.", {
          details: { unavailableReason: "registry_unavailable" },
        }),
      ),
    ).toBe("unavailable");
    expect(
      classifyAcceptanceFailure(
        SboxError.capability("Microsandbox prerequisite is unavailable.", {
          details: { unavailableReason: "image_unavailable" },
        }),
      ),
    ).toBe("unavailable");
    expect(
      classifyAcceptanceFailure(
        SboxError.capability("Microsandbox prerequisite is unavailable.", {
          details: { unavailableReason: "missing_runtime" },
        }),
      ),
    ).toBe("unavailable");
    expect(
      classifyAcceptanceFailure(
        SboxError.capability("Microsandbox prerequisite is unavailable.", {
          details: { unavailableReason: "unsupported_hypervisor" },
        }),
      ),
    ).toBe("unavailable");
  });

  it("reports genuine adapter exceptions as failed", () => {
    expect(classifyAcceptanceFailure(SboxError.internal("Native sandbox operation failed."))).toBe(
      "failed",
    );
    expect(
      classifyAcceptanceFailure(
        SboxError.capability("Some other capability issue.", {
          details: { unavailableReason: "not-a-known-reason" },
        }),
      ),
    ).toBe("failed");
    expect(classifyAcceptanceFailure(new Error("registry error: error sending request"))).toBe(
      "failed",
    );
  });
});
