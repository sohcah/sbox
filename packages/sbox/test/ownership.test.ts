import { describe, expect, it } from "vitest";
import { assertSandboxIdentity } from "../src/identity.js";
import {
  OWNERSHIP_LABEL_KEYS,
  hasPartialReservedLabels,
  inspectOwnershipLabels,
} from "../src/ownership.js";
import {
  buildOwnershipLabels,
  matchOwnedCreation,
  matchOwnershipLabels,
} from "../src/ownership-adoption.js";
import { projectCreateRequest } from "../src/immutable-creation.js";
import { defaultNetworkConfig } from "../src/network/types.js";

describe("ownership labels", () => {
  const identity = assertSandboxIdentity({
    project: "demo",
    profile: "default",
    instance: "main",
  });
  const creation = projectCreateRequest({ image: "alpine:3.20" });

  it("builds reserved ownership/project/instance/profile/creation labels", () => {
    const labels = buildOwnershipLabels(identity, creation);
    expect(labels[OWNERSHIP_LABEL_KEYS.managed]).toBe("true");
    expect(labels[OWNERSHIP_LABEL_KEYS.project]).toBe("demo");
    expect(labels[OWNERSHIP_LABEL_KEYS.instance]).toBe("main");
    expect(labels[OWNERSHIP_LABEL_KEYS.profile]).toBe("default");
    expect(labels[OWNERSHIP_LABEL_KEYS.creation]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("matches exact ownership and allows unrelated labels", () => {
    const labels = {
      ...buildOwnershipLabels(identity, creation),
      "unrelated/label": "ok",
    };
    const matched = matchOwnershipLabels(labels, identity, creation);
    expect(matched.ok).toBe(true);
    if (matched.ok) {
      expect(matched.identity).toEqual(identity);
    }
  });

  it("fails closed on missing, mismatched, or different creation fingerprints", () => {
    expect(matchOwnershipLabels(undefined, identity, creation).ok).toBe(false);
    expect(matchOwnershipLabels({}, identity, creation).ok).toBe(false);
    expect(
      matchOwnershipLabels(
        { ...buildOwnershipLabels(identity, creation), [OWNERSHIP_LABEL_KEYS.project]: "other" },
        identity,
        creation,
      ).ok,
    ).toBe(false);
    expect(
      matchOwnershipLabels(
        buildOwnershipLabels(identity, creation),
        identity,
        projectCreateRequest({ image: "alpine:3.20", user: "root" }),
      ).ok,
    ).toBe(false);
  });

  it("matchOwnedCreation requires decoded native configuration, not only fingerprint", () => {
    const labels = buildOwnershipLabels(identity, creation);
    expect(
      matchOwnedCreation(
        {
          labels,
          image: "alpine:3.20",
          cpus: 1,
          memoryMiB: 512,
          tmpMiB: null,
          rootMiB: null,
          workdir: null,
          user: null,
          shell: null,
          hostname: null,
          maxDurationSecs: null,
          idleTimeoutSecs: null,
          env: {},
          network: defaultNetworkConfig(),
          secrets: [],
          volumes: [],
          mounts: [],
          bindMounts: [],
        },
        identity,
        creation,
      ).ok,
    ).toBe(true);
    expect(
      matchOwnedCreation(
        {
          labels,
          image: "alpine:3.20",
          cpus: 1,
          memoryMiB: 512,
          tmpMiB: null,
          rootMiB: null,
          workdir: null,
          user: null,
          shell: null,
          hostname: null,
          maxDurationSecs: null,
          idleTimeoutSecs: null,
          env: {
            PATH: "/usr/bin",
            DEBIAN_FRONTEND: "noninteractive",
          },
          network: defaultNetworkConfig(),
          secrets: [],
          volumes: [],
          mounts: [],
          bindMounts: [],
        },
        identity,
        creation,
      ).ok,
    ).toBe(true);
    expect(
      matchOwnedCreation(
        {
          labels,
          image: "wrong:latest",
          cpus: 1,
          memoryMiB: 512,
          tmpMiB: null,
          rootMiB: null,
          workdir: null,
          user: null,
          shell: null,
          hostname: null,
          maxDurationSecs: null,
          idleTimeoutSecs: null,
          env: {},
          network: defaultNetworkConfig(),
          secrets: [],
          volumes: [],
          mounts: [],
          bindMounts: [],
        },
        identity,
        creation,
      ).ok,
    ).toBe(false);
    expect(
      matchOwnershipLabels(
        buildOwnershipLabels(identity, creation),
        identity,
        projectCreateRequest({ image: "alpine:3.20", env: { A: "1" } }),
      ).ok,
    ).toBe(false);
  });

  it("detects partial reserved labels", () => {
    expect(hasPartialReservedLabels({ [OWNERSHIP_LABEL_KEYS.managed]: "true" })).toBe(true);
    expect(hasPartialReservedLabels(buildOwnershipLabels(identity, creation))).toBe(false);
    expect(hasPartialReservedLabels({})).toBe(false);
  });

  it("inspectOwnershipLabels extracts identity when complete", () => {
    const inspected = inspectOwnershipLabels(buildOwnershipLabels(identity, creation));
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.identity).toEqual(identity);
    }
  });
});
