# Networking

## Defaults

Unconfigured creates use **default-deny** outbound networking with DNS and
loopback only. There is no unrestricted default.

## Profile `network`

```yaml
network:
  mode: default-deny   # or disabled
  allow:
    - domain: registry.npmjs.org
      ports: [443]
    - suffix: .pkg.dev
      ports: [443]
    - ip: 1.2.3.4
      ports: [80, 443]
    - cidr: 10.0.0.0/8
      ports: [443]
      protocols: [tcp]   # optional; tcp/udp
  publish:
    - guest: 3000
      host: 3000         # omit / 0 only when dynamicHostPorts capability is true
      protocol: tcp
      bind: 127.0.0.1    # default loopback
```

## Secrets vs network

Runtime secret interception (`secrets:`) carries destinations for TLS
interception metadata. **Destinations never grant outbound access.** Allow
rules are separate.

## Exec cannot widen policy

Network allow/publish overlays are creation-time only. Per-exec options cannot
open the network.

## Published ports

Inbound access is only through explicit `publish` entries. Dynamic host ports
are capability-gated; Microsandbox 0.6.6 currently reports
`dynamicHostPorts: false` because allocated ports are not inspectable.

## Docker builds

Dockerfile builds use the host Docker daemon's networking. Sandbox default-deny
does not constrain build-time Docker.
