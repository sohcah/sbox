# Minimal system plan

## Status

Initial architectural reset. This document intentionally specifies less than
the predecessor plans. Unknowns discovered during implementation should be
resolved against the product principles rather than filled with speculative
infrastructure.

## Architecture

```text
Project config ──► client ──► Host interface ──► Microsandbox SDK
                      │               ▲
                      │               │
                      └─ HTTP/WS ─► remote host
```

There are four primary modules:

### Configuration

Loads and validates project and target configuration, then resolves a named
profile into a transport-safe sandbox request. Secrets remain separate from
inspectable resolved configuration.

### Client

Provides the supported public interface. It chooses a local or remote adapter,
packages client-local build/transfer inputs, and returns sandbox handles.

### Host

The central deep module. It accepts validated host requests, ensures required
images, and delegates lifecycle, process, and transfer operations to the
Microsandbox adapter. Local clients call it directly; the remote server calls
the same module after protocol validation.

### Remote transport

Maps the host interface to authenticated HTTP and WebSocket operations.
Transport handles serialization, bytes, cancellation, and backpressure. It
does not implement lifecycle or image policy.

An optional Sandcastle adapter uses the public client interface and owns only
the mapping required by Sandcastle.

## Authority and state

Microsandbox is authoritative for:

- Sandbox existence and identity.
- Running/stopped state.
- Sandbox inspection.
- Processes and their output where the SDK provides them.
- Native image availability.

`sbox` may retain only:

- User and project configuration.
- Rebuildable image-cache metadata when the SDK cannot answer whether a
  content-addressed image is already loaded.
- Operation-scoped temporary files.

Cache metadata is an optimization, never proof that a sandbox or image exists.
It may be deleted without damaging managed sandboxes. Prefer a small
atomic JSON cache or derivation from deterministic image references; do not add
a database merely for caching.

## Identity

Each create request receives a stable client-generated ID before the SDK call.
The native Microsandbox name derives deterministically from that ID. Human
profile names are configuration concepts, not a second host-wide sandbox
identity system.

If create returns an uncertain failure, inspect the deterministic native name:

- Present and matching the requested identity: return/open it.
- Absent: report the failure and allow retry.
- Present but inconsistent: fail safely and require explicit native cleanup.

Use supported Microsandbox labels or metadata when available, but do not build
a separate ownership catalog solely to duplicate them.

## Concurrency

The remote host is one foreground process. It may use in-memory keyed mutexes
to avoid conflicting work within that process, especially duplicate image
builds.

Embedded local callers do not coordinate through durable locks. Concurrent
conflicting processes may receive native busy/already-exists errors and
reinspect Microsandbox. The product does not promise automatic recovery from
two unrelated local CLI processes racing.

No SQLite leases, PID probes, fencing tokens, or stale-lock reclamation are
part of the first release.

## Sandbox lifecycle

The host adapter maps directly to pinned Microsandbox SDK operations:

- `create`
- `get`
- `list`
- `start`
- `stop`
- `remove`
- `inspect`

The public handle must not imply stronger durability than the SDK provides.
After stopping a live SDK object, the adapter performs the proven detach/
consume sequence before later lookup/start so native disk locks are released.

Removal uses an exact ID/native name. Broad prefix or prune deletion is never
used.

## Images

Profiles select either:

- An existing OCI/native image reference.
- A Containerfile, build context, optional target, ordinary build arguments,
  and separately supplied build secrets.

For build-backed images:

1. Package a deterministic, `.dockerignore`-filtered context.
2. Compute an identity from non-secret build inputs.
3. Address the host image using that identity.
4. If the exact image is already available, reuse it.
5. Otherwise build with Docker, export, and load through the Microsandbox
   SDK/native capability.
6. Clean the operation workspace in `finally`.

No durable build workflow is recorded. An interrupted build may leave a
workspace with an `sbox-` marker under the dedicated temporary root; startup
may remove only marked directories from prior processes. Retry performs a
fresh exact-image check.

Build secrets never enter the context identity, archive, argv, logs, cache, or
diagnostics.

## Processes

One process model supports collected and streaming execution. Requests use an
executable plus exact argument vector; shell interpretation is explicit.
`AbortSignal` represents caller cancellation.

PTY support and detached-process management are exposed only to the extent the
pinned SDK provides stable identity and behavior. Do not reproduce
Microsandbox process persistence or logs.

## Transfer

Transfer is explicit, one-shot, and bounded:

- Client packages files/directories with traversal and escaping-symlink checks.
- Remote requests stream bytes rather than base64.
- Host extraction occurs in an operation workspace.
- Destination publication is exact and as atomic as the target operation
  permits.

There is no synchronization engine.

## Remote protocol

- JSON request/response for lifecycle and inspection.
- Streaming HTTP bodies for archive transfer.
- WebSocket for interactive/streaming processes when required.
- Bearer API key on every non-health route and upgrade.
- Protocol version and capability negotiation.
- Bounded output and WebSocket backpressure.

The server is a thin adapter over the Host interface. It must not depend on
project YAML or maintain a second resource catalog.

## Errors and logging

Expose a compact typed error set that maps validation, capability, native
not-found/already-exists/busy, authentication, transport, cancellation, and
internal failures. Guest non-zero exit is a process result.

Logs contain operation names, safe native identity, duration, and result code.
Never log request contents, environment values, secrets, transfer contents, or
Docker secret material.

## Platform support

Target Node.js 24+ and exact-pin one accepted Microsandbox SDK/runtime version.
Unit and contract tests are deterministic. Separate acceptance runs prove
local lifecycle, image preparation, process behavior, transfer, and remote
operation on Windows, macOS, and Linux.

Known evidence to retain:

- `MSB_HOME`, not `MICROSANDBOX_HOME`, controls disposable SDK state.
- Keep disposable macOS runtime paths short because of Unix socket limits.
- A stopped live SDK object must be detached/consumed before fresh lookup and
  restart when attached disks are involved.
- Microsandbox 0.6.6 declarations require a TypeScript 7 parameter-name patch
  until fixed upstream.

## Dependency posture

Start with the platform and focused libraries:

- TypeScript, Vitest, Oxfmt, and Oxlint.
- Zod and YAML for configuration/protocol validation.
- Pinned Microsandbox SDK.
- Native Node HTTP/fetch/streams and `ws` if remote process channels require
  WebSocket.
- A small CLI parser behind an application-owned runner.

Do not add SQLite, an ORM, a migration framework, a workflow engine, or a lock
package without revising this plan.

