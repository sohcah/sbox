# Sandcastle setup

Package: `@sohcah/sbox-sandcastle`  
Peer: `@ai-hero/sandcastle` (`^0.12.0`)

Core `@sohcah/sbox` does not depend on Sandcastle.

## Install

```bash
pnpm add @sohcah/sbox @sohcah/sbox-sandcastle @ai-hero/sandcastle
```

## Provider

```ts
import { createIsolatedSandboxProvider, run, claudeCode } from "@ai-hero/sandcastle";
import { createSboxClientFromYaml } from "@sohcah/sbox";
import { createSboxSandcastleProvider } from "@sohcah/sbox-sandcastle";

const client = await createSboxClientFromYaml({ /* cwd / configPath */ });
const sandbox = createIsolatedSandboxProvider(
  createSboxSandcastleProvider({
    client,
    profile: "default",
    // worktreePath defaults to "/workspace"
  }),
);

await run({ agent: claudeCode("…"), sandbox });
await client[Symbol.asyncDispose]();
```

## Contract

Each Sandcastle `create()` allocates a unique owned sandbox (`sc-<hex>`).

| Method | Behavior |
| --- | --- |
| `exec` | Guest shell; cwd; `sudo`→root; string stdin; live `onLine` from stdout **and** stderr |
| `interactiveExec` | TTY→PTY + resize, merged stdout; non-TTY→piped streams |
| `copyIn` | Recursive host→guest |
| `copyFileOut` | Single file only |
| `close` | Cancel children, exact remove; idempotent; retries after transient remove failure; new ops rejected once closing starts |

Crash leftovers remain visible for explicit `sbox remove`. Local and remote
Hosts use the same client API.
