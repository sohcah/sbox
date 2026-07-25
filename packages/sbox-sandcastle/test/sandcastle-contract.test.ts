/**
 * Compile-time assignability of our factory to Sandcastle's provider config.
 * Runtime: wrap with createIsolatedSandboxProvider and create a handle.
 */

import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxProvider,
  type IsolatedSandboxProviderConfig,
} from "@ai-hero/sandcastle";
import { createSboxClient, parseProjectConfig, type SboxClient } from "@sohcah/sbox";
import { describe, expect, it } from "vitest";
import { createSboxSandcastleProvider } from "../src/index.js";
import { FakeHost } from "../../sbox/src/fake-host.js";

function project() {
  return parseProjectConfig({
    version: 1,
    project: "demo",
    defaultProfile: "default",
    profiles: {
      default: {
        image: "alpine:3.20",
        cpus: 1,
        memoryMiB: 512,
        shell: "/bin/sh",
      },
    },
  });
}

describe("Sandcastle IsolatedSandboxProviderConfig contract", () => {
  it("is assignable and usable via createIsolatedSandboxProvider", async () => {
    const host = new FakeHost();
    const client: SboxClient = createSboxClient({
      project: project(),
      host,
      ownsHost: false,
    });
    try {
      const config: IsolatedSandboxProviderConfig = createSboxSandcastleProvider({
        client,
        profile: "default",
        worktreePath: "/workspace",
        name: "sbox",
      });
      const provider: IsolatedSandboxProvider = createIsolatedSandboxProvider(config);
      expect(provider.name).toBe("sbox");

      const handle = await config.create({ env: { FOO: "bar" } });
      expect(handle.worktreePath).toBe("/workspace");
      expect(typeof handle.exec).toBe("function");
      expect(typeof handle.interactiveExec).toBe("function");
      expect(typeof handle.copyIn).toBe("function");
      expect(typeof handle.copyFileOut).toBe("function");
      expect(typeof handle.close).toBe("function");
      await handle.close();
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });
});
