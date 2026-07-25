# sbox

`sbox` is a small TypeScript library and CLI that adds strict project
configuration, automatic Docker image preparation, restricted networking,
simple QCOW2 base volumes, and remote access to
[Microsandbox](https://github.com/superradcompany/microsandbox).

The repository publishes two Node.js packages:

- `@sohcah/sbox`, including the `sbox` CLI;
- `@sohcah/sbox-sandcastle`, implementing Sandcastle's isolated-sandbox
  provider over the general `sbox` API.

Microsandbox remains authoritative for native resources and lifecycle. `sbox`
does not maintain a second sandbox database or orchestration state machine.

## Status

Phase 3 is implemented: local exact-argv and guest-shell execution (collected
and streaming), interactive PTY with arbitrary streams and resize, bidirectional
file/directory transfer, and CLI `exec` / `shell` over the Host seam.

Later phases add Docker image building, networking, QCOW2 volumes, remote
transport, and the Sandcastle adapter.

## Development

```bash
pnpm install
pnpm check                 # format, lint, typecheck, build, unit tests
pnpm test:acceptance       # optional real Microsandbox (needs runtime)
                           # prints `sbox-acceptance-status: passed|unavailable|failed`
                           # unavailable is reported as a skipped Vitest test, not a pass
```

## Quick start (Phase 3)

```bash
sbox init --project demo
sbox config validate
sbox up default
sbox exec default -- printf '%s' hello
sbox shell default -- 'echo shell-ok'
sbox stop default
sbox remove default
```

Programmatic equivalent:

```ts
import { createSboxClient, parseProjectConfig } from "@sohcah/sbox";

const client = createSboxClient({
  project: parseProjectConfig({
    version: 1,
    project: "demo",
    profiles: {
      default: { image: "alpine:3.20", memoryMiB: 512 },
    },
  }),
});

const handle = await client.up({ profile: "default" });
const result = await handle.exec(["printf", "%s", "hello"]);
// Non-zero guest exit is a ProcessResult, not an thrown error.
await handle.copyToGuest("./payload.bin", "/tmp/payload.bin");
await handle.stop();
await handle.remove();
await client[Symbol.asyncDispose]();
```

`up` is deliberately narrow: create-if-absent, start-if-stopped, success-if-running.
Changed immutable creation settings are reported as drift and require explicit
`recreate`. Disposal closes local objects only and never stops or removes a
sandbox.

### Process and transfer notes

- Exact argv never passes through a host or guest shell. Use `shell` /
  `execShell` for guest-shell interpretation (`profile.shell`, default
  `/bin/sh`).
- Collected stdout/stderr default to 10 MiB each; overflow cancels the process
  and throws `output_limit`.
- Streaming events are byte-oriented: `started` / `stdout` / `stderr` /
  `exited`. UTF-8 and line helpers are optional.
- PTY supports arbitrary Node streams, merged output, resize, and cancellation.
  The pinned SDK `attach*` API is terminal-bound; PTY uses an isolated private
  agent-protocol adapter (see `patches/README.md`).
- Transfers preserve bytes, executable bits, and safe symlinks. They reject
  traversal, escaping links, and special files. Ownership and timestamps are
  not preserved.

### CLI exit codes

| Code | Meaning                              |
| ---- | ------------------------------------ |
| 0    | Success                              |
| 1    | Operational failure                  |
| 2    | Validation / configuration error     |
| 3    | Ownership conflict or creation drift |
| 4    | Not found                            |
| 5    | Already exists                       |
| 130  | Cancellation                         |

For `exec` and `shell`, the guest process exit code becomes the CLI exit code
on success of the Host operation. `--json` emits a single result object for
collected commands; `--stream --json` emits typed NDJSON events.

Design docs:

- [`docs/product.md`](docs/product.md)
- [`docs/system-plan.md`](docs/system-plan.md)
- [`docs/non-goals.md`](docs/non-goals.md)
- [`docs/implementation-plan.md`](docs/implementation-plan.md)
- [`docs/prior-art.md`](docs/prior-art.md)

The Microsandbox TypeScript 7 declaration patch and the private PTY agent
adapter are documented under [`patches/README.md`](patches/README.md).
