import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Absolute `file:` URL for a path under `packageRoot`.
 * Required for ESM `import` on Windows (drive paths are not valid URL schemes).
 */
export function packageModuleUrl(packageRoot: string, ...segments: string[]): string {
  return pathToFileURL(join(packageRoot, ...segments)).href;
}
