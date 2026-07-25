#!/usr/bin/env node
/**
 * CLI process entry. Thin adapter over the testable runner.
 */

import { homedir } from "node:os";
import { runCli } from "./cli/runner.js";

const code = await runCli({
  argv: process.argv.slice(2),
  io: {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    terminalSize: () => ({
      rows: process.stdout.rows ?? 24,
      cols: process.stdout.columns ?? 80,
    }),
    onTerminalResize: (listener) => {
      process.stdout.on("resize", listener);
      return () => process.stdout.off("resize", listener);
    },
    enterRawMode: () => {
      const wasRaw = process.stdin.isRaw;
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      return () => {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(wasRaw);
        }
      };
    },
    stopStdin: () => {
      process.stdin.pause();
    },
    cwd: process.cwd(),
    env: process.env,
    homeDir: homedir(),
    platform: process.platform,
  },
});

process.exitCode = code;
