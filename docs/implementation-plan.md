# Implementation plan

## Objective

Deliver `@sohcah/sbox`, the `sbox` CLI, and
`@sohcah/sbox-sandcastle` as the smallest complete implementation of
`product.md` and `system-plan.md`.

Each phase is a reviewable vertical chunk. Later phases may deepen existing
interfaces but must not replace Microsandbox authority with durable workflow
state. At the end of the final phase, every agreed capability and non-goal is
enforced by code, tests, or explicit platform evidence.

## Working rules

- Complete and review one phase before beginning the next.
- Keep the public API usable independently of YAML, CLI, remote transport, and
  Sandcastle.
- Use one Host contract for local and remote implementations.
- Prefer pinned native behavior and exact inspection to speculative adapters.
- New persistence, background work, general locking, repair, or reconciliation
  requires revisiting the system plan.
- Unit checks require no Docker, network, `qemu-img`, virtualization, or
  Microsandbox runtime.
- Real acceptance is separate, explicit, and retained as platform evidence.
- Every phase updates the relevant docs and compatibility fixtures rather than
  deferring documentation to the end.

## Phase 1: Workspace, public contracts, and native lifecycle

Establish the package boundaries and prove the smallest real SDK seam before
adding product policy.

Implement:

- pnpm workspace with `packages/sbox` and `packages/sbox-sandcastle`;
- Node.js 24+ ESM, TypeScript, Vitest, Oxfmt, Oxlint, build and `pnpm check`;
- exact-pinned Microsandbox 0.6.6 and an isolated TypeScript 7 declaration
  patch if upstream declarations still require it;
- application-owned IDs, inspection DTOs, capability DTOs, process results,
  structured log events, and discriminated errors with internal causes;
- a deliberately small Host lifecycle contract: create/get/list/inspect,
  start/stop/remove, and capability probe;
- local Microsandbox adapter with deterministic names and reserved ownership,
  project, instance, and profile labels;
- attached-handle stop → consume/detach → fresh lookup behavior;
- exact uncertain-create reinspection and ownership-conflict handling;
- fake Host for contract tests, not a repository or lifecycle simulator;
- idempotent client/transport disposal that never changes resources.

Tests and evidence:

- Host lifecycle contract against fake and local adapters;
- native-name length/collision fixtures and reserved-label conflicts;
- uncertain create, already exists, not found, unknown state, and retry cases;
- public-declaration leak checks for both packages;
- structured logger redaction and silent-library tests;
- real local create/inspect/stop/detach/get/start/remove spike using a short
  disposable `MSB_HOME`.

Exit condition: a typed script can manage one real image-referenced sandbox
locally with no YAML, Docker, QCOW2 helper, HTTP, or product database.

### Phase 1 implementation notes

- Workspace packages are `@sohcah/sbox` and `@sohcah/sbox-sandcastle`.
- Pinned `microsandbox@0.6.6` still needs the isolated TypeScript 7
  `SecretBuilder.env(var: string)` declaration patch; see `patches/README.md`.
- Native names use `sbox-{readable}-{sha256[:16]}` derived from project +
  instance, capped at 128 UTF-8 bytes.
- Reserved labels use the `dev.sohcah.sbox/*` keys for managed / project /
  instance / profile. Names are never ownership evidence.
- Persisted `SandboxConfig` for this pin is decoded from the exact
  `image.Oci.reference` / `resources.*` / `runtime.*` / `env[{key,value}]`
  shape returned by `Sandbox.builder(...).build()`.
- Immutable creation matching uses a reserved
  `dev.sohcah.sbox/creation` fingerprint so SDK-injected environment
  values (such as `PATH`) cannot cause false ownership conflicts.
- Stopping a running sandbox acquires a live SDK object, then
  stop → detach/consume → fresh `get` before inspect/restart/remove.
- Ordinary unit checks use `FakeHost` and `LocalHost` over an in-memory native
  seam. Real create/inspect/stop/detach/get/start/remove acceptance is
  `pnpm test:acceptance` and requires a Microsandbox-capable host plus a short
  disposable `MSB_HOME`.

## Phase 2: Strict configuration, client workflows, and lifecycle CLI

Add portable project intent and the normal named-sandbox experience while
keeping `up` deliberately non-reconciling.

Implement:

- strict version-1 typed configuration and `sbox.yaml` adapter;
- upward discovery, explicit paths, config-relative path resolution, accumulated
  errors, unknown-field rejection, and default-profile selection;
- stable project slug, complete profiles, no inheritance/interpolation, and
  reusable volume declarations as schema placeholders for Phase 6;
- profile fields for image reference, CPU, memory, workdir, user, shell,
  hostname, environment, native max/idle durations, and internal labels;
- structured external references for environment and secrets with all missing
  references reported before mutation;
- user target configuration and precedence: invocation, project target, user
  default, local;
- `SboxClient` typed-config entrypoint and YAML convenience entrypoint;
- strict `create`, strict `get`, project-filtered `list`, `up`, and `recreate`;
- default instance per profile plus explicit portable instance names;
- explicit handle inspect/start/stop/remove; removal does not touch images or
  bases;
- CLI framework and `init`, `config validate/show`, `up`, `list`, `inspect`,
  `stop`, and `remove` with consistent text/JSON results and exit codes.

Tests and evidence:

- configuration matrix covering paths, defaults, external references,
  ambiguity, unknown keys, schema versions, and redaction;
- client workflow contract against fake Host, including creation-setting drift
  reporting and explicit recreation;
- CLI runner tests with no process exit/console coupling;
- proof that config/profile resolution creates no lifecycle catalog;
- real local image-reference `up` idempotence and named restart acceptance.

Exit condition: `sbox up <profile>` is a thin configuration-to-SDK workflow
with stable programmatic equivalents and no automatic image building yet.

### Phase 2 implementation notes

- Typed `ProjectConfig` is primary; `sbox.yaml` is a strict adapter with human
  `memory` / `maxDuration` / `idleTimeout` sugar normalized into MiB/seconds.
- External values use `{ env }`, `{ file }`, or `{ invocation }` references;
  all missing references are accumulated before Host mutation.
- Volume declarations are accepted as Phase 6 schema placeholders only.
- Target precedence is explicit invocation → project `target` → user
  `defaultTarget` → local. Remote targets parse and resolve credentials but
  fail with a capability error until Phase 7.
- `SboxClient.up` is create-if-absent / start-if-stopped / success-if-running
  and reports inspectable creation drift without reconciling.
- Default instance identity equals the profile slug; `--instance` / API
  `instance` overrides remain portable slugs.
- Host create/inspect now carry native `maxDurationSecs` / `idleTimeoutSecs`.
- CLI runner is process-exit free for tests; documented exit codes cover
  validation, ownership/drift, not-found, and already-exists.
- Real local image-reference `up` acceptance is
  `packages/sbox/test/up.acceptance.test.ts` under `pnpm test:acceptance`.

## Phase 3: Local execution, PTY, and transfer

Complete the general local handle needed by developer tools before building the
Sandcastle adapter.

Implement:

- exact-argv collected and streaming execution;
- explicit guest-shell collected and streaming execution using profile shell;
- string/byte collected stdin, backpressured streaming stdin, explicit EOF,
  cwd, environment, user/root, timeout, and `AbortSignal`;
- byte-oriented started/stdout/stderr/exited events and UTF-8/line helpers;
- default configurable 10 MiB-per-stream collection bounds;
- non-zero exit as result; cancellation, timeout, and overflow as distinct
  errors;
- interactive PTY session with arbitrary streams, cancellation, resize, and
  merged output;
- isolated pinned low-level agent-protocol adapter only where the SDK's stable
  high-level terminal API cannot satisfy arbitrary streams;
- recursive host/guest transfer built over native single-file primitives and
  bounded safe archives where needed;
- traversal, file/directory conflict, executable-bit, safe-symlink, special-file,
  overwrite, and atomic-publication behavior;
- CLI `exec` and `shell`, including guest exit-code propagation and NDJSON live
  events.

Tests and evidence:

- exact argv versus shell quoting, binary output, split UTF-8/line chunks,
  stdin larger than command-line limits, non-zero exits, limits and cleanup;
- stream backpressure, timeout, abort, disconnect simulation, and terminal resize;
- byte-faithful file/directory round trips; escaping symlink, traversal, special
  file, overwrite, cancellation, and partial-publication rejection;
- low-level PTY protocol compatibility fixture isolated from public declarations;
- real local exec/stream/shell/PTY/resize/transfer acceptance.

Exit condition: the local API is independently useful and contains every
process/transfer primitive later required by remote transport and Sandcastle.

### Phase 3 implementation notes

- Host gained `execArgv` / `execArgvStream` / `execShell` / `execShellStream` /
  `pty` / `copyHostToGuest` / `copyGuestToHost`. Public handle methods delegate
  through Host; native handles stay private and are freshly connected per op.
- Exact argv uses Microsandbox `execStreamWith` + `ExecOptionsBuilder`
  (`cwd` / `user` / `env` / `timeout` / `stdinPipe`). Guest shell is always
  explicit argv `[shell, "-c", script]` (default `/bin/sh`).
- Collection bounds default to 10 MiB per stream via `DEFAULT_OUTPUT_LIMIT_BYTES`.
- Interactive PTY uses a private agent-protocol adapter over `AgentClient`
  (`core.exec.request` with `tty: true`, empty stdin = EOF, resize via
  `core.exec.resize`). Documented in `patches/README.md` with upstream
  replacement condition. Protocol generation for 0.6.6 is `v: 6`.
- Transfer walks host/guest trees over `copyFromHost` / `copyToHost` /
  `read` / `write` / `list` / `stat`, plus private agent FS helpers for
  `Symlink` / `ReadLink` / `SetStat` (not exposed on the Node `SandboxFsOps`
  wrapper). Trees are prevalidated, staged beside the destination on the same
  filesystem, and published by rename/swap; `overwrite: "replace"` replaces
  rather than merges. Archive validation helpers remain internal in
  `transfer/archive.ts` for future remote packages.
- Streaming sessions use a bounded pull-driven event/output queue (default
  capacity 64). Callers must consume events or cancel; `wait()` does not drain.
  Caller stdin/input iterators are owned and closed on settlement so cleanup
  never hangs on a pending `next()`.
- PTY honors `timeoutMs` with a distinct `timeout` error (separate from
  `cancel`).
- CLI: `sbox exec [profile] -- <argv...>` and `sbox shell [profile] -- <script>`
  with `--stream`, `--cwd`, `--user`, guest exit-code propagation, and NDJSON.
- Real process/PTY/transfer acceptance:
  `packages/sbox/test/process.acceptance.test.ts` under `pnpm test:acceptance`
  with an isolated short disposable `MSB_HOME`.

## Phase 4: Content-addressed automatic images

Add the core Docker-Compose-like convenience without an image database or
cross-process workflow lock.

Implement:

- mutually exclusive existing-image and Dockerfile-backed profile definitions;
- context root, default/explicit in-context Dockerfile, optional target,
  ordinary build arguments, BuildKit secret references, and host architecture;
- Docker-compatible ignore handling, Dockerfile-specific ignore behavior where
  supported, default `.git` exclusion with explicit inclusion, safe symlinks,
  and special-file rejection;
- deterministic packaging and identity over algorithm version, normalized
  recipe, platform, paths, types, bytes/link targets, and executable bits;
- generated native image naming and reserved identity evidence validation
  (OCI labels when present; ENV-only when labels are wholly absent after load);
- exact native existence check, in-process coalescing, ordinary reuse, and
  explicit force behavior;
- Docker CLI build using ordinary Docker cache, owner-only BuildKit secret
  files, structured live progress, export, and direct Microsandbox load;
- unique marked operation workspaces and `finally` cleanup;
- explicit image list/removal and read-only stale-workspace diagnostics; no
  automatic GC, registry, or durable failed-build record;
- automatic `up` build when the exact required image is absent;
- CLI `build`, `image list`, and `image remove`.

Tests and evidence:

- deterministic identity/archive fixtures across timestamps and host paths;
- ignore semantics, `.git` opt-in, symlink escape, executable bit, build args,
  algorithm-version invalidation, and generated-name conflicts;
- secret canaries absent from identity, context, argv, progress, logs,
  diagnostics, and workspaces;
- concurrency within one process and uncoordinated native conflict behavior
  across fake processes;
- cancellation, Docker failure, load failure, retry, force, and exact cleanup;
- real Docker build/export/load/reuse/up acceptance, including offline reuse.

Exit condition: a build-backed profile automatically becomes a usable local
Microsandbox image without a registry or authoritative cache.

### Phase 4 implementation notes

- Profiles are mutually exclusive: `image` (existing OCI/native ref) or `build`
  (`context`, optional in-context `dockerfile` defaulting to `Dockerfile`,
  optional `target` / `args` / BuildKit `secrets` / `includeGit`).
- Context discovery uses the exact-pinned `ignore@7.0.5` matcher for
  `.dockerignore` and Dockerfile-specific `*.dockerignore`, excludes `.git` by
  default, records safe relative symlinks without following them, and rejects
  absolute/escaping links and special files.
- Identity algorithm version `1` hashes recipe bytes, platform, target, ordinary
  args, secret ids (never values), selected paths/kinds/bytes/link targets, and
  permission bits (`mode & 0o777`). Absolute paths and timestamps are excluded.
- Generated native refs are `sbox-img:sha256-<64-hex>`. Ownership requires
  reserved identity evidence. **Product decision (Phase 4 amendment):** stamp
  both reserved OCI labels and reserved ENV (`DEV_SOHCAH_SBOX_*`) after Docker
  build. After load, complete ENV-only ownership is accepted only when reserved
  OCI labels are entirely absent (compatibility with Microsandbox `0.6.6`
  `msb image load`, which drops labels but preserves ENV). Any present reserved
  label or ENV marker that is partial, mismatched, or contradictory fails
  closed. A matching tag is never ownership evidence. Unowned/mismatched
  natives at the generated ref are never deleted by ensure/force/remove.
- Host gained `ensureImage` / `listImages` / `removeImage` /
  `listStaleImageWorkspaces`. Builds use Docker CLI argv (no shell), owner-only
  secret files, ownership stamp, `docker save`, and `msb image load --input
  --tag`. Progress is phase-only (no raw Docker lines); progress callbacks are
  observational. Workspaces are marked under `~/.sbox/image-workspaces` (or
  `SBOX_IMAGE_WORKSPACE_ROOT`); cleanup failures fail the operation rather than
  being swallowed.
- Identical concurrent builds coalesce in-process with per-subscriber progress
  and timeout; cancelling/timing out one waiter does not abort shared work while
  others remain. FakeHost uses the real discovery/identity path with an
  in-memory publish seam.
- `up` predicts the generated image identity without Docker mutation, looks up
  the sandbox first, and only ensures/builds when the sandbox is absent.
- CLI: `sbox build [profile] [--force]` (requires a `build:` profile) streams
  phase progress on stderr (NDJSON with `--json`); `sbox image list`,
  `sbox image remove <exact-image> [--force]`.
- Real acceptance: `packages/sbox/test/image.acceptance.test.ts` under
  `pnpm test:acceptance` (isolated `MSB_HOME` + workspace root; requires Docker
  and Microsandbox). Offline reuse is asserted by hiding `docker` on `PATH`
  after the first build.

## Phase 5: Default-deny networking and curated secrets

Complete the supported profile surface and demonstrate the security default.

Implement:

- network mode with hard-disabled or enabled/default-deny policy;
- outbound exact domain, domain suffix, exact IP, and CIDR rules;
- TCP/UDP destination ports/ranges and domain defaults of TCP 80/443;
- automatic DNS and loopback availability without general outbound bypass;
- explicit published TCP/UDP ports, loopback host binding by default, exact
  corresponding ingress, and capability-gated dynamic host ports;
- explicit creation-time additional allow rules; no per-exec widening;
- curated Microsandbox secret interception: external value, guest placeholder,
  and allowed destinations;
- independent secret-host and network authorization validation;
- network/port/secret representation in safe resolved configuration and
  inspection DTOs.

Tests and evidence:

- default deny, full disable, domain/suffix boundaries, IP/CIDR, protocol/port
  restrictions, DNS, loopback, ingress publication, and dynamic capability;
- contradiction and invocation-override validation;
- proof that secret authorization does not grant network access;
- secret-canary scans across inspection, errors, JSON, and logs;
- real local allowed/blocked outbound and published-port acceptance.

Exit condition: an unconfigured sandbox has no external network access, while
profiles can grant only the agreed destinations and ports.

**Status (implemented):** Curated profile `network` / `secrets`, Host create
wiring through Microsandbox `NetworkBuilder`, FakeHost dynamic ports for unit
tests, LocalHost `dynamicHostPorts: false` on Microsandbox 0.6.6 (host `0` is
not inspectable), safe inspection DTOs, unit coverage (validation, compile,
decode round-trip / fingerprint parity, independence, canaries), compatibility
fixtures including a real network-configured sandbox config, and
`network.acceptance.test.ts` for deny/allow/explicit publish against a real
runtime. Decode fails closed when enabled networking lacks deny/deny policy
defaults. Ownership fingerprints expand allow rules per protocol so create →
inspect → `up` drift stays stable.

## Phase 6: Managed base QCOW2 volumes

Implement the one-base/direct-child model and its narrowly justified safety
boundary without generalizing it into a storage control plane.

Implement:

- project-scoped deterministic managed base and child paths outside
  Microsandbox sandbox directories;
- QCOW2/ext4 volume definitions with logical size and profile attachment paths;
- capability checks for host `qemu-img` only when volumes are used;
- pinned formatter image containing `mkfs.ext4` and portable guest-side raw
  formatting;
- temporary base creation, validation, conversion, and atomic final publication;
- deterministic direct child creation and `qemu-img info` validation of format,
  virtual size, and exact backing path;
- child attachment through the pinned SDK and recovery of child paths from
  persisted native sandbox configuration;
- exact overlay cleanup after native removal and retry when native state is
  already absent;
- a small cross-platform OS-released exclusive lock scoped per base only;
- descendant inspection across running and stopped owned native sandboxes;
- deterministic attached/non-ephemeral maintenance sandbox using the selected
  profile and mounting the base directly;
- crashed-maintenance recovery via exact native labels/config, stop,
  detach/consume, fresh lookup, verification, and removal;
- fail-closed busy/conflict behavior for mismatched identities or unresolved
  native disk locks;
- explicit base list/shell/remove; refusal to mutate/remove/resize a base with
  descendants; no repair, versions, snapshots, or broad cleanup;
- CLI `volume list`, `volume shell <profile> <volume>`, and `volume remove`.

Tests and evidence:

- exact managed-path containment, ownership labels, base/child validation,
  wrong backing path, size mismatch, and conflicting files;
- atomic creation crash windows and cleanup;
- per-base lock exclusion, OS/process-death release, unrelated-base concurrency,
  and proof no lifecycle/image operation uses the lock;
- maintenance refusal with running/stopped children and concurrent child race;
- simulated owner death, persisted maintenance recovery, native-busy retry, and
  stop/detach/fresh-get/remove sequence;
- uncertain create/remove overlay cleanup without journals;
- real Windows, macOS, and Linux formatting/child isolation/pre-seed/reload/
  cleanup acceptance as hosts become available.

Exit condition: ordinary sandboxes receive disposable child writes and an
exclusive maintenance shell can intentionally update one shared base without a
volume database or lineage manager.

## Phase 7: Remote Host and foreground server

Make transport the only difference between local and remote clients.

Implement:

- integer protocol version, authenticated capability handshake, and stable
  protocol DTO validation;
- native HTTP server with minimal unauthenticated health;
- bearer authentication for every other request and WebSocket upgrade;
- JSON lifecycle/inspection/image/volume routes;
- bounded streaming build and transfer bodies;
- WebSocket execution, stdin, typed output, cancellation, PTY, and resize;
- `RemoteHost` satisfying the complete Host contract;
- client-side project/external-reference resolution; server imports no YAML
  profile logic;
- server-side image building and managed QCOW2 resources using the same Host
  modules as local operation;
- disconnect cancellation for controlled processes and completion/reinspection
  semantics for lifecycle operations;
- configurable request/archive/output/concurrent build/process/duration limits;
- loopback default bind, explicit non-loopback HTTP, credential references,
  unencrypted-HTTP diagnostics, and minimal health disclosure;
- redacted structured server logs and bounded graceful shutdown leaving
  ordinary sandboxes intact;
- CLI `serve`, target selection, and remote-aware `doctor`.

Tests and evidence:

- run the entire Host contract against a real authenticated server subprocess;
- authentication on routes/upgrades, protocol/capability mismatch, health
  disclosure, body limits, and malformed payloads;
- HTTP/WebSocket backpressure, cancellation/disconnect, resize, and graceful
  shutdown;
- verify project YAML modules and lifecycle catalogs are absent from server;
- real remote image build/load, restricted networking, QCOW2, process/PTY, and
  bidirectional directory transfer acceptance.

Exit condition: changing the selected target changes transport only; all stable
client and handle behavior remains the same.

## Phase 8: Sandcastle adapter and complete CLI workflows

Implement the bounded integration only after the general API proves all of its
requirements.

Implement `@sohcah/sbox-sandcastle`:

- factory accepting an existing `SboxClient`, profile, and optional worktree
  path (default `/workspace`);
- unique owned sandbox creation using the chosen profile;
- required shell `exec` with cwd, root/sudo, string stdin, collected result,
  and genuinely live callbacks derived incrementally from both streams;
- interactive argv execution using arbitrary Node stdin/stdout/stderr, PTY
  detection/resize behavior, merged output to stdout, and exit status;
- recursive `copyIn`, single-file `copyFileOut`, absolute `worktreePath`;
- idempotent `close` mapped to exact removal and child cleanup;
- normal-cleanup guarantees and documented crash leftovers;
- Sandcastle peer dependency and no Sandcastle dependency in core.

Finish CLI workflows:

- `run` creates a unique sandbox, executes, and removes in `finally`, preserving
  primary and structured cleanup failures;
- guest exit-code propagation and documented operational exit codes;
- consistent text, single-result JSON, and live NDJSON output;
- read-only `doctor`, plus explicit acceptance mode;
- exact destructive commands with warnings but no prompts or prune behavior.

Tests and evidence:

- compile-time fixture against the current Sandcastle provider contract;
- exec line timing/partial-line/stdin/sudo/cwd behavior;
- interactive stream, PTY, resize, cancellation, and merged stderr behavior;
- file/directory copy semantics and idempotent close/already-absent cleanup;
- real local and remote Sandcastle runs, including a volume-backed profile;
- CLI `run` success, guest failure, operation failure, abort, and cleanup failure.

Exit condition: Sandcastle consumes only the stable `sbox` API and its complete
isolated provider works locally and remotely.

## Phase 9: Hardening, documentation, and `0.1.0` certification

Audit the complete system rather than adding new capabilities.

Implement and verify:

- final `README`, API reference, CLI reference, configuration schema/examples,
  Sandcastle setup, remote deployment, networking guidance, QCOW2 safety,
  prerequisites, troubleshooting, and explicit non-goals;
- sample local and remote projects with default-deny rules and optional volume;
- stable public exports, package metadata, versioning, licenses, and publishing
  dry run for both packages;
- configuration, deterministic image, archive, protocol, PTY compatibility, and
  declaration-leak fixtures checked into the repository;
- secret-canary scans across logs, errors, JSON/NDJSON, build contexts,
  workspaces, archives, remote messages, and diagnostics;
- read-only `doctor` coverage for Node, Docker, `qemu-img`, Microsandbox,
  formatter image, target auth, protocol, and local-host versus remote-client
  capability;
- a feature inventory mapping every public behavior to delegation, bounded
  helper, or deliberate exclusion;
- repository audit proving absence of SQLite/ORM/migrations, workflow journals,
  durable claims, general locks, repair/adoption, background schedulers,
  detached-process support, sync/watch, telemetry, and automatic pruning.

Certification matrix:

- `pnpm check` is deterministic and green without external host tools;
- Windows, macOS, and Linux record local-host evidence where Microsandbox is
  supported and remote-client evidence independently;
- local and remote lifecycle, automatic build/reuse, default-deny/allowed
  networking, file/directory transfer, collected/streaming/shell/PTY execution,
  cancellation, published ports, QCOW2 create/child/pre-seed/recovery/remove,
  and Sandcastle all pass;
- non-loopback HTTP behavior and its unencrypted-data warning are documented and
  acceptance-tested;
- no final public declaration leaks SDK-native or low-level protocol types.

Exit condition: publishable `0.1.0` implements the entire product/system plan,
all exclusions remain true, and the architecture is still accurately described
as a small configured layer over Microsandbox.

## Explicitly later, not incomplete work

The following require new product decisions rather than being inferred from
this plan:

- versioned/snapshotted QCOW2 bases or retained sandbox layers;
- automatic sandbox expiry/cleanup beyond delegated native timeouts;
- multi-tenant hosting, users, roles, or quotas;
- service installation or built-in TLS;
- cross-process image-build coordination;
- private-registry/advanced SDK network and secret configuration;
- arbitrary host binds, native handle escape, or SDK pass-through options;
- detached process supervision or filesystem synchronization;
- Podman/pluggable builders, cross-architecture images, or automatic pruning.
