# CLI reference

Binary: `sbox` (`@sohcah/sbox`).

## Global flags

| Flag | Meaning |
| --- | --- |
| `--json` | Single JSON result, or NDJSON events with `--stream` |
| `--config <path>` | Explicit project `sbox.yaml` |
| `--user-config <path>` | Explicit user config |
| `--target <name>` | Explicit target |
| `--instance <slug>` | Explicit instance (not for `run`) |
| `-h`, `--help` | Help |

## Commands

| Command | Purpose |
| --- | --- |
| `init [--force] [--project <slug>]` | Write starter `sbox.yaml` |
| `config validate` | Validate discovered/explicit project config |
| `config show` | Show safe projected config |
| `doctor` | Read-only checks: required Node/protocol/target; informational Docker/qemu/formatter |
| `serve [--bind] [--port] [--token-env] [--allow-non-loopback]` | Foreground trusted-host server |
| `build [profile] [--force]` | Ensure Dockerfile-backed image |
| `up [profile]` | Create-if-absent / start-if-stopped |
| `run [profile] [--cwd] [--user] [--stream] -- <argv…>` | Unique sandbox, exec once, remove in `finally` |
| `list` | List owned sandboxes for the project |
| `inspect <profile>` | Inspect selected profile/instance |
| `stop <profile>` | Stop |
| `remove <profile>` | Exact remove (no prompt, no prune) |
| `exec [profile] [--cwd] [--user] [--stream] [--shell] -- <argv…>` | Exact argv, or an explicit guest-shell expression with `--shell` |
| `shell [profile] [--cwd] [--user]` | Open the profile shell in an interactive PTY |
| `image list` / `image remove <exact> [--force]` | Managed images |
| `volume list` / `volume shell <profile> <volume>` / `volume remove <volume>` | Managed QCOW2 bases |

Destructive commands warn in docs and refuse ambiguity; they never prompt.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success / guest exit for `exec`, `shell`, `run` |
| 1 | Operational failure |
| 2 | Validation / configuration |
| 3 | Ownership conflict or creation drift |
| 4 | Not found |
| 5 | Already exists |
| 130 | Cancellation |

Collected `--json` emits exactly one result object. `--stream --json` emits
typed NDJSON events; operational failures remain structured errors.

`shell` is always interactive. Local targets use Microsandbox's native terminal
attachment; other hosts connect terminal input in raw mode, merged output, and
resize events through the portable PTY bridge. Terminal mode is restored on
exit. It does not accept `--json`, `--stream`, or a script after `--`. For
pipelines, redirects, and other non-interactive shell syntax, use:

```bash
sbox exec default --shell -- 'printf "%s\n" hello | sed s/hello/world/'
```

## Serve

Requires a bearer token from `SBOX_SERVE_TOKEN` or `--token-env` (minimum 16
characters). Default bind is loopback. Non-loopback HTTP needs
`--allow-non-loopback`; `doctor` warns that credentials and payloads are
unencrypted.
