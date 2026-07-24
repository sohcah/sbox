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

Phase 2 is implemented: strict version-1 project configuration (typed and
YAML), `SboxClient` named-sandbox workflows (`create` / `get` / `list` / `up` /
`recreate`), and lifecycle CLI commands over the Phase 1 Host seam.

Later phases add Docker image building, networking, QCOW2 volumes, remote
transport, process execution, and the Sandcastle adapter.

## Development

```bash
pnpm install
pnpm check                 # format, lint, typecheck, build, unit tests
pnpm test:acceptance       # optional real Microsandbox lifecycle (needs runtime)
                           # prints `sbox-acceptance-status: passed|unavailable|failed`
                           # unavailable is reported as a skipped Vitest test, not a pass
```

## Quick start (Phase 2)

```bash
sbox init --project demo
sbox config validate
sbox up default
sbox list
sbox inspect default
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
await handle.stop();
await handle.remove();
await client[Symbol.asyncDispose]();
```

`up` is deliberately narrow: create-if-absent, start-if-stopped, success-if-running.
Changed immutable creation settings are reported as drift and require explicit
`recreate`.

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

`--json` emits a single result object on stdout for non-streaming commands.

Design docs:

- [`docs/product.md`](docs/product.md)
- [`docs/system-plan.md`](docs/system-plan.md)
- [`docs/non-goals.md`](docs/non-goals.md)
- [`docs/implementation-plan.md`](docs/implementation-plan.md)
- [`docs/prior-art.md`](docs/prior-art.md)

The Microsandbox TypeScript 7 declaration patch is documented under
[`patches/README.md`](patches/README.md).
