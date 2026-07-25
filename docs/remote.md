# Remote deployment

## Topology

```text
SboxClient ──HTTP/WS──► sbox serve ──► LocalHost ──► Microsandbox
```

The server does not read project YAML or keep a project catalog. Images,
QCOW2 bases, and Microsandbox state live on the selected host.

## Serve

```bash
export SBOX_SERVE_TOKEN='at-least-16-chars'
sbox serve --bind 127.0.0.1 --port 8787
# Non-loopback (unencrypted unless you terminate TLS elsewhere):
sbox serve --bind 0.0.0.0 --port 8787 --allow-non-loopback
```

- Protocol version: `SBOX_PROTOCOL_VERSION` = `1`
- `GET /health` is unauthenticated (liveness + integer version only)
- Every other HTTP route and WebSocket upgrade requires `Authorization: Bearer …`
- Graceful shutdown cancels controlled work and leaves ordinary sandboxes

## Client target

Project or user config:

```yaml
targets:
  lab:
    kind: remote
    url: http://127.0.0.1:8787
    token:
      env: SBOX_SERVE_TOKEN
```

```bash
sbox --target lab doctor
sbox --target lab up default
```

## TLS and networking

Plain HTTP is allowed, including non-loopback with an explicit flag. Credentials,
environment values, and transferred bytes are **not** encrypted on the wire.
Operators must provide a private network or an external TLS proxy when required.
`doctor` warns on non-loopback `http://` URLs.

## Limits

Server enforces in-memory bounds (request/archive bytes, concurrency, session
duration, output caps). These are not durable quotas.
