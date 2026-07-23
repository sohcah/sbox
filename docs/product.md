# Product

## Purpose

`sbox` makes Microsandbox convenient for developer tooling and coding agents.
It provides three things:

1. A project configuration describing reusable sandbox profiles.
2. Automatic preparation of profile images from Containerfiles or OCI
   references.
3. The same small client interface against local Microsandbox or a remote
   `sbox serve` process.

It should feel like a thin, Compose-like layer over Microsandbox rather than an
independent runtime or control plane.

## Primary workflows

### Configure a project

A project contains `sbox.yaml` with named profiles. A profile selects an image
and the Microsandbox creation settings that `sbox` supports deliberately.

### Create and use a sandbox

The client resolves a profile, ensures its image is available on the selected
host, calls the Microsandbox SDK, and returns a handle. The handle exposes
Microsandbox lifecycle and execution capabilities without maintaining a second
lifecycle model.

### Work remotely

The same resolved request can be sent to an authenticated `sbox serve`
process. The server validates host-facing input and invokes the same host
module used locally.

### Build images automatically

For a build-backed image, the client packages the configured context and the
selected host builds and loads it into Microsandbox. A deterministic
non-secret identity may avoid rebuilding identical inputs. A failed build is
retryable; it is not represented as a durable workflow.

## Intended users

- Developers who want repeatable Microsandbox profiles.
- Tools that need a small programmatic sandbox interface.
- Coding-agent systems, including an optional Sandcastle adapter.
- A developer using their own trusted remote machine.

## Product principles

- Microsandbox is authoritative.
- Prefer delegation to durable bookkeeping.
- A command should normally perform one understandable workflow.
- Local and remote behavior share one host interface.
- Configuration describes intent; it does not mirror every SDK option.
- Failed work should usually be safe to retry.
- Temporary resources are operation-scoped and cleaned best-effort on startup
  and completion.
- Add persistent state only when a demonstrated feature cannot be implemented
  safely without it.

## First-release capabilities

- Strict project configuration and profile resolution.
- Local and remote targets.
- Image references and Containerfile-backed automatic image preparation.
- Create, get, list, start, stop, remove, and inspect.
- Exact-argv process execution, streaming, cancellation, and optional PTY when
  supported by the pinned SDK.
- Explicit file and directory transfer needed by ordinary clients and
  Sandcastle.
- API-key-authenticated remote operation.
- Actionable capability diagnostics.
- Optional Sandcastle adapter after the general interface is stable.

## Success criteria

- A new contributor can explain the complete architecture in a few minutes.
- A local lifecycle operation is visibly a thin SDK delegation.
- Remote operation adds transport, not a second execution model.
- There is no product database in the first release.
- Unit checks require no Docker, network, or virtualization.
- Focused acceptance proves the pinned SDK on Windows, macOS, and Linux.

