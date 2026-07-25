/**
 * Testable CLI runner. Never calls process.exit or touches global console.
 */

import { parseArgs } from "node:util";
import { SboxError } from "../errors.js";
import type { Host } from "../host.js";
import type { Logger } from "../logging.js";
import { runConfigShow, runConfigValidate } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runExec, runShell } from "./commands/exec-shell.js";
import { runBuild, runImageList, runImageRemove } from "./commands/image.js";
import { runInit } from "./commands/init.js";
import { runInspect, runList, runRemove, runStop, runUp } from "./commands/lifecycle.js";
import { runServe } from "./commands/serve.js";
import { runVolumeList, runVolumeRemove, runVolumeShell } from "./commands/volume.js";
import type { CliContext, CliGlobalFlags, CliIo } from "./context.js";
import { writeResult } from "./context.js";
import { EXIT_SUCCESS, EXIT_VALIDATION, exitCodeForError } from "./exit-codes.js";
import { cliErrorResult, formatCliResult } from "./format.js";

export interface RunCliOptions {
  readonly argv: readonly string[];
  readonly io: CliIo;
  readonly host?: Host;
  readonly logger?: Logger;
}

const HELP = `sbox — configuration and lifecycle CLI for Microsandbox

Usage:
  sbox init [--force] [--project <slug>]
  sbox config validate
  sbox config show
  sbox doctor
  sbox serve [--bind <addr>] [--port <n>] [--token-env <name>] [--allow-non-loopback]
  sbox build [profile] [--force]
  sbox up [profile]
  sbox list
  sbox inspect <profile>
  sbox stop <profile>
  sbox remove <profile>
  sbox image list
  sbox image remove <exact-image> [--force]
  sbox volume list
  sbox volume shell <profile> <volume>
  sbox volume remove <volume>
  sbox exec [profile] [--cwd <path>] [--user <name>] [--stream] -- <argv...>
  sbox shell [profile] [--cwd <path>] [--user <name>] [--stream] -- <script>

Global flags:
  --json                 Emit JSON (single object, or NDJSON events with --stream)
  --config <path>        Explicit project sbox.yaml path
  --user-config <path>   Explicit user config path
  --target <name>        Explicit target name
  --instance <slug>      Explicit portable instance identity
  -h, --help             Show help

Exit codes:
  0 success / guest exit code for exec and shell
  1 operational failure
  2 validation / configuration error
  3 ownership conflict or creation drift
  4 not found
  5 already exists
  130 cancellation
`;

export async function runCli(options: RunCliOptions): Promise<number> {
  const argv = [...options.argv];
  const separator = argv.indexOf("--");
  const beforeSep = separator >= 0 ? argv.slice(0, separator) : argv;
  const afterSep = separator >= 0 ? argv.slice(separator + 1) : [];

  let values: ReturnType<typeof parseArgs>["values"];
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: beforeSep,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        config: { type: "string" },
        "user-config": { type: "string" },
        target: { type: "string" },
        instance: { type: "string" },
        force: { type: "boolean", default: false },
        project: { type: "string" },
        cwd: { type: "string" },
        user: { type: "string" },
        stream: { type: "boolean", default: false },
        bind: { type: "string" },
        port: { type: "string" },
        "token-env": { type: "string" },
        "allow-non-loopback": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid arguments.";
    const result = cliErrorResult(
      "sbox",
      SboxError.validation(message, { details: { path: "argv" } }),
    );
    const format = argv.includes("--json") ? "json" : "text";
    writeResult(
      {
        io: options.io,
        format,
        flags: { json: format === "json" },
      },
      formatCliResult(result, format),
    );
    return EXIT_VALIDATION;
  }

  const flags: CliGlobalFlags = {
    json: values["json"] === true,
    ...(typeof values["config"] === "string" ? { configPath: values["config"] } : {}),
    ...(typeof values["user-config"] === "string" ? { userConfigPath: values["user-config"] } : {}),
    ...(typeof values["target"] === "string" ? { target: values["target"] } : {}),
    ...(typeof values["instance"] === "string" ? { instance: values["instance"] } : {}),
  };

  const ctx: CliContext = {
    io: options.io,
    format: flags.json ? "json" : "text",
    flags,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  if (values["help"] === true || positionals.length === 0) {
    writeResult(ctx, HELP);
    return EXIT_SUCCESS;
  }

  const [command, ...rest] = positionals;
  try {
    switch (command) {
      case "init":
        return await runInit(ctx, {
          force: values["force"] === true,
          ...(typeof values["project"] === "string" ? { project: values["project"] } : {}),
        });
      case "config": {
        const sub = rest[0];
        if (sub === "validate") {
          return await runConfigValidate(ctx);
        }
        if (sub === "show") {
          return await runConfigShow(ctx);
        }
        throw SboxError.validation('Expected "config validate" or "config show".', {
          details: { path: "argv" },
        });
      }
      case "doctor":
        return await runDoctor(ctx);
      case "serve": {
        const portRaw = values["port"];
        return await runServe(ctx, {
          ...(typeof values["bind"] === "string" ? { bind: values["bind"] } : {}),
          ...(typeof portRaw === "string" ? { port: Number(portRaw) } : {}),
          ...(typeof values["token-env"] === "string" ? { tokenEnv: values["token-env"] } : {}),
          ...(values["allow-non-loopback"] === true ? { allowNonLoopback: true } : {}),
        });
      }
      case "up":
        return await runUp(ctx, rest[0]);
      case "build":
        return await runBuild(ctx, {
          ...(rest[0] !== undefined ? { profile: rest[0] } : {}),
          force: values["force"] === true,
        });
      case "image": {
        const sub = rest[0];
        if (sub === "list") {
          return await runImageList(ctx);
        }
        if (sub === "remove") {
          return await runImageRemove(ctx, {
            ...(rest[1] !== undefined ? { reference: rest[1] } : {}),
            force: values["force"] === true,
          });
        }
        throw SboxError.validation('Expected "image list" or "image remove <exact-image>".', {
          details: { path: "argv" },
        });
      }
      case "volume": {
        const sub = rest[0];
        if (sub === "list") {
          return await runVolumeList(ctx);
        }
        if (sub === "shell") {
          const profile = rest[1];
          const volume = rest[2];
          if (profile === undefined || volume === undefined) {
            throw SboxError.validation('Expected "volume shell <profile> <volume>".', {
              details: { path: "argv" },
            });
          }
          return await runVolumeShell(ctx, { profile, volume });
        }
        if (sub === "remove") {
          const volume = rest[1];
          if (volume === undefined) {
            throw SboxError.validation('Expected "volume remove <volume>".', {
              details: { path: "argv" },
            });
          }
          return await runVolumeRemove(ctx, { volume });
        }
        throw SboxError.validation(
          'Expected "volume list", "volume shell <profile> <volume>", or "volume remove <volume>".',
          { details: { path: "argv" } },
        );
      }
      case "list":
        return await runList(ctx);
      case "inspect": {
        const profile = rest[0];
        if (profile === undefined) {
          throw SboxError.validation("inspect requires a profile name.", {
            details: { path: "argv" },
          });
        }
        return await runInspect(ctx, profile);
      }
      case "stop": {
        const profile = rest[0];
        if (profile === undefined) {
          throw SboxError.validation("stop requires a profile name.", {
            details: { path: "argv" },
          });
        }
        return await runStop(ctx, profile);
      }
      case "remove": {
        const profile = rest[0];
        if (profile === undefined) {
          throw SboxError.validation("remove requires a profile name.", {
            details: { path: "argv" },
          });
        }
        return await runRemove(ctx, profile);
      }
      case "exec": {
        if (afterSep.length === 0) {
          throw SboxError.validation("exec requires `-- <argv...>`.", {
            details: { path: "argv" },
          });
        }
        return await runExec(ctx, {
          ...(rest[0] !== undefined ? { profile: rest[0] } : {}),
          argv: afterSep,
          ...(typeof values["cwd"] === "string" ? { cwd: values["cwd"] } : {}),
          ...(typeof values["user"] === "string" ? { user: values["user"] } : {}),
          stream: values["stream"] === true,
        });
      }
      case "shell": {
        if (afterSep.length === 0) {
          throw SboxError.validation("shell requires `-- <script>`.", {
            details: { path: "argv" },
          });
        }
        return await runShell(ctx, {
          ...(rest[0] !== undefined ? { profile: rest[0] } : {}),
          script: afterSep.join(" "),
          ...(typeof values["cwd"] === "string" ? { cwd: values["cwd"] } : {}),
          ...(typeof values["user"] === "string" ? { user: values["user"] } : {}),
          stream: values["stream"] === true,
        });
      }
      default:
        throw SboxError.validation(`Unknown command ${JSON.stringify(command)}.`, {
          details: { path: "argv" },
        });
    }
  } catch (error) {
    writeResult(ctx, formatCliResult(cliErrorResult(command ?? "sbox", error), ctx.format));
    return exitCodeForError(error);
  }
}
