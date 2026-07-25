import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: ["**/*.acceptance.test.ts"],
          environment: "node",
          pool: "forks",
          // Never auto-retry: a flake must fail once with a named test in the report.
          retry: 0,
        },
      },
      {
        test: {
          name: "acceptance",
          include: ["packages/*/test/**/*.acceptance.test.ts"],
          environment: "node",
          pool: "forks",
          retry: 0,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
