# @sohcah/sbox

Public Node.js API and `sbox` CLI for configuration-driven Microsandbox
workflows.

Phase 2 exposes:

- strict version-1 typed project configuration and `sbox.yaml` loading;
- `createSboxClient` / `createSboxClientFromYaml`;
- named-sandbox `create`, `get`, `list`, `up`, and `recreate`;
- sandbox handles with `inspect` / `start` / `stop` / `remove`;
- CLI commands: `init`, `config validate`, `config show`, `up`, `list`,
  `inspect`, `stop`, `remove`.

Microsandbox SDK types are never part of this package's public surface.
Disposal of clients and handles never changes sandbox lifecycle.
