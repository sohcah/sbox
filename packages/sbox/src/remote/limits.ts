/**
 * In-memory admission limits for the foreground server / RemoteHost.
 */

export interface RemoteLimits {
  readonly maxRequestBytes: number;
  readonly maxArchiveBytes: number;
  readonly maxConcurrentProcesses: number;
  readonly maxConcurrentBuilds: number;
  /** Wall-clock bound for an authenticated HTTP/WS operation after admission. */
  readonly maxDurationMs: number;
  /** Bound for waiting for the first session-start frame after WS upgrade. */
  readonly sessionStartTimeoutMs: number;
  /** Default collected stdout/stderr bound when the client omits limits. */
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly wsSendBufferBound: number;
  /**
   * After process/PTY settlement, how long to keep flushing output before
   * sending `exited` even if the pump is stalled (e.g. client not reading).
   */
  readonly outputFlushMs: number;
  readonly shutdownWaitMs: number;
}

export const DEFAULT_REMOTE_LIMITS: RemoteLimits = Object.freeze({
  maxRequestBytes: 16 * 1024 * 1024,
  maxArchiveBytes: 512 * 1024 * 1024,
  maxConcurrentProcesses: 32,
  maxConcurrentBuilds: 4,
  maxDurationMs: 60 * 60 * 1000,
  sessionStartTimeoutMs: 30_000,
  maxStdoutBytes: 10 * 1024 * 1024,
  maxStderrBytes: 10 * 1024 * 1024,
  wsSendBufferBound: 1024 * 1024,
  outputFlushMs: 250,
  shutdownWaitMs: 15_000,
});

export function resolveRemoteLimits(partial?: Partial<RemoteLimits>): RemoteLimits {
  return {
    maxRequestBytes: partial?.maxRequestBytes ?? DEFAULT_REMOTE_LIMITS.maxRequestBytes,
    maxArchiveBytes: partial?.maxArchiveBytes ?? DEFAULT_REMOTE_LIMITS.maxArchiveBytes,
    maxConcurrentProcesses:
      partial?.maxConcurrentProcesses ?? DEFAULT_REMOTE_LIMITS.maxConcurrentProcesses,
    maxConcurrentBuilds: partial?.maxConcurrentBuilds ?? DEFAULT_REMOTE_LIMITS.maxConcurrentBuilds,
    maxDurationMs: partial?.maxDurationMs ?? DEFAULT_REMOTE_LIMITS.maxDurationMs,
    sessionStartTimeoutMs:
      partial?.sessionStartTimeoutMs ?? DEFAULT_REMOTE_LIMITS.sessionStartTimeoutMs,
    maxStdoutBytes: partial?.maxStdoutBytes ?? DEFAULT_REMOTE_LIMITS.maxStdoutBytes,
    maxStderrBytes: partial?.maxStderrBytes ?? DEFAULT_REMOTE_LIMITS.maxStderrBytes,
    wsSendBufferBound: partial?.wsSendBufferBound ?? DEFAULT_REMOTE_LIMITS.wsSendBufferBound,
    outputFlushMs: partial?.outputFlushMs ?? DEFAULT_REMOTE_LIMITS.outputFlushMs,
    shutdownWaitMs: partial?.shutdownWaitMs ?? DEFAULT_REMOTE_LIMITS.shutdownWaitMs,
  };
}
