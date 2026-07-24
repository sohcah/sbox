import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 100,
  singleQuote: false,
  semi: true,
  // Design docs are hand-authored prose; keep formatting scoped to code and package manifests.
  ignorePatterns: ["docs/**/*.md", "**/dist/**", "pnpm-lock.yaml", "patches/**"],
});
