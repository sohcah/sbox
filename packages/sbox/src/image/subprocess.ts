/**
 * Exact-argv subprocess runner for Docker / msb with cancellation and timeout.
 *
 * Full stream retention is opt-in and bounded. Image builds should not retain
 * Docker output in memory.
 */

import { spawn } from "node:child_process";
import { SboxError, throwIfAborted } from "../errors.js";

/** Default cap when retainOutput is enabled. */
export const DEFAULT_SUBPROCESS_RETAIN_BYTES = 64 * 1024;

export interface RunExactCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onStdoutLine?: (line: string) => void;
  readonly onStderrLine?: (line: string) => void;
  /**
   * When true, retain up to `maxRetainBytes` of combined stdout/stderr for the
   * result object. Defaults to false — image builds must not retain streams.
   */
  readonly retainOutput?: boolean;
  readonly maxRetainBytes?: number;
  /** Failure classification when the process exits non-zero. */
  readonly failureCode?: "native_state" | "internal" | "capability";
  readonly failureMessage?: string;
  readonly failureDetails?: Readonly<Record<string, unknown>>;
}

export interface RunExactCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunExactCommand = (request: RunExactCommandRequest) => Promise<RunExactCommandResult>;

export async function runExactCommand(
  request: RunExactCommandRequest,
): Promise<RunExactCommandResult> {
  throwIfAborted(request.signal);
  const retain = request.retainOutput === true;
  const maxRetain = request.maxRetainBytes ?? DEFAULT_SUBPROCESS_RETAIN_BYTES;

  return new Promise<RunExactCommandResult>((resolve, reject) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let retainedTotal = 0;
    let settled = false;
    let timedOut = false;
    let stdoutBuf = "";
    let stderrBuf = "";

    const appendRetained = (target: "stdout" | "stderr", text: string): void => {
      if (!retain || text.length === 0) {
        return;
      }
      const remaining = maxRetain - retainedTotal;
      if (remaining <= 0) {
        return;
      }
      const slice = text.length <= remaining ? text : text.slice(0, remaining);
      if (target === "stdout") {
        stdout += slice;
      } else {
        stderr += slice;
      }
      retainedTotal += slice.length;
    };

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref?.();
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (request.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, request.timeoutMs);
      timer.unref?.();
    }

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      request.signal?.removeEventListener("abort", onAbort);
    };

    request.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      appendRetained("stdout", text);
      stdoutBuf += text;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        request.onStdoutLine?.(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      appendRetained("stderr", text);
      stderrBuf += text;
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) {
        request.onStderrLine?.(line);
      }
    });

    child.on("error", (error) => {
      settle(() => {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          reject(
            SboxError.capability(`${request.executable} is not available.`, {
              cause: error,
              details: {
                unavailableReason: "missing_runtime",
                executable: request.executable,
              },
            }),
          );
          return;
        }
        reject(
          SboxError.internal(`Failed to start ${request.executable}.`, {
            cause: error,
            details: { executable: request.executable },
          }),
        );
      });
    });

    child.on("close", (code) => {
      settle(() => {
        if (request.signal?.aborted) {
          reject(SboxError.cancellation("Image operation was cancelled."));
          return;
        }
        if (timedOut) {
          reject(
            SboxError.timeout("Image operation timed out.", {
              details: { executable: request.executable },
            }),
          );
          return;
        }
        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          reject(
            new SboxError(
              request.failureCode ?? "native_state",
              request.failureMessage ?? "Command failed.",
              {
                details: {
                  ...request.failureDetails,
                  executable: request.executable,
                  exitCode,
                },
              },
            ),
          );
          return;
        }
        resolve({ exitCode, stdout, stderr });
      });
    });
  });
}
