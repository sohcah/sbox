/**
 * Repository audit: prove non-goal control-plane machinery is absent from
 * package sources and runtime dependencies.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const FORBIDDEN_DEPENDENCIES = [
  "better-sqlite3",
  "sqlite3",
  "sql.js",
  "prisma",
  "@prisma/client",
  "typeorm",
  "sequelize",
  "knex",
  "drizzle-orm",
  "chokidar",
  "node-cron",
  "bull",
  "bullmq",
  "agenda",
  "@sentry/node",
  "@opentelemetry/sdk-node",
  "posthog-node",
  "mixpanel",
] as const;

const FORBIDDEN_SOURCE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "sqlite import", regex: /\bfrom ["'](?:better-sqlite3|sqlite3|sql\.js)["']/ },
  { name: "prisma import", regex: /\bfrom ["']@?prisma/ },
  { name: "typeorm/knex/drizzle", regex: /\bfrom ["'](?:typeorm|knex|drizzle-orm)["']/ },
  { name: "chokidar watch", regex: /\bfrom ["']chokidar["']/ },
  { name: "cron/scheduler deps", regex: /\bfrom ["'](?:node-cron|bullmq?|agenda)["']/ },
  {
    name: "telemetry SDK",
    regex: /\bfrom ["'](?:@sentry\/node|@opentelemetry\/|posthog-node)["']/,
  },
  { name: "CREATE TABLE SQL", regex: /\bCREATE\s+TABLE\b/i },
  { name: "durable claim API", regex: /\b(?:durableClaim|workflowJournal|orphanReaper)\b/ },
  { name: "auto prune API", regex: /\b(?:autoPrune|pruneAll|garbageCollectImages)\b/ },
];

async function collectTsFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") {
          continue;
        }
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(path);
      }
    }
  }
  await walk(root);
  return out;
}

describe("repository audit", () => {
  it("keeps runtime dependencies free of control-plane / telemetry packages", async () => {
    for (const pkg of ["packages/sbox", "packages/sbox-sandcastle"]) {
      const manifest = JSON.parse(
        await readFile(join(workspaceRoot, pkg, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ];
      for (const forbidden of FORBIDDEN_DEPENDENCIES) {
        expect(names, `${pkg} must not depend on ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps package sources free of excluded control-plane patterns", async () => {
    const roots = [
      join(workspaceRoot, "packages/sbox/src"),
      join(workspaceRoot, "packages/sbox-sandcastle/src"),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      const files = await collectTsFiles(root);
      for (const file of files) {
        const text = await readFile(file, "utf8");
        for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
          if (pattern.regex.test(text)) {
            hits.push(`${file}: ${pattern.name}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
