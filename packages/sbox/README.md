# @sohcah/sbox

Public Node.js API and `sbox` CLI for configuration-driven Microsandbox
workflows.

Includes local and remote Hosts: `createLocalHost`, `createRemoteHost`, and
foreground `createSboxServer` / `sbox serve` (bearer token via `SBOX_SERVE_TOKEN`).
Protocol version is `SBOX_PROTOCOL_VERSION` (`1`). Health is unauthenticated;
all other routes and WebSocket upgrades require Bearer auth.

CLI highlights: `init`, `config`, `doctor`, `serve`, `build`, `up`, `run`,
`list`, `inspect`, `stop`, `remove`, `exec`, `shell`, `image`, `volume`.

Collected stdout/stderr default to 10 MiB each. Streaming sessions use a
bounded pull-driven queue; callers must consume events or cancel. Non-zero
guest exit is a `ProcessResult`. Operational failures throw `SboxError`.
Microsandbox SDK types are never part of this package's public surface.
Disposal of clients and handles never changes sandbox lifecycle.
