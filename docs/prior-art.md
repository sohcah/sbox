# Prior art and retained evidence

This is the fourth design attempt, so earlier repositories are evidence rather
than embarrassment. They establish what works and which requirements cause the
system to stop being a small wrapper.

## DockerAgent

Location: `~/Projects/Personal/DockerAgent`

Retain:

- A remote foreground host can provide a useful Sandcastle-compatible
  Microsandbox interface.
- Automatic Docker image preparation is central to the product.
- API-key authentication, streaming execution, and explicit file transfer are
  practical.
- Guest-side `mkfs.ext4` avoids requiring host `e2fsprogs`, including Windows.

Do not carry forward:

- Deployment-directory-specific product shape.
- Registry management unless direct SDK loading proves insufficient.
- Large server manager objects that combine config, image, volume, lifecycle,
  transport, and Sandcastle policy.

## sohcah-msb

Location: `~/Projects/Personal/msb`

Retain:

- Promise-based public interfaces are sufficient.
- Content-addressed Docker builds and direct `msb image load` worked.
- Exact argv execution and explicit shell operations are important.
- Ownership-safe exact cleanup and secret handling deserve focused tests.
- Sandcastle should remain an adapter over a general sandbox handle.

Do not carry forward:

- SSH command transport and platform shell codecs.
- Target-side journals, manifests, flock protocols, or controller-death
  recovery.
- Separate manual/transient lifecycle models.
- Effect-based workflow infrastructure.

## sandbox

Location: `~/Projects/Personal/sandbox`

Retain:

- The configuration vocabulary and accumulated validation lessons.
- The pinned dependency and TypeScript 7 patch evidence.
- Native HTTP plus `ws` is adequate for remote transport.
- SDK lifecycle works on macOS and Windows under an isolated short `MSB_HOME`.
- QCOW2 testing proved the stopped-handle detach requirement.
- Guest-side ext4 formatting works across tested hosts.
- Strict declaration-leak and deterministic test gates are valuable.

Do not carry forward:

- SQLite as a second sandbox authority.
- Durable lifecycle transitions and reconciliation.
- Migration leases, operation fencing, PID liveness, and repair taxonomy.
- General artifact journals and checkpoint recovery.
- Versioned volume-template publication in the minimal first release.
- Requirements added solely to make those systems internally robust.

## Reuse policy

Copying code is not the default. For each reused module:

1. Identify the current `sbox` interface it satisfies.
2. Copy only the implementation needed by that interface.
3. Remove predecessor-specific state, terminology, and compatibility behavior.
4. Add focused tests in the new repository.
5. Record the source commit and any behavior intentionally changed.

Research notes and platform evidence may be copied with provenance. Production
modules should normally be reintroduced through the new implementation phases
rather than wholesale.

