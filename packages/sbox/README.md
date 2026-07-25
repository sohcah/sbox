# @sohcah/sbox

Public Node.js API and `sbox` CLI for configuration-driven Microsandbox
workflows.

Phase 3 exposes:

- strict version-1 typed project configuration and `sbox.yaml` loading;
- `createSboxClient` / `createSboxClientFromYaml`;
- named-sandbox `create`, `get`, `list`, `up`, and `recreate`;
- sandbox handles with lifecycle plus `exec` / `execStream` / `shell` /
  `shellStream` / `pty` / `copyToGuest` / `copyFromGuest`;
- CLI commands: `init`, `config validate`, `config show`, `up`, `list`,
  `inspect`, `stop`, `remove`, `exec`, `shell`.

Collected stdout/stderr default to 10 MiB each. Streaming sessions use a
bounded pull-driven queue; callers must consume events or cancel. Non-zero
guest exit is a `ProcessResult`. Operational failures throw `SboxError`.
Microsandbox SDK types and transfer archive helpers are never part of this
package's public surface. Disposal of clients and handles never changes
sandbox lifecycle.
