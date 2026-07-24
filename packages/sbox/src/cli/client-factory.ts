/**
 * Shared helpers for CLI commands that need a configured client.
 */

import { createSboxClientFromYaml } from "../client/from-yaml.js";
import type { SboxClient } from "../client/client.js";
import type { CliContext } from "./context.js";

export async function openYamlClient(ctx: CliContext): Promise<SboxClient> {
  return createSboxClientFromYaml({
    cwd: ctx.io.cwd,
    env: ctx.io.env,
    ...(ctx.flags.configPath !== undefined ? { configPath: ctx.flags.configPath } : {}),
    ...(ctx.flags.userConfigPath !== undefined ? { userConfigPath: ctx.flags.userConfigPath } : {}),
    ...(ctx.io.homeDir !== undefined ? { homeDir: ctx.io.homeDir } : {}),
    ...(ctx.io.platform !== undefined
      ? { platform: ctx.io.platform as "linux" | "darwin" | "win32" }
      : {}),
    ...(ctx.host !== undefined ? { host: ctx.host, ownsHost: false } : {}),
    ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
  });
}
