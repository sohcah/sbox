import { describe, expect, it } from "vitest";
import { formatRemoteUrlCheckDetail } from "../src/cli/commands/doctor.js";

describe("formatRemoteUrlCheckDetail", () => {
  it("warns only for cleartext non-loopback HTTP", () => {
    expect(formatRemoteUrlCheckDetail("http://example.com:8080")).toContain(
      "non-loopback HTTP is unencrypted",
    );
    expect(formatRemoteUrlCheckDetail("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(formatRemoteUrlCheckDetail("https://example.com")).toBe("https://example.com");
    expect(formatRemoteUrlCheckDetail("https://example.com:8443/v1")).toBe(
      "https://example.com:8443/v1",
    );
  });
});
