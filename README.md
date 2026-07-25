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

Phase 8 is implemented: `@sohcah/sbox-sandcastle` adapts an existing
`SboxClient` to Sandcastle's isolated provider contract (peer
`@ai-hero/sandcastle`), and the CLI `run` command creates a unique sandbox,
executes once, and removes in `finally`.

Phase 7 remains in place for remote Host transport: authenticated foreground
`sbox serve`, `createRemoteHost`, HTTP/WebSocket process and transfer parity,
and remote-aware `doctor`.

Phase 6 remains in place for managed QCOW2/ext4 volumes: project volume
declarations, profile attachments, host-local bases under
`~/.sbox/volumes` (override with `SBOX_VOLUME_DATA_ROOT`), disposable child
overlays on ordinary create, exclusive `volume shell` maintenance mounting the
base directly, and CLI `volume list` / `volume shell` / `volume remove`. Bases
are formatted via a pinned formatter image that already contains `mkfs.ext4`
(default `sbox-volume-formatter:1` from `packages/sbox/formatter/Dockerfile`,
override with `SBOX_VOLUME_FORMATTER_IMAGE`) plus host `qemu-img` (required
only when volumes are used).

Phase 5 remains in place for curated networking and runtime secrets: profile
`network.mode` (`disabled` | `default-deny`), outbound allow rules (domain /
suffix / IP / CIDR with TCP/UDP ports), published ports (loopback bind by
default; dynamic host ports are capability-gated and currently off on
Microsandbox 0.6.6 because allocated ports are not inspectable), and
Microsandbox secret interception (external value, guest placeholder,
destinations). Secret destinations never grant network access. Unconfigured
creates use default-deny with DNS and loopback only.

Phase 4 remains in place for Dockerfile-backed profiles: content-addressed
identity, Docker build → ownership stamp → export → `msb image load`,
in-process coalescing, and CLI `build` / `image list` / `image remove`.

## Development

```bash
pnpm install
pnpm check                 # format, lint, typecheck, build, unit tests
pnpm test:acceptance       # optional real Microsandbox (needs runtime)
                           # prints `sbox-acceptance-status: passed|unavailable|failed`
                           # unavailable is reported as a skipped Vitest test, not a pass
```

## Quick start (Phase 8)

```bash
sbox init --project demo
# Edit sbox.yaml — volumes + networking example:
# volumes:
#   cache:
#     size: 4GiB
# profiles:
#   default:
#     image: alpine:3.20
#     volumes:
#       - volume: cache
#         path: /cache
#     network:
#       mode: default-deny
#       allow:
#         - domain: example.com
sbox config validate
sbox up default
sbox run default -- printf '%s' hello   # unique sandbox; removed in finally
sbox volume list
sbox volume shell default cache   # exclusive base maintenance
sbox stop default && sbox remove default
sbox volume remove cache
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

For `exec`, `shell`, and `run`, the guest process exit code becomes the CLI
exit code on success of the Host operation. `--json` emits a single result
object for collected commands; `--stream --json` emits typed NDJSON events.

Design docs:

- [`docs/product.md`](docs/product.md)
- [`docs/system-plan.md`](docs/system-plan.md)
- [`docs/non-goals.md`](docs/non-goals.md)
- [`docs/implementation-plan.md`](docs/implementation-plan.md)
- [`docs/prior-art.md`](docs/prior-art.md)

The Microsandbox TypeScript 7 declaration patch and the private PTY agent
adapter are documented under [`patches/README.md`](patches/README.md).
