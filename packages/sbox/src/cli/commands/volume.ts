/**
 * CLI: sbox volume list|shell|remove
 */

import { SboxError } from "../../errors.js";
import type { CliContext } from "../context.js";
import { writeResult } from "../context.js";
import { EXIT_SUCCESS, exitCodeForError } from "../exit-codes.js";
import { cliErrorResult, formatCliResult, type CliResult } from "../format.js";
import { openYamlClient } from "../client-factory.js";

export async function runVolumeList(ctx: CliContext): Promise<number> {
  const command = "volume list";
  const client = await openYamlClient(ctx);
  try {
    const volumes = await client.listVolumes(
      ctx.flags.target !== undefined ? { target: ctx.flags.target } : {},
    );
    const result: CliResult = {
      ok: true,
      command,
      data: {
        volumes: volumes.map((volume) => ({
          volume: volume.volume,
          sizeBytes: volume.sizeBytes,
          basePath: volume.basePath,
          descendantCount: volume.descendantCount,
        })),
      },
    };
    writeResult(ctx, formatCliResult(result, ctx.format));
    return EXIT_SUCCESS;
  } catch (error) {
    writeResult(ctx, formatCliResult(cliErrorResult(command, error), ctx.format));
    return exitCodeForError(error);
  } finally {
    await client[Symbol.asyncDispose]();
  }
}

export async function runVolumeShell(
  ctx: CliContext,
  args: { readonly profile?: string; readonly volume: string },
): Promise<number> {
  const command = "volume shell";
  const client = await openYamlClient(ctx);
  try {
    const handle = await client.volumeShell(args.volume, {
      ...(args.profile !== undefined ? { profile: args.profile } : {}),
      ...(ctx.flags.target !== undefined ? { target: ctx.flags.target } : {}),
    });
    const inspection = await handle.inspect();
    const result: CliResult = {
      ok: true,
      command,
      data: {
        volume: args.volume,
        identity: inspection.identity,
        nativeName: inspection.nativeName,
        state: inspection.state,
      },
    };
    writeResult(ctx, formatCliResult(result, ctx.format));
    return EXIT_SUCCESS;
  } catch (error) {
    writeResult(ctx, formatCliResult(cliErrorResult(command, error), ctx.format));
    return exitCodeForError(error);
  } finally {
    await client[Symbol.asyncDispose]();
  }
}

export async function runVolumeRemove(
  ctx: CliContext,
  args: { readonly volume: string },
): Promise<number> {
  const command = "volume remove";
  if (args.volume.trim().length === 0) {
    writeResult(
      ctx,
      formatCliResult(
        cliErrorResult(command, SboxError.validation("Volume name is required.")),
        ctx.format,
      ),
    );
    return exitCodeForError(SboxError.validation("Volume name is required."));
  }
  const client = await openYamlClient(ctx);
  try {
    await client.removeVolume(
      args.volume,
      ctx.flags.target !== undefined ? { target: ctx.flags.target } : {},
    );
    const result: CliResult = {
      ok: true,
      command,
      data: { volume: args.volume },
    };
    writeResult(ctx, formatCliResult(result, ctx.format));
    return EXIT_SUCCESS;
  } catch (error) {
    writeResult(ctx, formatCliResult(cliErrorResult(command, error), ctx.format));
    return exitCodeForError(error);
  } finally {
    await client[Symbol.asyncDispose]();
  }
}
