# Minimal system plan

## Status and invariant

This plan records the architectural reset and the completed scope interview.
Its invariant is:

> `sbox` is the smallest layer over Microsandbox that provides configuration,
> automatic images, restricted networking, simple QCOW2 bases, remote
> operation, and the complete Sandcastle isolated-provider contract.

New persistence, recovery, or coordination mechanisms require a concrete
failure that cannot be handled through deterministic identity, Microsandbox
inspection, and bounded retry.

## Packages and architecture

```text
typed config / sbox.yaml
          │
          ▼
  SboxClient + handles ────────► local Host ───► Microsandbox SDK
          │                          ▲
          └── HTTP / WebSocket ──────┤
                                     │
                              sbox serve / Host

SboxClient ───► @sohcah/sbox-sandcastle ───► Sandcastle provider
```

The pnpm workspace contains:

- `packages/sbox`: configuration, client, Host, local/remote adapters, server,
  CLI, image/volume/process/transfer modules, and stable public DTOs;
- `packages/sbox-sandcastle`: only the mapping from an existing client/profile
  to Sandcastle.

Do not create a common package without demonstrated reuse that improves the
public seams.

## Module boundaries

### Configuration

The typed in-memory model is primary. YAML loading is an adapter that searches
upward or accepts an explicit path. `version: 1`, a stable project slug, strict
unknown-field rejection, complete profiles, reusable volume definitions, and
an optional default profile form the project document.

Profiles may deliberately expose:

- an OCI/native image reference or Dockerfile build;
- CPU, memory, workdir, user, shell, hostname, ordinary environment;
- native maximum-duration and idle-timeout limits;
- curated Microsandbox secret interception;
- default-deny network rules and published ports;
- managed QCOW2 attachments.

They do not expose arbitrary SDK options. Creation overrides are limited to
instance identity, ordinary environment, supplied secrets, and additional
network allow rules. External values use explicit structured references to
invocation data, environment variables, or files; there is no string
interpolation language.

Targets resolve from explicit invocation, project-selected target name, user
default target, then local. User target configuration contains safe connection
metadata and references bearer credentials through environment or owner-only
files.

### Client and handles

`SboxClient` resolves intent and selects one `Host`. It exposes explicit
`build`, `create`, `get`, `list`, `up`, `recreate`, and volume operations.
`up` is only create-if-absent/start-if-stopped/return-if-running. It does not
reconcile existing resources.

Handles expose inspection, start, stop, removal, process execution, PTY, and
transfer. Local disposal is idempotent and never changes sandbox lifecycle.
All long operations accept `AbortSignal`, subject to documented native
interruptibility.

Public results, events, and errors are application-owned DTOs. A declaration
test rejects Microsandbox SDK types at both package boundaries.

### Host

`Host` is the central deep seam implemented twice: local calls the pinned SDK;
remote serializes the same behavior. It covers:

- exact lifecycle and inspection;
- exact generated-image availability/build/load/removal;
- managed base/child volume operations;
- collected, streaming, shell, and PTY execution;
- bounded file/directory transfer;
- capability inspection.

It does not load YAML or interpret CLI policy. Microsandbox exceptions are
converted into the small public error union with the original retained as
`cause` internally.

### Remote transport

The foreground server validates protocol input and invokes the same Host used
locally. Lifecycle and inspection use JSON HTTP; archive bodies stream over
HTTP; bidirectional process/PTY channels use WebSocket. The server adds
authentication, bounded admission, cancellation on disconnect, redacted
structured logging, and graceful intake shutdown—not another resource model.

## Authority and durable state

Microsandbox is authoritative for:

- sandbox name, existence, persisted configuration, state, and labels;
- running processes and native lifecycle behavior;
- native image availability;
- its own database and runtime files.

`sbox` persists only:

- project and user configuration;
- managed base QCOW2 files and deterministic sandbox-owned child overlays;
- operation-scoped temporary files until cleanup.

There is no `sbox` resource catalog, workflow database, image database,
operation journal, desired-state mirror, or authoritative cache. Generated
image existence is answered through exact native lookup. Deterministic paths
and native persisted mount configuration close retry windows without another
mapping database.

## Identity and ownership

User-visible project, profile, volume, and instance names are portable slugs.
Native identities derive deterministically from project plus logical identity,
with a stable hash to satisfy Microsandbox's byte limit and avoid truncation
collisions.

Reserved Microsandbox labels record `sbox` ownership, project, instance,
profile, generated-image identity, and maintenance purpose. User labels are not
exposed in `0.1`.

Generated images additionally stamp reserved OCI config labels and reserved
image-config ENV markers (`DEV_SOHCAH_SBOX_*`). When the native load path
preserves OCI labels, those labels are authoritative. When OCI labels are
wholly absent after load (as with pinned Microsandbox `0.6.6` `msb image load`),
complete matching ENV markers are accepted as ownership evidence. Any present
reserved label or ENV marker that is partial, mismatched, or contradictory fails
closed. A generated reference name alone is never ownership evidence.

On uncertain creation, inspect the exact native name:

- labels and immutable configuration match: return the resource;
- absent: report/retry the original failure;
- present but inconsistent: fail with an ownership conflict.

Never adopt or replace an unlabeled/mismatched native resource.

Ordinary listing filters owned resources by project by default. Explicit
cross-project administration still lists only `sbox`-owned resources.

## Lifecycle and ownership

Ordinary named, `run`, and Sandcastle sandboxes use native detached,
non-ephemeral persistence. They survive CLI/server exit and require explicit
removal. `run` and Sandcastle remove in normal `finally`/`close`; a client crash
may leave a visible owned resource. There are no leases, heartbeats, or orphan
reapers. Native max/idle timeouts may bound runtime but do not replace removal.

`remove` stops when necessary, removes the exact native sandbox, then removes
only validated deterministic child overlays. Repeating removal when native
state is absent may finish exact overlay cleanup. Image and base deletion are
separate explicit operations.

After stopping a live SDK object with disk mounts, consume/detach it, perform a
fresh lookup, and then start or remove. This releases the proven runtime disk
lock and avoids reusing a stale handle.

Remote lifecycle disconnect does not roll back an action that reached
Microsandbox. The Host completes or reinspects exact identity; the caller may
retry safely.

## Images

### Inputs and identity

Build-backed profiles define context, optional Dockerfile (default
`Dockerfile`), optional target, ordinary build arguments, and separately
resolved BuildKit secrets. Dockerfile must remain within context.

Context packaging follows Docker ignore semantics. `.git` is excluded by
default but may be explicitly included. Symlinks are archived without being
followed; absolute/escaping links and special files are rejected.

The deterministic identity contains:

- an `sbox` identity-algorithm version;
- normalized build definition, target, host platform, and ordinary arguments;
- included relative paths, types, bytes/link targets, and executable bits.

It excludes timestamps, ownership, secret values, and other host-specific
metadata. A matching native generated image must carry the expected reserved
identity evidence (OCI labels when present; otherwise complete reserved ENV
markers when labels are wholly absent after load). A conflict fails safely.

### Build workflow

1. Resolve and validate all external inputs before mutations.
2. Package context into a unique marked operation workspace.
3. Compute the exact generated-image identity/name.
4. Reuse it when native inspection confirms a match unless force was requested.
5. Build using the Docker CLI/daemon and ordinary Docker cache.
6. Supply secrets only via owner-only files and BuildKit `--secret`.
7. Stamp reserved OCI labels and reserved ENV ownership markers, then export
   and load directly into Microsandbox without a registry.
8. Validate the loaded identity evidence and clean the workspace in `finally`.

One process may coalesce identical builds in memory. Unrelated processes do
not use durable or cross-process build locks. Failed builds leave no workflow
record. `doctor` reports marked stale workspaces; cleanup is explicit and exact.

Referenced OCI images stay in Microsandbox's pull/materialization path. Docker
is required only for build-backed profiles. Builds target the host architecture
only.

## QCOW2 volumes

### Resource model

A project volume definition names a host-local managed base and logical size.
The Host stores it under a deterministic project-scoped data path outside
Microsandbox's sandbox directory. V1 supports QCOW2 containing ext4 only.

A profile attachment supplies the volume name and guest mount path. Each
ordinary sandbox gets a deterministic writable direct child QCOW2 backed by the
base. Microsandbox persists the exact child host path in native sandbox config;
it neither copies nor deletes the host file.

Children last exactly as long as their sandboxes. Base contents do not change
through ordinary use. Base and child validation uses `qemu-img info`, including
exact format, virtual size, and backing path. Conflicts fail rather than repair.

### Base creation

Under the per-base lock:

1. prove no conflicting final base;
2. create a blank raw temporary file with portable Node APIs;
3. bind-mount the staging directory into a pinned formatter sandbox and run
   `mkfs.ext4` on the raw file (not virtio-blk — an unformatted disk image
   fails Microsandbox boot before the agent is available);
4. convert and validate QCOW2 using host `qemu-img`;
5. atomically rename it to the deterministic final path.

Size changes are reported and require explicit base replacement after all
descendants are removed. `sbox` never installs `qemu-img` or Docker.

### Maintenance and the narrow lock

Direct pre-seeding is the sole operation that mutates a base. A deterministic
maintenance sandbox uses the selected profile's image/resources/environment and
mounts the base directly at the attachment path.

One cross-process OS-released exclusive lock exists per base. It covers:

- descendant inspection, child creation, and native sandbox creation; or
- the complete direct-base maintenance session.

This lock is an integrity requirement, not a general workflow framework.

Maintenance sandboxes are attached and non-ephemeral. If their owner dies,
Microsandbox stops the VM but preserves its exact labeled record. Every child
creation or later maintenance operation, while holding the base lock, first
inspects that deterministic identity. A matching terminal maintenance sandbox
is stopped/detached/reloaded/verified/removed; mismatches or unresolved native
disk contention fail closed as retryable busy/conflict errors.

Maintenance refuses while any persisted sandbox child is backed by the base,
including stopped sandboxes. It discovers attached child paths from native
configuration and verifies backing paths with `qemu-img`; it does not consult a
catalog. Clean completion stops, consumes/detaches, freshly verifies, and
removes the maintenance sandbox while retaining the base.

There are no versions, snapshots, rollbacks, retained child chains, automatic
resizing, broad cleanup, or repair/adoption operations.

## Networking

Runtime networking uses default-deny ingress and egress. A hard-disabled mode
rejects rules and port publication. The curated outbound rule model supports:

- exact domain or suffix (suffix includes base and subdomains);
- exact IP or CIDR;
- TCP/UDP and destination port/range restrictions.

Domain rules default to TCP 80/443. Direct IP access requires an IP/CIDR rule
except for runtime mechanics needed to enforce an allowed domain. DNS and
loopback remain usable. Declaring a published port creates only the exact
corresponding ingress permission; host binding defaults to loopback. Dynamic
host ports are exposed only if the pinned SDK supports them and the allocated
port is inspectable.

Invocation-time additions are explicit resolved creation overrides. Exec calls
cannot widen policy. Secret interception allowed-hosts do not grant network
access. Docker build networking remains the host Docker daemon's concern.

## Secrets

Ordinary environment and build arguments may be literal or externally
referenced and are treated as sensitive in logs when externally resolved.
Secret values resolve from invocation, environment, or explicit files before
mutation; all missing references are accumulated when possible.

Microsandbox interception is exposed only as external value, guest placeholder,
and allowed destinations. Advanced injection/TLS knobs are deferred. Build
secrets use BuildKit secret IDs and files. Secrets never enter identities,
archives, logs, JSON inspection, cache, command arguments, or diagnostics.

Remote use over plain HTTP is permitted and explicitly documented as
unencrypted.

## Processes and PTY

Exact argv is primary; guest shell interpretation is explicitly named and uses
the configured guest shell (default `/bin/sh`). Per-exec cwd, environment,
user/root, timeout, byte/string stdin, and cancellation do not mutate profile
defaults.

Streaming uses typed started/stdout/stderr/exited events and byte-oriented
backpressured stdin with explicit EOF. Collection is UTF-8 convenience over
bytes and defaults to separate 10 MiB stdout/stderr limits; overflow terminates
the process with a typed error. Guest non-zero exit remains a result.

PTY supports arbitrary streams, resize, cancellation, and merged output. The
pinned SDK's high-level attach API is terminal-bound, so one isolated internal
adapter may use its low-level agent protocol. It is pinned, contract-tested,
never exported, and should be replaced by a stable upstream API when available.

No process intentionally survives its controlling execution/interactive
stream.

## Transfer

The public API copies files or directories in both directions. Sandcastle maps
only its required recursive `copyIn` and single-file `copyFileOut`.

Client-side walks validate relative names, archive safe symlinks without
following them, preserve executable bits, reject devices/sockets and escaping
links, and stream bounded archives for remote operations. Guest-side extraction
and host publication repeat validation. File publication replaces explicitly
named destinations atomically where practical; ambiguous file/directory
conflicts fail.

Microsandbox's single-file primitives are used where possible. Recursive
transfer is an `sbox` helper, not a watcher or synchronization engine.

## Remote security and protocol

- One bearer token authorizes the complete trusted-host API.
- Every non-health HTTP request and WebSocket upgrade authenticates.
- Health reveals only liveness and integer protocol version.
- The authenticated handshake returns protocol version and capabilities.
- Incompatible versions fail; pre-1 releases do not carry parallel protocols.
- Loopback is the default bind, but explicit non-loopback HTTP is allowed.
- External TLS/private networking is the operator's responsibility.
- The server enforces configurable request/archive/output/concurrency/duration
  bounds in memory; these are not durable user quotas.
- Graceful shutdown stops intake, cancels controlled processes/builds, waits a
  bounded interval, and leaves ordinary sandboxes untouched.

## Errors, inspection, and logging

The stable error-code union covers validation, capability, not-found,
already-exists, busy, ownership conflict, authentication, protocol, transport,
cancellation, timeout, output limit, native state, and internal failures.
Unknown future native states are preserved in inspection rather than coerced.

Inspection is a stable redacted DTO containing safe identity, labels projected
into product concepts, state, supported creation settings, mounts, and safe
native metadata. It exposes no SDK objects.

Libraries are silent unless passed a logger. CLI/server install structured
redacted loggers containing level, operation, safe IDs, duration, and result
code—not commands, environment values, secret-bearing paths, or payloads.

## Dependencies and platforms

Use exact-pinned Microsandbox 0.6.6 initially, including an isolated TypeScript
7 declaration patch if still required. Prefer Node platform APIs and focused
libraries: TypeScript, Vitest, Oxfmt, Oxlint, Zod, YAML, `ws`, a small CLI
parser, Docker CLI, and `qemu-img`. Select a small cross-platform OS-released
file-lock implementation only for the per-base integrity lock.

`pnpm check` uses deterministic fakes/fixtures and requires no network, Docker,
`qemu-img`, or virtualization. Separate acceptance suites prove local and
remote lifecycle, build/load, QCOW2, default-deny networking, process/PTY,
transfer, and Sandcastle on Windows, macOS, and Linux. Client-only support is
reported independently when a platform cannot host Microsandbox.
