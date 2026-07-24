import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findAcceptanceStatusLine,
  formatAcceptanceStatusLine,
  parseAcceptanceStatusLine,
} from "./helpers/acceptance-status.js";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("acceptance status line helpers", () => {
  it("formats and parses unambiguous status lines", () => {
    expect(formatAcceptanceStatusLine("passed")).toBe("sbox-acceptance-status: passed");
    expect(formatAcceptanceStatusLine("unavailable", "capability:image_unavailable")).toBe(
      "sbox-acceptance-status: unavailable capability:image_unavailable",
    );
    expect(
      parseAcceptanceStatusLine(
        findAcceptanceStatusLine(
          "noise\nsbox-acceptance-status: unavailable capability:image_unavailable\n",
        )!,
      ),
    ).toBe("unavailable");
  });
});

describe("pnpm test:acceptance CLI output", () => {
  it("reports unavailable unambiguously (skipped, not passed)", () => {
    const result = spawnSync("pnpm", ["test:acceptance"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: { ...process.env, SBOX_ACCEPTANCE_FORCE: "unavailable" },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(findAcceptanceStatusLine(output)).toMatch(/sbox-acceptance-status:\s*unavailable/);
    expect(output).toMatch(/Tests\s+1\s+skipped/);
    expect(output).not.toMatch(/Tests\s+1\s+passed/);
    expect(result.status).toBe(0);
  }, 60_000);

  it("reports passed unambiguously", () => {
    const result = spawnSync("pnpm", ["test:acceptance"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: { ...process.env, SBOX_ACCEPTANCE_FORCE: "passed" },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(findAcceptanceStatusLine(output)).toMatch(/sbox-acceptance-status:\s*passed/);
    expect(output).toMatch(/Test Files\s+1\s+passed/);
    expect(result.status).toBe(0);
  }, 60_000);
});
