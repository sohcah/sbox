/**
 * CLI: sbox build / sbox image list|remove
 */

import type { HostImageSummary, ImageBuildProgressEvent } from "../../image/types.js";
import { SboxError } from "../../errors.js";
import type { CliContext } from "../context.js";
import { writeResult } from "../context.js";
import { EXIT_SUCCESS, exitCodeForError } from "../exit-codes.js";
import { cliErrorResult, formatCliResult, type CliResult } from "../format.js";
import { openYamlClient } from "../client-factory.js";

export async function runBuild(
  ctx: CliContext,
  args: { readonly profile?: string; readonly force?: boolean },
): Promise<number> {
  const command = "build";
  const client = await openYamlClient(ctx);
  try {
    const progress: string[] = [];
    const image = await client.build({
      ...(args.profile !== undefined ? { profile: args.profile } : {}),
      ...(ctx.flags.target !== undefined ? { target: ctx.flags.target } : {}),
      ...(args.force === true ? { force: true } : {}),
      onProgress: (event: ImageBuildProgressEvent) => {
        if (event.type !== "phase") {
          return;
        }
        progress.push(event.phase);
        // Live phase-only progress on stderr; final machine-readable result on stdout.
        if (ctx.format === "json") {
          ctx.io.stderr.write(
            `${JSON.stringify({
              ok: true,
              command,
              type: "progress",
              phase: event.phase,
              ...(event.reference !== undefined ? { reference: event.reference } : {}),
            })}\n`,
          );
        } else {
          ctx.io.stderr.write(
            event.reference !== undefined
              ? `phase ${event.phase} ${event.reference}\n`
              : `phase ${event.phase}\n`,
          );
        }
      },
    });
    const result: CliResult = {
      ok: true,
      command,
      data: {
        reference: image.reference,
        contentIdentity: image.contentIdentity,
        algorithmVersion: image.algorithmVersion,
        reused: image.reused,
        built: image.built,
        phases: progress,
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

export async function runImageList(ctx: CliContext): Promise<number> {
  const command = "image list";
  const client = await openYamlClient(ctx);
  try {
    const images = await client.listImages(
      ctx.flags.target !== undefined ? { target: ctx.flags.target } : {},
    );
    const result: CliResult = {
      ok: true,
      command,
      data: {
        images: images.map((image: HostImageSummary) => ({
          reference: image.reference,
          contentIdentity: image.contentIdentity,
          algorithmVersion: image.algorithmVersion,
          owned: image.owned,
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

export async function runImageRemove(
  ctx: CliContext,
  args: { readonly reference?: string; readonly force?: boolean },
): Promise<number> {
  const command = "image remove";
  const client = await openYamlClient(ctx);
  try {
    if (args.reference === undefined || args.reference.length === 0) {
      throw SboxError.validation("image remove requires an exact image reference.", {
        details: { path: "argv" },
      });
    }
    await client.removeImage(args.reference, {
      ...(ctx.flags.target !== undefined ? { target: ctx.flags.target } : {}),
      ...(args.force === true ? { force: true } : {}),
    });
    const result: CliResult = {
      ok: true,
      command,
      data: { reference: args.reference, removed: true },
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
