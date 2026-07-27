/**
 * Foreground `sbox serve` command.
 */

import { createLocalHost } from "../../local-host.js";
import { createSboxServer } from "../../remote/server.js";
import { SBOX_PROTOCOL_VERSION } from "../../remote/protocol.js";
import { SboxError } from "../../errors.js";
import { createRedactingLogger } from "../../logging.js";
import type { CliContext } from "../context.js";
import { writeResult } from "../context.js";
import { EXIT_SUCCESS } from "../exit-codes.js";
import { formatCliResult } from "../format.js";

/** Minimum bearer token length accepted by `sbox serve`. */
export const SERVE_TOKEN_MIN_LENGTH = 16;

export interface ServeOptions {
  readonly bind?: string;
  readonly port?: number;
  readonly tokenEnv?: string;
  readonly allowNonLoopback?: boolean;
}

export async function runServe(ctx: CliContext, options: ServeOptions = {}): Promise<number> {
  const tokenEnv = options.tokenEnv ?? "SBOX_SERVE_TOKEN";
  const token = ctx.io.env[tokenEnv];
  if (token === undefined || token.length === 0) {
    throw SboxError.validation(
      `Serve token environment variable ${JSON.stringify(tokenEnv)} is missing or empty.`,
      { details: { path: "token" } },
    );
  }
  if (token.length < SERVE_TOKEN_MIN_LENGTH) {
    throw SboxError.validation(
      `Serve token must be at least ${SERVE_TOKEN_MIN_LENGTH} characters.`,
      { details: { path: "token", minLength: SERVE_TOKEN_MIN_LENGTH } },
    );
  }

  const logger = ctx.logger !== undefined ? createRedactingLogger(ctx.logger) : undefined;
  const host = ctx.host ?? createLocalHost(logger !== undefined ? { logger } : {});
  await using server = await createSboxServer({
    host,
    bearerToken: token,
    ...(options.bind !== undefined ? { bind: options.bind } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.allowNonLoopback === true ? { allowNonLoopback: true } : {}),
    ...(logger !== undefined ? { logger } : {}),
  });

  writeResult(
    ctx,
    formatCliResult(
      {
        ok: true,
        command: "serve",
        data: {
          url: server.url,
          bind: server.bind,
          port: server.port,
          protocolVersion: SBOX_PROTOCOL_VERSION,
        },
      },
      ctx.format,
    ),
  );

  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return EXIT_SUCCESS;
}
