# Implementation plan

## Objective

Implement the smallest reliable layer over Microsandbox that provides project
configuration, automatic images, and remote operation. Each phase must preserve
the authority model in `system-plan.md`: Microsandbox owns runtime state and
`sbox` does not grow a durable orchestration subsystem.

## Working rules

- Complete and review one phase before starting the next.
- Prefer a vertical, real-SDK slice over generalized infrastructure.
- New persistence, locking, background work, or recovery mechanisms require a
  design-plan change before code.
- Test through the same small interfaces used by callers.
- Unit checks remain independent of Docker, virtualization, and the network.
- Platform acceptance is explicit and never silently treated as a unit pass.

## Phase 1: Repository and Microsandbox seam

Create one TypeScript package with the root check pipeline and a deliberately
small Host interface.

Implement:

- Node 24+ ESM project, pnpm, TypeScript, formatting, linting, build, and
  Vitest.
- Exact-pinned Microsandbox dependency and the TypeScript declaration patch if
  the selected version still needs it.
- Core public result/error types without exporting SDK-native or internal
  transport types.
- `MicrosandboxHost` adapter for create/get/list/start/stop/remove/inspect.
- Deterministic native naming from a caller-generated sandbox ID.
- The proven stop → detach/consume → fresh lookup → start sequence.
- Fake Host adapter only because local and remote are two real adapters over
  the same interface; avoid repositories or lifecycle state machines.
- Capability probe reporting missing SDK/runtime support.

Tests and evidence:

- Contract tests for the Host interface.
- Declaration-leak test.
- Focused real SDK lifecycle acceptance on the available development host.
- Preserve short-`MSB_HOME` and exact cleanup rules in platform tests.

Exit condition: a small script can create, inspect, stop, restart, and remove a
real sandbox locally without configuration, HTTP, SQLite, or product state.

## Phase 2: Configuration and local client

Add project intent without changing the Host authority model.

Implement:

- Strict versioned `sbox.yaml` schema with actionable accumulated validation.
- Named profiles containing only settings supported by the initial Host
  interface.
- Local target and default-profile resolution.
- Typed in-memory configuration as the primary interface; YAML is one adapter.
- `SandboxClient` and `SandboxHandle` over Host.
- CLI commands for config inspection and the core lifecycle.
- Exact-argv execution if the SDK process seam is already stable; otherwise
  leave execution for Phase 4.

Tests and evidence:

- Configuration fixture matrix and path/reference errors.
- Client contract against the fake and real local Host adapters.
- CLI result/exit behavior.
- Proof that profile resolution does not create a lifecycle catalog.

Exit condition: `sbox create <profile>` is a thin, inspectable path from YAML to
one local Host workflow.

## Phase 3: Automatic image preparation

Add the Docker-Compose-like convenience that materially differentiates `sbox`.

Implement:

- Image reference and Containerfile-backed image definitions.
- Deterministic `.dockerignore`-aware context packaging.
- Content identity covering non-secret build inputs.
- Operation-scoped host workspace with an ownership marker.
- Docker build, archive export, and direct load through the pinned
  Microsandbox capability.
- Exact image-existence check before building.
- In-memory per-image coalescing inside one Host process.
- Build secrets through separate owner-only files and BuildKit secret flags.
- Cleanup in `finally`; conservative startup cleanup only for marked stale
  workspaces.
- Optional rebuildable atomic cache metadata only if exact native lookup cannot
  answer the reuse question.

Tests and evidence:

- Deterministic archive and identity fixtures.
- Traversal, escaping symlink, ignore, canary, cancellation, and cleanup tests.
- Real Docker build/load/create acceptance.
- Retry after an interrupted build without a durable operation journal.

Exit condition: a profile-backed sandbox automatically builds or reuses its
image locally, with no registry and no workflow database.

## Phase 4: Processes and transfer

Complete the general developer-tool handle before adding remote transport.

Implement:

- One exact-argv spawn model with collected and streaming output.
- Explicit shell helper rather than implicit command interpolation.
- AbortSignal cancellation and bounded collection.
- PTY and detached operations only where the SDK offers stable primitives.
- Explicit file/directory upload and download with safe archives and bounded
  streaming.
- Atomic destination publication where practical.

Tests and evidence:

- Byte fidelity, non-zero exit, cancellation, timeout, backpressure, archive
  traversal, symlink, overwrite, and cleanup contracts.
- Real process, PTY, and transfer acceptance on the development host.

Exit condition: the local public client is useful independently of Sandcastle
and contains no reimplementation of Microsandbox process persistence.

## Phase 5: Remote adapter and server

Expose the existing Host interface remotely without creating another host
model.

Implement:

- Foreground `sbox serve`.
- Bearer authentication and minimal unauthenticated health endpoint.
- Version/capability handshake.
- JSON lifecycle/inspection routes.
- Streaming archive routes.
- WebSocket process channel where required.
- Bounded buffering and disconnect cancellation.
- `RemoteHost` adapter satisfying the existing Host contract.
- Structured redacted logging and graceful intake shutdown.

Tests and evidence:

- Run the complete Host contract against a real authenticated server
  subprocess.
- Authentication, version mismatch, streaming backpressure, disconnect, and
  cancellation tests.
- Verify the server imports no project-YAML logic and persists no lifecycle
  catalog.

Exit condition: switching target from local to remote changes transport only;
client and handle behavior remain the same.

## Phase 6: Sandcastle, CLI finish, and platform certification

Add bounded integrations only after the general system is stable.

Implement:

- Optional Sandcastle adapter over `SandboxClient`/`SandboxHandle`.
- Remaining CLI ergonomics, `init`, `doctor`, JSON output, and documentation.
- Sample project and remote deployment guidance.
- Explicit feature inventory showing which Microsandbox capabilities are
  delegated, wrapped, or intentionally unsupported.

Certification:

- `pnpm check` is deterministic and green.
- Real local and remote lifecycle, automatic image, process, transfer, and
  Sandcastle acceptance on Windows, macOS, and Linux.
- Secret-canary scans of logs, archives, workspaces, and diagnostics.
- No SQLite/database dependency, migration module, durable claim table,
  generic repair subsystem, or background scheduler has appeared.

Exit condition: publishable `0.1.0` with recorded platform evidence and an
architecture still explainable as a thin Microsandbox layer.

## Later decisions, not implied work

The following require separate product/design decisions:

- Managed/versioned QCOW2 template volumes.
- Automatic sandbox expiry.
- Multi-tenant remote hosting.
- Cross-process local build coalescing.
- Persistent aliases independent of native identity.
- General native-resource adoption or repair.
- Continuous filesystem synchronization.

Their absence is not incomplete implementation of this plan.

