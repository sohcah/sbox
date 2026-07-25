# API reference (`@sohcah/sbox`)

Public surface is the allowlisted export graph from `packages/sbox/src/index.ts`.
Microsandbox SDK types are never exported.

## Packages

| Package | Role |
| --- | --- |
| `@sohcah/sbox` | Config, client, Host, local/remote adapters, CLI |
| `@sohcah/sbox-sandcastle` | Sandcastle `IsolatedSandboxProviderConfig` factory |

## Client

```ts
import {
  createSboxClient,
  createSboxClientFromYaml,
  parseProjectConfig,
  type SboxClient,
  type SandboxHandle,
} from "@sohcah/sbox";
```

- `createSboxClient({ project, user?, host?, env?, invocation?, logger? })`
- `createSboxClientFromYaml({ configPath? | cwd?, ... })`
- Operations: `build`, `create`, `get`, `list`, `up`, `recreate`, `inspect`,
  `stop`, `remove`, image/volume helpers, `volumeShell`
- `up` is create-if-absent / start-if-stopped / return-if-running only
- Client and handle disposal never stop or remove sandboxes

### Handle

- Lifecycle: `inspect`, `start`, `stop`, `remove`
- Process: `exec` / `execStream` (exact argv), `shell` / `shellStream`, `pty`
- Transfer: `copyToGuest`, `copyFromGuest` (files or directories)

Guest non-zero exit is a `ProcessResult`, not a thrown error. Operational
failures throw `SboxError` with a stable `code` union.

## Host

`Host` is the single local/remote contract. Construct with `createLocalHost()`
or `createRemoteHost({ url, bearerToken })`. Inject a Host into the client for
tests (`FakeHost` is package-private).

## Errors and logging

- `SboxError` + `isSboxError` / `isAbortError`
- Libraries are silent unless passed a `Logger`; use `createRedactingLogger`
- Secret-looking keys are redacted in error details and log events
  (`SECRET_DETAIL_CANARY_KEYS`, `SECRET_LOG_CANARY_KEYS`)

## Remote

- `SBOX_PROTOCOL_VERSION` (`1`)
- `createSboxServer` / CLI `sbox serve`
- Unauthenticated `GET /health`; authenticated handshake and all other routes

## Identity and ownership

Portable slugs for project / profile / instance. Deterministic native names and
reserved ownership labels. See `docs/system-plan.md`.

## Related

- CLI: [`cli.md`](cli.md)
- Config: [`configuration.md`](configuration.md)
- Sandcastle: [`sandcastle.md`](sandcastle.md)
- Non-goals: [`non-goals.md`](non-goals.md)
