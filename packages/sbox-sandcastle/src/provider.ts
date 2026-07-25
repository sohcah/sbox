/**
 * Factory: map an existing SboxClient + profile onto Sandcastle's
 * IsolatedSandboxProviderConfig.
 */

import type { IsolatedSandboxProviderConfig } from "@ai-hero/sandcastle";
import { SboxError, selectProfile, type SboxClient } from "@sohcah/sbox";
import { createSboxIsolatedHandle } from "./handle.js";
import { uniqueSandcastleInstanceId } from "./instance.js";

const DEFAULT_WORKTREE_PATH = "/workspace";
const DEFAULT_PROVIDER_NAME = "sbox";

export interface SboxSandcastleOptions {
  /** Already configured client; the adapter never constructs its own client. */
  readonly client: SboxClient;
  /** Profile slug; defaults to the project's default profile. */
  readonly profile?: string;
  /**
   * Absolute guest worktree path advertised to Sandcastle.
   * Defaults to `/workspace`.
   */
  readonly worktreePath?: string;
  /** Provider name passed to Sandcastle (default `sbox`). */
  readonly name?: string;
  /** Environment variables injected by this provider and merged at launch. */
  readonly env?: Readonly<Record<string, string>>;
  /** Optional target selection forwarded on create. */
  readonly target?: string;
}

/**
 * Build Sandcastle's `IsolatedSandboxProviderConfig` over a stable `SboxClient`.
 *
 * Wrap with Sandcastle's `createIsolatedSandboxProvider(...)` before passing to
 * `run()` / `interactive()` / `createSandbox()`.
 *
 * Each `create()` allocates a unique owned sandbox for the selected profile.
 * Normal `close()` removes that exact sandbox and cancels tracked children.
 * Crash leftovers remain visible for explicit `sbox remove`.
 */
export function createSboxSandcastleProvider(
  options: SboxSandcastleOptions,
): IsolatedSandboxProviderConfig {
  const worktreePath = assertAbsoluteWorktree(options.worktreePath ?? DEFAULT_WORKTREE_PATH);
  const selected = selectProfile(options.client.project, options.profile);
  const shell = selected.profile.shell ?? "/bin/sh";
  const name = options.name ?? DEFAULT_PROVIDER_NAME;

  return {
    name,
    ...(options.env !== undefined ? { env: { ...options.env } } : {}),
    create: async (createOptions) => {
      const instance = uniqueSandcastleInstanceId();
      const handle = await options.client.create({
        profile: selected.name,
        instance,
        env: createOptions.env,
        ...(options.target !== undefined ? { target: options.target } : {}),
      });
      return createSboxIsolatedHandle({
        handle,
        worktreePath,
        shell,
      });
    },
  };
}

function assertAbsoluteWorktree(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw SboxError.validation("worktreePath must be an absolute guest path.", {
      details: { path: "worktreePath", message: path },
    });
  }
  return path;
}
