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

Phase 1 is implemented: workspace tooling, public contracts, deterministic
native naming/ownership labels, and a local Host lifecycle adapter over
pinned `microsandbox@0.6.6`.

Later phases add YAML configuration, images, networking, QCOW2 volumes,
remote transport, CLI commands, and the Sandcastle adapter.

## Development

```bash
pnpm install
pnpm check                 # format, lint, typecheck, build, unit tests
pnpm test:acceptance       # optional real Microsandbox lifecycle (needs runtime)
                           # prints `sbox-acceptance-status: passed|unavailable|failed`
                           # unavailable is reported as a skipped Vitest test, not a pass
```

Design docs:

- [`docs/product.md`](docs/product.md)
- [`docs/system-plan.md`](docs/system-plan.md)
- [`docs/non-goals.md`](docs/non-goals.md)
- [`docs/implementation-plan.md`](docs/implementation-plan.md)
- [`docs/prior-art.md`](docs/prior-art.md)

The Microsandbox TypeScript 7 declaration patch is documented under
[`patches/README.md`](patches/README.md).
