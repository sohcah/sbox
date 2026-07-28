# Troubleshooting

## `doctor` failures

Run `sbox doctor --json` and inspect `data.checks`.

| Check | Typical fix |
| --- | --- |
| `target` | Fix `sbox.yaml` / user config discovery or `--config` |
| `remote-handshake` | Token, URL, protocol mismatch, or server down |
| `local-host` / `microsandbox` | Install/start Microsandbox; check hypervisor |
| `docker` | Install Docker CLI; ensure daemon reachable for builds |
| `qemu-img` | Install qemu-img or set `SBOX_QEMU_IMG` when using volumes |

Informational checks (`docker`, `qemu-img`, `formatter-image`, `microsandbox`)
may report `ok: false` without failing the command; only `required: true`
checks affect the exit code.

## Creation drift / ownership

`up` does not reconcile. Immutable creation changes require `recreate`. Partial
reserved labels on foreign resources are ownership conflicts—do not adopt.

## Images

Dockerfile profiles need Docker. Content identity changes when context, build
args, Dockerfile, or Host `dockerPlatform` change. Conflicting unowned images at
a generated reference fail closed. Remote Clients must rebuild after upgrading a
Host that previously built with the wrong platform (Client arch leak).

## Volumes

`qemu-img` missing → volume ops fail with capability. Base locked → wait for
the other maintenance/create session. Never manually edit QCOW2 files under
`~/.sbox/volumes`.

## Remote

- Non-loopback HTTP: expect `doctor` warning; use TLS proxy or private net
- Protocol mismatch: upgrade client and server together (no parallel protocols
  in pre-1)
- Transfer/archive limits: raise server bounds or shrink payloads
- Dockerfile builds use the Host's Docker platform, not the Client's CPU arch
  (e.g. Mac arm64 Client → Windows amd64 Host builds `linux/amd64`)

## Processes

- Guest non-zero exit is not an operational failure for `exec`/`shell`/`run`
- Streaming callers must consume events or cancel
- PTY uses a private agent-protocol adapter; see `patches/README.md`
- Remote streaming stdin (Codex/`codex exec` prompts, `cat`, …) requires a
  current `sbox serve`: older servers closed guest stdin before WebSocket
  prompt bytes arrived (`No prompt provided via stdin`)

## Sandcastle

Leftover sandboxes after a crash: `sbox list` then exact `sbox remove`.
`close()` after a transient remove error can be retried; new execs stay
rejected once closing has started.
