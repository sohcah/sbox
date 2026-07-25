# Prerequisites

## Always

- Node.js **24+** (ESM)
- pnpm 10+ for this workspace (consumers need a Node package manager)

## Local Microsandbox host

- [Microsandbox](https://github.com/superradcompany/microsandbox) runtime with
  hypervisor support on the machine
- Docker CLI for Dockerfile-backed image builds / loads
- `qemu-img` when using managed volumes
- Formatter image for volume mkfs (build `packages/sbox/formatter/Dockerfile`
  or set `SBOX_VOLUME_FORMATTER_IMAGE`)

## Remote client only

- Reachable `sbox serve` endpoint and bearer token
- No local Microsandbox, Docker, or `qemu-img` required for pure remote-client
  use

## Platforms

Windows, macOS, and Linux are supported as clients. Local-host virtualization
depends on Microsandbox platform support; when unavailable, use a remote
target. Acceptance suites report `passed` / `unavailable` / `failed` via
`sbox-acceptance-status:` lines.

## Environment overrides

| Variable | Purpose |
| --- | --- |
| `SBOX_SERVE_TOKEN` | Default serve bearer token |
| `SBOX_VOLUME_DATA_ROOT` | Volume base directory |
| `SBOX_VOLUME_FORMATTER_IMAGE` | mkfs formatter image |
| `SBOX_QEMU_IMG` | `qemu-img` executable path |
| `MSB_HOME` | Microsandbox home (keep short on macOS for socket path limits) |
