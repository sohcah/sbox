import { selectProfile, resolveInstanceId } from "../../config/profile.js";
import { assertProjectId, assertSandboxIdentity } from "../../identity.js";
import type { ProfileOperationOptions } from "../../client/client.js";
import { openYamlClient } from "../client-factory.js";
import type { CliContext } from "../context.js";
import { writeResult } from "../context.js";
import { cliErrorResult, formatCliResult, type CliResult } from "../format.js";
import { EXIT_SUCCESS, exitCodeForError } from "../exit-codes.js";

function profileOptions(ctx: CliContext, profile?: string): ProfileOperationOptions {
  return {
    ...(profile !== undefined ? { profile } : {}),
    ...(ctx.flags.instance !== undefined ? { instance: ctx.flags.instance } : {}),
    ...(ctx.flags.target !== undefined ? { target: ctx.flags.target } : {}),
  };
}

export async function runUp(ctx: CliContext, profile?: string): Promise<number> {
  const command = "up";
  const client = await openYamlClient(ctx);
  try {
    const handle = await client.up(profileOptions(ctx, profile));
    const inspection = await handle.inspect();
    const result: CliResult = {
      ok: true,
      command,
      data: {
        project: inspection.identity.project,
        profile: inspection.identity.profile,
        instance: inspection.identity.instance,
        nativeName: inspection.nativeName,
        state: inspection.state,
        image: inspection.creation.image,
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

export async function runList(ctx: CliContext): Promise<number> {
  const command = "list";
  const client = await openYamlClient(ctx);
  try {
    const items = await client.list(profileOptions(ctx));
    const result: CliResult = {
      ok: true,
      command,
      data: items.map((item) => ({
        project: item.identity.project,
        profile: item.identity.profile,
        instance: item.identity.instance,
        nativeName: item.nativeName,
        state: item.state,
        image: item.image,
      })),
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

export async function runInspect(ctx: CliContext, profile: string): Promise<number> {
  const command = "inspect";
  const client = await openYamlClient(ctx);
  try {
    const inspection = await client.inspect(profileOptions(ctx, profile));
    const result: CliResult = {
      ok: true,
      command,
      data: {
        project: inspection.identity.project,
        profile: inspection.identity.profile,
        instance: inspection.identity.instance,
        nativeName: inspection.nativeName,
        state: inspection.state,
        creation: inspection.creation,
        labels: inspection.labels,
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

export async function runStop(ctx: CliContext, profile: string): Promise<number> {
  const command = "stop";
  const client = await openYamlClient(ctx);
  try {
    const inspection = await client.stop(profileOptions(ctx, profile));
    const result: CliResult = {
      ok: true,
      command,
      data: {
        project: inspection.identity.project,
        profile: inspection.identity.profile,
        instance: inspection.identity.instance,
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

export async function runRemove(ctx: CliContext, profile: string): Promise<number> {
  const command = "remove";
  const client = await openYamlClient(ctx);
  try {
    const options = profileOptions(ctx, profile);
    const selected = selectProfile(client.project, profile);
    const identity = assertSandboxIdentity({
      project: assertProjectId(client.project.project),
      profile: selected.name,
      instance: resolveInstanceId(selected.name, ctx.flags.instance),
    });
    await client.remove(options);
    const result: CliResult = {
      ok: true,
      command,
      data: {
        project: identity.project,
        profile: identity.profile,
        instance: identity.instance,
        removed: true,
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
