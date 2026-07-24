import {
  HttpError,
  ImageError,
  ImageNotFoundError,
  LibkrunfwNotFoundError,
  MicrosandboxError,
  RuntimeError,
  UnsupportedError,
} from "microsandbox";
import { describe, expect, it } from "vitest";
import { isSboxError } from "../src/errors.js";
import { assertSandboxIdentity } from "../src/identity.js";
import { createLocalHostInternal } from "../src/local-host-internal.js";
import { collectingLogger } from "../src/logging.js";
import { mapNativeError } from "../src/microsandbox-runtime.js";
import { MemoryNativeRuntime } from "./helpers/memory-native-runtime.js";

const CANARIES = [
  "SECRET_ENV_CANARY",
  "SECRET_TOKEN_CANARY",
  "SECRET_CMD_CANARY",
  "SECRET_PATH_CANARY",
  "SECRET_AUTH_CANARY",
] as const;

describe("mapNativeError public messages", () => {
  it("never copies native canaries into public messages or JSON", () => {
    const message = [
      `env=${CANARIES[0]}`,
      `token=${CANARIES[1]}`,
      `command=/bin/${CANARIES[2]}`,
      `path=/tmp/${CANARIES[3]}`,
      `authorization=Bearer ${CANARIES[4]}`,
    ].join(" ");

    const natives: unknown[] = [
      new HttpError(`registry error: ${message}`),
      new ImageNotFoundError(`missing image ${message}`),
      new ImageError(`pull failed ${message}`),
      new LibkrunfwNotFoundError(`libkrun missing ${message}`),
      new UnsupportedError(`hypervisor ${message}`),
      new RuntimeError(`boom ${message}`),
      new MicrosandboxError("custom", `custom ${message}`),
      new Error(`generic ${message}`),
    ];

    for (const native of natives) {
      const mapped = mapNativeError(native);
      const json = JSON.stringify(mapped);
      for (const canary of CANARIES) {
        expect(mapped.message).not.toContain(canary);
        expect(json).not.toContain(canary);
      }
      expect(mapped.cause).toBe(native);
    }
  });

  it("maps prerequisite failures to capability with unavailableReason", () => {
    expect(
      mapNativeError(new HttpError("registry error: error sending request for url")).code,
    ).toBe("capability");
    expect(mapNativeError(new HttpError("x")).details["unavailableReason"]).toBe(
      "registry_unavailable",
    );
    expect(mapNativeError(new ImageNotFoundError("x")).details["unavailableReason"]).toBe(
      "image_unavailable",
    );
    expect(mapNativeError(new LibkrunfwNotFoundError("x")).details["unavailableReason"]).toBe(
      "missing_runtime",
    );
    expect(mapNativeError(new UnsupportedError("x")).details["unavailableReason"]).toBe(
      "unsupported_hypervisor",
    );
    expect(mapNativeError(new RuntimeError("adapter boom")).code).toBe("internal");
    expect(mapNativeError(new RuntimeError("adapter boom")).message).toBe(
      "Native sandbox operation failed.",
    );
  });

  it("keeps canaries out of LocalHost error serialization and logs", async () => {
    const canary = "SECRET_TOKEN_CANARY";
    const { logger, events } = collectingLogger();
    const runtime = new MemoryNativeRuntime();
    runtime.create = async () => {
      throw mapNativeError(new HttpError(`registry error token=${canary}`));
    };
    const host = createLocalHostInternal({ runtime, logger });
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "safe",
    });
    const error = await host.create({ identity, image: "alpine:3.20" }).catch((value) => value);
    expect(isSboxError(error)).toBe(true);
    if (isSboxError(error)) {
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(error.message).not.toContain(canary);
      expect(error.code).toBe("capability");
    }
    expect(JSON.stringify(events)).not.toContain(canary);
  });
});
