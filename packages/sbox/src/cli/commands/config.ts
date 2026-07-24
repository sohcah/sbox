import { toSafeProjectConfig, toSafeUserConfig } from "../../config/validate.js";
import { discoverProjectConfig, discoverUserConfig } from "../../config/discovery.js";
import type { CliContext } from "../context.js";
import { writeResult } from "../context.js";
import { cliErrorResult, formatCliResult, type CliResult } from "../format.js";
import { EXIT_SUCCESS, exitCodeForError } from "../exit-codes.js";

export async function runConfigValidate(ctx: CliContext): Promise<number> {
  const command = "config validate";
  try {
    const project = await discoverProjectConfig({
      cwd: ctx.io.cwd,
      env: ctx.io.env,
      ...(ctx.flags.configPath !== undefined ? { configPath: ctx.flags.configPath } : {}),
      ...(ctx.io.homeDir !== undefined ? { homeDir: ctx.io.homeDir } : {}),
      ...(ctx.io.platform !== undefined
        ? { platform: ctx.io.platform as "linux" | "darwin" | "win32" }
        : {}),
    });
    const user = await discoverUserConfig({
      cwd: ctx.io.cwd,
      env: ctx.io.env,
      ...(ctx.flags.userConfigPath !== undefined
        ? { userConfigPath: ctx.flags.userConfigPath }
        : {}),
      ...(ctx.io.homeDir !== undefined ? { homeDir: ctx.io.homeDir } : {}),
      ...(ctx.io.platform !== undefined
        ? { platform: ctx.io.platform as "linux" | "darwin" | "win32" }
        : {}),
    });
    const result: CliResult = {
      ok: true,
      command,
      data: {
        projectPath: project.path,
        userPath: user.path ?? null,
        project: project.value.project,
        profiles: Object.keys(project.value.profiles),
      },
    };
    writeResult(ctx, formatCliResult(result, ctx.format));
    return EXIT_SUCCESS;
  } catch (error) {
    writeResult(ctx, formatCliResult(cliErrorResult(command, error), ctx.format));
    return exitCodeForError(error);
  }
}

export async function runConfigShow(ctx: CliContext): Promise<number> {
  const command = "config show";
  try {
    const project = await discoverProjectConfig({
      cwd: ctx.io.cwd,
      env: ctx.io.env,
      ...(ctx.flags.configPath !== undefined ? { configPath: ctx.flags.configPath } : {}),
      ...(ctx.io.homeDir !== undefined ? { homeDir: ctx.io.homeDir } : {}),
      ...(ctx.io.platform !== undefined
        ? { platform: ctx.io.platform as "linux" | "darwin" | "win32" }
        : {}),
    });
    const user = await discoverUserConfig({
      cwd: ctx.io.cwd,
      env: ctx.io.env,
      ...(ctx.flags.userConfigPath !== undefined
        ? { userConfigPath: ctx.flags.userConfigPath }
        : {}),
      ...(ctx.io.homeDir !== undefined ? { homeDir: ctx.io.homeDir } : {}),
      ...(ctx.io.platform !== undefined
        ? { platform: ctx.io.platform as "linux" | "darwin" | "win32" }
        : {}),
    });
    const result: CliResult = {
      ok: true,
      command,
      data: {
        projectPath: project.path,
        userPath: user.path ?? null,
        project: toSafeProjectConfig(project.value),
        user: toSafeUserConfig(user.value),
      },
    };
    writeResult(ctx, formatCliResult(result, ctx.format));
    return EXIT_SUCCESS;
  } catch (error) {
    writeResult(ctx, formatCliResult(cliErrorResult(command, error), ctx.format));
    return exitCodeForError(error);
  }
}
