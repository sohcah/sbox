/**
 * CLI `exec` and `shell` commands.
 */

import { openYamlClient } from "../client-factory.js";
import type { CliContext } from "../context.js";
import { writeErrorLine, writeResult } from "../context.js";
import { cliErrorResult, formatCliResult, type CliResult } from "../format.js";
import { exitCodeForError } from "../exit-codes.js";
import { selectProfile } from "../../config/profile.js";
import { bytesToUtf8, utf8ToBytes } from "../../process/decode.js";
import type { ProcessEvent, ProcessResult } from "../../types.js";
import { isSboxError } from "../../errors.js";

export interface ExecCommandOptions {
  readonly profile?: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly user?: string;
  readonly stdin?: string;
  readonly stream?: boolean;
}

export interface ShellCommandOptions {
  readonly profile?: string;
  readonly script: string;
  readonly cwd?: string;
  readonly user?: string;
  readonly stdin?: string;
  readonly stream?: boolean;
}

export async function runExec(ctx: CliContext, options: ExecCommandOptions): Promise<number> {
  const command = "exec";
  const client = await openYamlClient(ctx);
  try {
    const handle = await client.get({
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(ctx.flags.instance !== undefined ? { instance: ctx.flags.instance } : {}),
      ...(ctx.flags.target !== undefined ? { target: ctx.flags.target } : {}),
    });
    const selected = selectProfile(client.project, options.profile);
    const collectedOptions = {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.user !== undefined
        ? { user: options.user }
        : selected.profile.user !== undefined
          ? { user: selected.profile.user }
          : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    };
    const streamOptions = {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.user !== undefined
        ? { user: options.user }
        : selected.profile.user !== undefined
          ? { user: selected.profile.user }
          : {}),
      ...(options.stdin !== undefined
        ? {
            stdin: (async function* () {
              yield utf8ToBytes(options.stdin!);
            })(),
          }
        : {}),
    };

    if (options.stream) {
      const session = await handle.execStream(options.argv, streamOptions);
      try {
        return await streamProcess(ctx, command, session);
      } finally {
        await session[Symbol.asyncDispose]();
      }
    }

    const result = await handle.exec(options.argv, collectedOptions);
    return emitCollected(ctx, command, result);
  } catch (error) {
    writeResult(ctx, formatCliResult(cliErrorResult(command, error), ctx.format));
    return exitCodeForError(error);
  } finally {
    await client[Symbol.asyncDispose]();
  }
}

export async function runShell(ctx: CliContext, options: ShellCommandOptions): Promise<number> {
  const command = "shell";
  const client = await openYamlClient(ctx);
  try {
    const handle = await client.get({
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(ctx.flags.instance !== undefined ? { instance: ctx.flags.instance } : {}),
      ...(ctx.flags.target !== undefined ? { target: ctx.flags.target } : {}),
    });
    const selected = selectProfile(client.project, options.profile);
    const shellPath = selected.profile.shell ?? "/bin/sh";
    const userOpt =
      options.user !== undefined
        ? { user: options.user }
        : selected.profile.user !== undefined
          ? { user: selected.profile.user }
          : {};
    const collectedOptions = {
      shell: shellPath,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...userOpt,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    };
    const streamOptions = {
      shell: shellPath,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...userOpt,
      ...(options.stdin !== undefined
        ? {
            stdin: (async function* () {
              yield utf8ToBytes(options.stdin!);
            })(),
          }
        : {}),
    };

    if (options.stream) {
      const session = await handle.shellStream(options.script, streamOptions);
      try {
        return await streamProcess(ctx, command, session);
      } finally {
        await session[Symbol.asyncDispose]();
      }
    }

    const result = await handle.shell(options.script, collectedOptions);
    return emitCollected(ctx, command, result);
  } catch (error) {
    writeResult(ctx, formatCliResult(cliErrorResult(command, error), ctx.format));
    return exitCodeForError(error);
  } finally {
    await client[Symbol.asyncDispose]();
  }
}

function emitCollected(ctx: CliContext, command: string, result: ProcessResult): number {
  if (ctx.format === "json") {
    const payload: CliResult = {
      ok: true,
      command,
      data: {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: Buffer.from(result.stdout).toString("base64"),
        stderr: Buffer.from(result.stderr).toString("base64"),
        stdoutEncoding: "base64",
        stderrEncoding: "base64",
      },
    };
    writeResult(ctx, formatCliResult(payload, "json"));
  } else {
    if (result.stdout.byteLength > 0) {
      ctx.io.stdout.write(bytesToUtf8(result.stdout));
    }
    if (result.stderr.byteLength > 0) {
      ctx.io.stderr.write(bytesToUtf8(result.stderr));
    }
  }
  return result.exitCode;
}

async function streamProcess(
  ctx: CliContext,
  command: string,
  session: AsyncIterable<ProcessEvent> & {
    wait(): Promise<{ exitCode: number; signal: string | null }>;
  },
): Promise<number> {
  try {
    for await (const event of session) {
      if (ctx.format === "json") {
        writeResult(ctx, `${JSON.stringify(serializeEvent(event))}\n`);
      } else if (event.type === "stdout") {
        ctx.io.stdout.write(Buffer.from(event.data));
      } else if (event.type === "stderr") {
        ctx.io.stderr.write(Buffer.from(event.data));
      }
    }
    const exit = await session.wait();
    return exit.exitCode;
  } catch (error) {
    if (ctx.format === "json") {
      writeResult(ctx, formatCliResult(cliErrorResult(command, error), "json"));
    } else if (isSboxError(error)) {
      writeErrorLine(ctx, `error(${error.code}): ${error.message}`);
    } else {
      writeErrorLine(ctx, error instanceof Error ? error.message : "Command failed.");
    }
    return exitCodeForError(error);
  }
}

function serializeEvent(event: ProcessEvent): unknown {
  switch (event.type) {
    case "started":
      return { type: "started", ...(event.pid !== undefined ? { pid: event.pid } : {}) };
    case "stdout":
      return {
        type: "stdout",
        data: Buffer.from(event.data).toString("base64"),
        encoding: "base64",
      };
    case "stderr":
      return {
        type: "stderr",
        data: Buffer.from(event.data).toString("base64"),
        encoding: "base64",
      };
    case "exited":
      return { type: "exited", exitCode: event.exitCode, signal: event.signal };
  }
}
