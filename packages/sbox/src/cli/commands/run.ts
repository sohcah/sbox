/**
 * CLI `run`: create a unique sandbox, execute once, remove in `finally`.
 */

import { randomBytes } from "node:crypto";
import { assertInstanceId } from "../../identity.js";
import { openYamlClient } from "../client-factory.js";
import type { CliContext } from "../context.js";
import { writeErrorLine, writeResult } from "../context.js";
import { cliErrorResult, formatCliResult, type CliResult } from "../format.js";
import { EXIT_SUCCESS, exitCodeForError } from "../exit-codes.js";
import { selectProfile } from "../../config/profile.js";
import { utf8ToBytes } from "../../process/decode.js";
import type { ProcessEvent, ProcessResult, SandboxIdentity } from "../../types.js";
import { isSboxError, SboxError } from "../../errors.js";
import type { ProfileOperationOptions } from "../../client/client.js";

export interface RunCommandOptions {
  readonly profile?: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly user?: string;
  readonly stdin?: string;
  readonly stream?: boolean;
}

export async function runRun(ctx: CliContext, options: RunCommandOptions): Promise<number> {
  const command = "run";
  if (ctx.flags.instance !== undefined) {
    const error = SboxError.validation(
      "run always generates a unique instance; do not pass --instance.",
      { details: { path: "argv" } },
    );
    writeResult(ctx, formatCliResult(cliErrorResult(command, error), ctx.format));
    return exitCodeForError(error);
  }

  const client = await openYamlClient(ctx);
  let identity: SandboxIdentity | undefined;
  let primaryError: unknown;
  let exitCode = EXIT_SUCCESS;
  /** Collected JSON is deferred until after cleanup so exactly one object is emitted. */
  let deferredJson: CliResult | undefined;
  const deferCollectedJson = ctx.format === "json" && options.stream !== true;

  try {
    const instance = uniqueRunInstanceId();
    const createOptions: ProfileOperationOptions = {
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      instance,
      ...(ctx.flags.target !== undefined ? { target: ctx.flags.target } : {}),
    };
    const handle = await client.create(createOptions);
    identity = handle.identity;

    const selected = selectProfile(client.project, options.profile);
    const userOpt =
      options.user !== undefined
        ? { user: options.user }
        : selected.profile.user !== undefined
          ? { user: selected.profile.user }
          : {};
    const collectedOptions = {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...userOpt,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    };
    const streamOptions = {
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
      const session = await handle.execStream(options.argv, streamOptions);
      try {
        // Operational stream failures must propagate so finally can treat them as
        // primaryError (not a guest non-zero exit) when cleanup also fails.
        exitCode = await streamProcess(ctx, session);
      } finally {
        await session[Symbol.asyncDispose]();
      }
    } else {
      const result = await handle.exec(options.argv, collectedOptions);
      exitCode = result.exitCode;
      if (deferCollectedJson) {
        deferredJson = collectedSuccessResult(command, result);
      } else {
        emitCollectedText(ctx, result);
      }
    }
  } catch (error) {
    primaryError = error;
    exitCode = exitCodeForError(error);
    if (deferCollectedJson) {
      deferredJson = cliErrorResult(command, error);
    } else {
      writeResult(ctx, formatCliResult(cliErrorResult(command, error), ctx.format));
    }
  } finally {
    let cleanupEmittedJson = false;
    if (identity !== undefined) {
      try {
        await client.remove(identity);
      } catch (cleanupError) {
        const reported = reportCleanupFailure(ctx, command, {
          primaryError,
          exitCode,
          cleanupError,
        });
        exitCode = reported.exitCode;
        cleanupEmittedJson = reported.emittedJson;
      }
    }
    if (deferCollectedJson && !cleanupEmittedJson && deferredJson !== undefined) {
      writeResult(ctx, formatCliResult(deferredJson, "json"));
    }
    await client[Symbol.asyncDispose]();
  }

  return exitCode;
}

function uniqueRunInstanceId(): string {
  return assertInstanceId(`run-${randomBytes(8).toString("hex")}`);
}

function reportCleanupFailure(
  ctx: CliContext,
  command: string,
  state: {
    readonly primaryError: unknown;
    readonly exitCode: number;
    readonly cleanupError: unknown;
  },
): { readonly exitCode: number; readonly emittedJson: boolean } {
  if (state.primaryError !== undefined) {
    const wrapped = withCleanupFailure(state.primaryError, state.cleanupError);
    writeResult(ctx, formatCliResult(cliErrorResult(command, wrapped), ctx.format));
    return { exitCode: exitCodeForError(wrapped), emittedJson: ctx.format === "json" };
  }

  if (state.exitCode !== EXIT_SUCCESS) {
    const message =
      state.cleanupError instanceof Error
        ? state.cleanupError.message
        : "Sandbox cleanup failed after guest exit.";
    writeErrorLine(ctx, `run cleanup failed: ${message}`);
    if (ctx.format === "json") {
      writeResult(
        ctx,
        formatCliResult(
          {
            ok: false,
            command,
            error: {
              code: isSboxError(state.cleanupError) ? state.cleanupError.code : "internal",
              message,
              details: {
                cleanupFailed: true,
                guestExitCode: state.exitCode,
                ...cleanupErrorDetails(state.cleanupError),
              },
            },
          },
          "json",
        ),
      );
      return { exitCode: state.exitCode, emittedJson: true };
    }
    return { exitCode: state.exitCode, emittedJson: false };
  }

  // Guest succeeded; emit cleanup failure as the sole collected JSON result.
  const message =
    state.cleanupError instanceof Error ? state.cleanupError.message : "Sandbox cleanup failed.";
  if (ctx.format === "json") {
    writeResult(
      ctx,
      formatCliResult(
        {
          ok: false,
          command,
          error: {
            code: isSboxError(state.cleanupError) ? state.cleanupError.code : "internal",
            message,
            details: {
              cleanupFailed: true,
              ...cleanupErrorDetails(state.cleanupError),
            },
          },
        },
        "json",
      ),
    );
    return { exitCode: exitCodeForError(state.cleanupError), emittedJson: true };
  }
  writeResult(ctx, formatCliResult(cliErrorResult(command, state.cleanupError), "text"));
  return { exitCode: exitCodeForError(state.cleanupError), emittedJson: false };
}

function withCleanupFailure(primary: unknown, cleanupError: unknown): SboxError {
  const base = isSboxError(primary)
    ? primary
    : SboxError.internal("run failed.", { cause: primary });
  return new SboxError(base.code, base.message, {
    cause: base,
    details: {
      ...base.details,
      cleanupFailed: true,
      ...cleanupErrorDetails(cleanupError),
    },
  });
}

function cleanupErrorDetails(cleanupError: unknown): Readonly<Record<string, unknown>> {
  return {
    cleanupCode: isSboxError(cleanupError) ? cleanupError.code : "internal",
    cleanupMessage:
      cleanupError instanceof Error ? cleanupError.message : "Sandbox cleanup failed.",
  };
}

function collectedSuccessResult(command: string, result: ProcessResult): CliResult {
  return {
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
}

function emitCollectedText(ctx: CliContext, result: ProcessResult): void {
  if (result.stdout.byteLength > 0) {
    ctx.io.stdout.write(Buffer.from(result.stdout));
  }
  if (result.stderr.byteLength > 0) {
    ctx.io.stderr.write(Buffer.from(result.stderr));
  }
}

/**
 * Drain a streaming session. Guest exit codes are returned; operational
 * failures are rethrown for the caller to record as primaryError.
 */
async function streamProcess(
  ctx: CliContext,
  session: AsyncIterable<ProcessEvent> & {
    wait(): Promise<{ exitCode: number; signal: string | null }>;
  },
): Promise<number> {
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
