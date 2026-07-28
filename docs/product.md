# Product specification

## Purpose

`sbox` is the smallest useful layer over Microsandbox for developer tools and
coding agents. It provides:

1. Strict project configuration describing reusable sandbox profiles.
2. Automatic, content-addressed image preparation from Dockerfiles.
3. A general Node.js API and thin `sbox` CLI for local or remote operation.
4. A separate Sandcastle adapter implementing its isolated-sandbox provider.

Microsandbox remains authoritative for sandbox existence, lifecycle, runtime
state, processes, and native image availability. `sbox` supplies intent,
portable transfer, and bounded convenience workflows; it is not another
control plane.

## Packages and runtime

- `@sohcah/sbox` contains the public Node.js API and installs the `sbox` CLI.
- `@sohcah/sbox-sandcastle` adapts an already configured `SboxClient` to
  Sandcastle's `IsolatedSandboxProviderConfig`. It depends on
  `@sohcah/sbox` and declares Sandcastle as a peer dependency.
- Both packages live in one pnpm workspace and target Node.js 24+ ESM.
- Browsers and edge runtimes are not supported.

## Users and priorities

- Developers configuring repeatable local sandboxes.
- Developer tools using the programmatic API as the authoritative product
  surface.
- Sandcastle and similar coding-agent systems.
- A developer or trusted team operating a remote Microsandbox host.

When CLI convenience conflicts with composability, the public API wins. The
CLI is an adapter over that API, not a separate implementation.

## Primary workflows

### Configure a project

A strict, versioned `sbox.yaml` has an explicit stable project slug, reusable
volume definitions, an optional default profile, and complete named profiles.
Profiles do not inherit from one another and unknown fields are errors.

Configuration is also accepted as typed in-memory data; callers do not need to
write YAML. YAML discovery searches upward from the current directory and an
explicit path is supported. Relative paths resolve from the containing config
file.

### Ensure a named sandbox

`up(profile)` addresses a deterministic project-and-profile instance unless
the caller supplies another portable instance slug:

- absent: resolve/build the image, create the volume children, create and start;
- stopped: start;
- running: return success.

`up` is idempotent convenience, not reconciliation. Changed creation settings
are reported when cheaply inspectable and require explicit recreation. It does
not silently replace a sandbox.

Low-level `create` fails when the identity exists; `get` fails when it does
not. Handles expose explicit `start`, `stop`, and `remove`. There is no
lifecycle-changing `close` method. Disposal closes local connections only.

### Execute and transfer

The public handle supports:

- exact-argv collected and streaming execution;
- explicitly named guest-shell collected and streaming execution;
- arbitrary byte/string stdin, cwd, environment, user/root, timeout, and
  `AbortSignal` cancellation;
- interactive PTY execution with bidirectional streams and resize;
- explicit host-to-guest and guest-to-host file or directory copying.

Non-zero guest exit is a process result. Operational failures throw a compact
typed `sbox` error. Core streams preserve bytes; UTF-8 collection and live line
decoding are helpers. Collected stdout and stderr are bounded to 10 MiB each by
default. Remote stream disconnect cancels the controlled process; detached
background processes are not supported.

Transfers preserve bytes, directories, executable bits, and safe symlinks.
They reject traversal, escaping links, and special files; they do not preserve
ownership or timestamps and never become synchronization.

### Build images automatically

A profile selects exactly one of:

- a pre-existing OCI/native image reference delegated to Microsandbox; or
- a Dockerfile-backed build context.

Build inputs are filtered using Docker ignore semantics, packaged
deterministically, and identified by an algorithm version plus every non-secret
input. Missing exact images are built through Docker, exported, and loaded
directly into Microsandbox without a registry. `build --force` is explicit;
ordinary `up` reuses an exact image. Build failures leave no durable workflow.

Docker is required only for build-backed profiles. Builds always use the Host
machine's architecture (`dockerPlatform` from Host capabilities). Cross-architecture
builds, Podman abstraction, an `sbox` layer cache, automatic image pruning, and private
registry configuration are not part of `0.1`.

### Use managed QCOW2 storage

Projects declare named, host-local base volumes. Profiles attach one or more at
guest paths. A missing base is automatically created as QCOW2/ext4 at a
configured logical size using a pinned formatter image and host `qemu-img`.

Ordinary sandboxes receive one disposable direct child overlay per attachment.
Writes remain in that child; removing the sandbox removes only its children.
Profiles in the same project may share a base. Bases are not implicitly shared
across projects.

`volume shell` creates an explicit maintenance sandbox using a selected
profile but mounts the base directly, allowing tools and images to be
pre-seeded in place. It is exclusive: base mutation is refused while any child
exists. There are no volume versions, retained layer chains, snapshots,
automatic resizing, or repair system.

### Restrict networking

Sandbox ingress and egress default to deny. Profiles may:

- disable networking completely;
- allow outbound exact domains, domain suffixes, exact IPs, or CIDRs;
- restrict rules by TCP/UDP destination ports or ranges;
- publish explicit TCP/UDP guest ports to host addresses.

Domain rules default to TCP ports 80 and 443. A suffix includes the base domain
and its subdomains. DNS and guest loopback remain available. Published ports
permit only their corresponding ingress. Secret-host authorization and network
authorization remain independent. No changing presets or full SDK network
policy language are shipped.

### Work remotely

The same public client targets an authenticated foreground `sbox serve`
process. The client resolves project configuration and sends transport-safe
requests; the server does not read project YAML or maintain a project catalog.
Images, QCOW2 files, and Microsandbox all live on the selected host.

One bearer credential authorizes the trusted-host API. The server binds to
loopback by default but may bind elsewhere. Plain non-loopback HTTP is allowed;
documentation and `doctor` warn that credentials, environment values, and
transferred bytes are not encrypted. Users provide private networking or an
external TLS proxy when required.

### Use Sandcastle

The Sandcastle package receives an `SboxClient` plus profile. It creates a
unique sandbox with `/workspace` as its default absolute worktree path and
implements:

- collected shell execution with cwd, root/sudo, string stdin, and genuinely
  live line callbacks;
- optional interactive execution with arbitrary Node streams and PTY behavior;
- recursive `copyIn`, single-file `copyFileOut`, and `worktreePath`;
- idempotent `close`, mapped to exact sandbox removal.

Interactive PTY output is merged to Sandcastle stdout. Adapter cleanup is
guaranteed on normal `close`, not after client-machine crashes; owned leftovers
remain visible for explicit removal.

## CLI scope

The initial CLI includes:

- `init`, `config validate`, `config show`, `doctor`;
- `build`, `up`, `run`, `exec`, `shell`;
- `list`, `inspect`, `stop`, `remove`;
- `volume list`, `volume shell`, `volume remove`;
- `image list`, `image remove`;
- `serve`.

There is no separate `get` command. Explicit deletion commands do not prompt;
identities are exact and there is no prune command. `run` creates a unique
sandbox, executes once, and removes in `finally`. Guest exit codes become the
CLI exit code. Non-interactive commands support `--json`; streaming commands
emit typed newline-delimited events.

## Success criteria

- The architecture remains explainable as configuration and bounded helpers
  over one Microsandbox host interface.
- Both public packages contain no Microsandbox-native exported types.
- Sandcastle's complete isolated provider, including optional interactivity,
  works locally and remotely.
- Automatic images and QCOW2 bases require no registry or product database.
- Default-deny networking is demonstrably enforced.
- Windows, macOS, and Linux have recorded local/remote acceptance evidence,
  with remote-client support reported separately from local-host capability.
- `0.1.0` documents the APIs, CLI, security posture, volume safety, platform
  prerequisites, Sandcastle setup, and deliberate non-goals.
