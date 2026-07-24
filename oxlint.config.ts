import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
    suspicious: "warn",
    pedantic: "off",
    style: "off",
    restriction: "off",
  },
  ignorePatterns: ["**/dist/**", "**/node_modules/**", "patches/**"],
});
