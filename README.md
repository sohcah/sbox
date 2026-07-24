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

This repository is currently design-first. Start with:

- [`docs/product.md`](docs/product.md)
- [`docs/system-plan.md`](docs/system-plan.md)
- [`docs/non-goals.md`](docs/non-goals.md)
- [`docs/implementation-plan.md`](docs/implementation-plan.md)
- [`docs/prior-art.md`](docs/prior-art.md)
