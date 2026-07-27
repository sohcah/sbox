# Non-goals and complexity budget

These are architectural constraints for `0.1`. Adding one requires a concrete
workflow and a design-plan update.

## No second control plane

- No SQLite or other `sbox` sandbox/image/volume catalog.
- No shadow lifecycle or desired-state reconciliation engine.
- No durable operation claims, PID fencing, repair taxonomy, adoption flow, or
  generic artifact journal.
- No leases, heartbeats, orphan reaper, expiry scheduler, or background worker.
- No automatic rollback of native operations after transport failure.

Microsandbox owns native truth. `sbox` uses deterministic identity, reserved
labels, exact native inspection, and retry.

## Narrow locking exception

There is no general locking subsystem. One cross-process, OS-released lock per
managed base QCOW2 is permitted because modifying a backing file while a child
exists can corrupt data. Its scope is only child creation/native publication or
the complete direct-base maintenance session.

Image builds do not receive cross-process locks. Lifecycle methods do not use
durable claims. The volume lock must not grow into reusable workflow machinery.

## No sophisticated storage manager

- No versioned bases or template lineage.
- No retained sandbox overlay chains or persisted modifications after removal.
- No snapshots, clones beyond direct disposable children, rollback, merge, or
  publication workflow.
- No automatic resize, filesystem migration, rebasing, repair, or adoption.
- No implicit cross-project base sharing.
- No Microsandbox named-volume or arbitrary tmpfs abstraction in `0.1`.
- No broad volume prune or automatic stale-resource deletion.

One mutable base, disposable direct children, and an exclusive maintenance
sandbox are the complete model.

## No general image platform

- No builder plugin architecture, Podman abstraction, Nix, Compose ingestion,
  or arbitrary build hooks.
- No cross-platform/multi-architecture builds.
- No `sbox` layer cache, image database, registry service, automatic image
  garbage collection, or retention policy.
- No private-registry authentication/custom-CA surface in `0.1`.
- No attempt to restrict Docker build networking through sandbox policy.
- No automatic installation of Docker or `qemu-img`.

The supported paths are an existing OCI/native reference or a deterministic
Dockerfile build exported and loaded directly.

## No broad SDK mirror

Profiles intentionally omit:

- arbitrary pass-through SDK settings and user-defined native labels;
- CPU/memory hotplug maxima;
- entrypoint/init overrides, rootfs patches, embedded scripts, and startup
  hooks;
- rlimits, metrics tuning, and selectable security profiles;
- advanced registry, TLS interception, secret injection, DNS/NIC, or complete
  network-policy knobs;
- native detached/ephemeral flags as user configuration.

Capabilities are added to the curated model only for demonstrated workflows.
The native SDK handle is never exposed publicly.

## No permissive networking

- No unrestricted network default.
- No implicit network access granted by an exec call or a secret-host rule.
- No maintained `github`, `npm`, `apt`, or other changing domain presets.
- No general ingress policy; inbound access comes only from explicit published
  ports.

## No process supervisor

- No detached/background process API.
- No process journal, reconnection protocol, persisted log service, or durable
  process identity implemented by `sbox`.
- No promise that a process survives its controlling stream.

Native whole-sandbox duration/idle timeouts remain supported because they are
direct Microsandbox settings.

## No filesystem synchronization

- No implicit repository copy during sandbox creation.
- No watchers, bidirectional sync, bind-based project sync, or automatic
  copy-back during removal.
- No preservation of ownership, timestamps, devices, sockets, or other special
  file metadata.

Transfer is explicit and one-shot.

## Narrow remote trust model

- No multi-user identity, roles, project authorization, tenancy, quotas, or
  untrusted-host hardening.
- No built-in TLS termination, certificate management, service installer, or
  daemon supervisor.
- No custom SSH protocol.
- No claim that bearer authentication over HTTP encrypts credentials, secrets,
  commands, or transferred data.
- No browser/edge client support.

`sbox serve` is a foreground trusted-host service. Operators choose private
networking or an external TLS/service manager.

## Narrow configuration language

- No profile inheritance, custom merge semantics, or arbitrary interpolation.
- No automatic migrations of unknown schema versions.
- No host-path-dependent durable identity.
- No server-side project YAML loading.
- No implicit reconciliation or silent replacement when profile settings
  change.

## No crash-perfect ephemeral cleanup

`run` and the Sandcastle adapter remove exact sandboxes during normal cleanup.
They do not guarantee removal after client-machine failure. Leftovers remain
owned, inspectable, and explicitly removable; no lease framework is introduced
to eliminate them automatically.

The direct-base maintenance workflow is intentionally stronger because backing
file integrity requires it.

## No extra product services

- No telemetry, analytics, crash reporting, or automatic update checks.
- No automatic host-tool installation.
- No broad repair or destructive `prune` commands.
- No compatibility implementation for multiple pre-1 remote protocols.

## Complexity tests

Before adding infrastructure, ask:

1. Can Microsandbox or deterministic host files answer this instead?
2. Can exact identity, validation, retry, and reinspection handle failure?
3. Is cross-process coordination required for data integrity, or merely nice?
4. Is this a current workflow or a hypothetical future integration?
5. Can one deep module hide the complexity without enlarging every caller?
6. Would deleting the feature remove work, or only force callers to rebuild it?
7. Does the change preserve local/remote parity and the stable public API?

The desired result is not the fewest lines at any cost. It is the least system
that fully implements the agreed workflows without postponing known essential
work.
