import { describe, expect, it } from "vitest";
import { SECRET_DETAIL_CANARY_KEYS, SboxError } from "../src/errors.js";
import { FakeHost } from "../src/fake-host.js";
import { assertSandboxIdentity } from "../src/identity.js";
import { createLocalHostInternal } from "../src/local-host-internal.js";
import { MemoryNativeRuntime } from "./helpers/memory-native-runtime.js";

describe("SboxError serialization", () => {
  it("redacts canaries through JSON.stringify and nested objects/arrays", () => {
    const nested = {
      token: "CANARY-TOKEN",
      nested: { password: "CANARY-PASS", ok: true },
      list: [{ apiKey: "CANARY-KEY" }, "plain"],
    };
    const error = SboxError.internal("x", {
      details: nested,
      cause: SboxError.internal("cause", { details: { secret: "CANARY-CAUSE" } }),
    });

    const direct = JSON.stringify(error);
    expect(direct).not.toContain("CANARY");
    expect(direct).toContain("[redacted]");

    const nestedJson = JSON.stringify({ error, more: [error] });
    expect(nestedJson).not.toContain("CANARY");

    for (const key of SECRET_DETAIL_CANARY_KEYS) {
      const sample = SboxError.internal("x", { details: { [key]: `value-${key}` } });
      expect(JSON.stringify(sample)).not.toContain(`value-${key}`);
    }

    // details remain available to code but are not enumerable for naive serializers.
    expect(error.details["token"]).toBe("CANARY-TOKEN");
    expect(Object.keys(error)).not.toContain("details");
  });
});

describe("logger isolation", () => {
  it("does not change lifecycle outcomes when the logger throws", async () => {
    const throwingLogger = {
      log(): void {
        throw new Error("logger boom");
      },
    };
    const identity = assertSandboxIdentity({
      project: "demo",
      profile: "default",
      instance: "logger",
    });
    const request = { identity, image: "alpine:3.20" };

    const fake = new FakeHost({ logger: throwingLogger });
    const created = await fake.create(request);
    expect(created.state).toBe("running");
    await fake.stop(identity);
    await fake.start(identity);
    await fake.remove(identity);
    await expect(fake.get(identity)).rejects.toMatchObject({ code: "not_found" });

    const runtime = new MemoryNativeRuntime();
    const local = createLocalHostInternal({ runtime, logger: throwingLogger });
    await local.create(request);
    await local.stop(identity);
    await local.start(identity);
    await local.remove(identity);

    // Failure classification is also preserved.
    await expect(local.get(identity)).rejects.toMatchObject({ code: "not_found" });
  });
});
