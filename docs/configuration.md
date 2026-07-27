# Configuration

## Documents

| Document | Location |
| --- | --- |
| Project | `sbox.yaml` (search upward) or `--config` |
| User | `~/.config/sbox/config.yaml` (or `$XDG_CONFIG_HOME/sbox`; Windows: `%APPDATA%\sbox`) or `--user-config` |

`version: 1` is required. Unknown fields are rejected. Portable slugs identify
project, profiles, instances, volumes, and targets.

## Project sketch

```yaml
version: 1
project: demo
defaultProfile: default
# Optional: select a named user target (definitions live in user config)
# target: lab

volumes:
  cache:
    size: 4GiB

profiles:
  default:
    image: alpine:3.20
    cpus: 1
    memory: 512MiB
    workdir: /workspace
    user: root
    shell: /bin/sh
    volumes:
      - volume: cache
        path: /cache
    mounts:
      - path: ./vendor
        mount: /vendor
      - path: ./config.json
        mount: /etc/app/config.json
      - path: /var/cache/tools
        source: host
        mount: /tools
        readonly: false
        quota: 512MiB
    network:
      mode: default-deny
      allow:
        - domain: example.com
          ports: [443]
      publish:
        - guest: 8080
          host: 8080
          protocol: tcp
    secrets:
      - env: API_TOKEN
        from:
          env: API_TOKEN
        destinations:
          - host: api.example.com
            port: 443
```

Dockerfile-backed profiles use `build:` instead of `image:` (context +
optional dockerfile path). Ordinary environment and build args may be literal
or external refs (`env` / `file` / `invocation`).

## Host mounts

Profile `mounts:` attach a Client or Host file or directory into the guest at
create time (immutable creation; no live refresh or copy-back). Kind (file vs
directory) is inferred at create from the real path — not a YAML field.
`directories:` is rejected.

| Field | Default | Notes |
| --- | --- | --- |
| `path` | required | Client: relative to project config dir (`~/…` → home; absolute allowed). Host: absolute on the Host, or `~/…` expanded on the Host. |
| `mount` | required | Absolute guest path; unique across `mounts` and `volumes`. |
| `source` | `client` | `client` or `host`. |
| `readonly` | `true` | Client sources must stay read-only. |
| `quota` | — | Optional when `readonly: false` (Host writable only). Omit to accept Microsandbox’s protective default. |

At create, the path must exist as a real file or directory (symlink roots
rejected). On a remote target, Client paths are staged once onto the serve Host,
then bound read-only; Host paths are validated on the serve machine.

## User targets

User config stores connection metadata and credential references only:

```yaml
version: 1
defaultTarget: lab
targets:
  lab:
    kind: remote
    url: http://127.0.0.1:8787
    token:
      env: SBOX_LAB_TOKEN
```

## Creation overrides

Invocation may overlay instance identity, ordinary environment, secrets, and
extra network allow/publish rules. Exec cannot widen network policy.

## Safety

- Secrets never enter identities, archives, logs, JSON inspection, or argv
- Default network is default-deny (DNS + loopback only) when omitted
- Secret destinations never grant network access

See [`samples/local`](../samples/local) and [`samples/remote`](../samples/remote).
