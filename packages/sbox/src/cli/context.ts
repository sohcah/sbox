/**
 * CLI context shared by commands. No process.exit or global console coupling.
 */

import type { Host } from "../host.js";
import type { Logger } from "../logging.js";
import type { CliOutputFormat } from "./format.js";

export interface CliIo {
  readonly stdin?: AsyncIterable<string | Uint8Array>;
  readonly stdout: { write(chunk: string | Uint8Array): void };
  readonly stderr: { write(chunk: string | Uint8Array): void };
  readonly terminalSize?: () => { readonly rows: number; readonly cols: number };
  readonly onTerminalResize?: (listener: () => void) => () => void;
  readonly enterRawMode?: () => () => void;
  readonly stopStdin?: () => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

export interface CliGlobalFlags {
  readonly json: boolean;
  readonly configPath?: string;
  readonly userConfigPath?: string;
  readonly target?: string;
  readonly instance?: string;
}

export interface CliContext {
  readonly io: CliIo;
  readonly format: CliOutputFormat;
  readonly flags: CliGlobalFlags;
  readonly host?: Host;
  readonly logger?: Logger;
}

export function writeResult(ctx: CliContext, text: string): void {
  ctx.io.stdout.write(text);
}

export function writeErrorLine(ctx: CliContext, text: string): void {
  ctx.io.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}
