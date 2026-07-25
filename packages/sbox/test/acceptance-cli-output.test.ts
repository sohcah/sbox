import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
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
    expect(
      findAcceptanceStatusLine(
        "\u001b[2mstdout | acceptance\u001b[22m\n\u001b[32msbox-acceptance-status: passed\u001b[39m\n",
      ),
    ).toBe("sbox-acceptance-status: passed");
  });
});

describe("pnpm test:acceptance CLI output", () => {
  it("reports unavailable unambiguously (skipped, not passed)", () => {
    const result = spawnAcceptance("unavailable");
    const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
    expect(findAcceptanceStatusLine(output)).toMatch(/sbox-acceptance-status:\s*unavailable/);
    expect(output).toMatch(/Tests\s+10\s+skipped/);
    expect(output).not.toMatch(/Tests\s+\d+\s+passed/);
    expect(result.status).toBe(0);
  }, 60_000);

  it("reports passed unambiguously", () => {
    const result = spawnAcceptance("passed");
    const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
    expect(findAcceptanceStatusLine(output)).toMatch(/sbox-acceptance-status:\s*passed/);
    expect(output).toMatch(/Test Files\s+9\s+passed/);
    expect(result.status).toBe(0);
  }, 60_000);
});

function spawnAcceptance(forced: "unavailable" | "passed") {
  const result = spawnSync("pnpm", ["test:acceptance", "--maxWorkers=1"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, SBOX_ACCEPTANCE_FORCE: forced },
    maxBuffer: 10 * 1024 * 1024,
  });
  expect(result.error, `acceptance subprocess failed: ${String(result.error)}`).toBeUndefined();
  expect(result.stdout).toBeTypeOf("string");
  expect(result.stderr).toBeTypeOf("string");
  return result as typeof result & { stdout: string; stderr: string };
}
