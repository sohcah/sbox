/**
 * Checked-in sample projects must validate as real project/user configs.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadProjectConfigFromYaml,
  loadUserConfigFromYaml,
  tryLoadProjectConfigFromYaml,
  tryLoadUserConfigFromYaml,
} from "../src/config/yaml.js";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("sample configurations", () => {
  it("validates samples/local project YAML", async () => {
    const text = await readFile(join(workspaceRoot, "samples/local/sbox.yaml"), "utf8");
    const attempt = tryLoadProjectConfigFromYaml(text);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) {
      return;
    }
    const project = attempt.value;
    expect(project.project).toBe("sample-local");
    expect(project.target).toBeUndefined();
    expect(project.volumes?.["cache"]).toBeDefined();
    expect(project.profiles["default"]?.network?.mode).toBe("default-deny");
    expect(text).not.toMatch(/^\s*targets\s*:/m);
    // Ensure the throwing loader agrees.
    expect(loadProjectConfigFromYaml(text).project).toBe("sample-local");
  });

  it("validates samples/remote project + user YAML together", async () => {
    const projectText = await readFile(join(workspaceRoot, "samples/remote/sbox.yaml"), "utf8");
    const userText = await readFile(join(workspaceRoot, "samples/remote/user-config.yaml"), "utf8");
    const projectAttempt = tryLoadProjectConfigFromYaml(projectText);
    const userAttempt = tryLoadUserConfigFromYaml(userText);
    expect(projectAttempt.ok).toBe(true);
    expect(userAttempt.ok).toBe(true);
    if (!projectAttempt.ok || !userAttempt.ok) {
      return;
    }
    expect(projectAttempt.value.target).toBe("lab");
    expect(userAttempt.value.targets["lab"]?.kind).toBe("remote");
    expect(projectText).not.toMatch(/^\s*targets\s*:/m);
    expect(projectText).not.toMatch(/selectTarget/);
    expect(loadUserConfigFromYaml(userText).defaultTarget).toBe("lab");
  });
});
