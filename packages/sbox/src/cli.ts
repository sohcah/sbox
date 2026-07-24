#!/usr/bin/env node
/**
 * CLI process entry. Thin adapter over the testable runner.
 */

import { homedir } from "node:os";
import { runCli } from "./cli/runner.js";

const code = await runCli({
  argv: process.argv.slice(2),
  io: {
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    env: process.env,
    homeDir: homedir(),
    platform: process.platform,
  },
});

process.exitCode = code;
