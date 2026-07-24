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
        },
      },
      {
        test: {
          name: "acceptance",
          include: ["packages/*/test/**/*.acceptance.test.ts"],
          environment: "node",
          pool: "forks",
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
