# @sohcah/sbox-sandcastle

Sandcastle isolated-sandbox provider adapter over `@sohcah/sbox`. License: MIT.

## Install

```bash
pnpm add @sohcah/sbox @sohcah/sbox-sandcastle @ai-hero/sandcastle
```

`@ai-hero/sandcastle` is a peer dependency. Core `@sohcah/sbox` does not depend
on Sandcastle.

## Usage

```ts
import { createIsolatedSandboxProvider, run, claudeCode } from "@ai-hero/sandcastle";
import { createSboxClientFromYaml } from "@sohcah/sbox";
import { createSboxSandcastleProvider } from "@sohcah/sbox-sandcastle";

const client = await createSboxClientFromYaml({/* ... */});
const sandbox = createIsolatedSandboxProvider(
  createSboxSandcastleProvider({
    client,
    profile: "default",
    // worktreePath defaults to "/workspace"
  }),
);

await run({
  agent: claudeCode("…"),
  sandbox,
});
```

Each Sandcastle `create()` allocates a unique owned sandbox for the selected
profile. `close()` removes that exact sandbox and cancels tracked process/PTY
sessions. Crash leftovers remain visible for explicit `sbox remove`.

## Contract coverage

- Shell `exec` with cwd, `sudo`→root, string stdin, collected result, and live
  `onLine` callbacks derived incrementally from stdout and stderr
- `interactiveExec` with arbitrary Node streams, TTY→PTY + resize, merged
  output to stdout when TTY
- Recursive `copyIn`, single-file `copyFileOut`, absolute `worktreePath`
- Idempotent `close` → exact remove (`not_found` is success)
