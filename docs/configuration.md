# Configuration

## Documents

| Document | Location |
| --- | --- |
| Project | `sbox.yaml` (search upward) or `--config` |
| User | `~/.config/sbox/config.yaml` (platform-specific) or `--user-config` |

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
