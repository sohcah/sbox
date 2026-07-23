# Non-goals and complexity budget

These exclusions are architectural constraints for the first release. Adding
one requires a concrete user story and an update to the system plan before
implementation.

## Not a second control plane

- No SQLite catalog of sandbox lifecycle state.
- No shadow `creating`, `starting`, `stopping`, or `removing` state machine.
- No durable operation claims, PID fencing, dead-owner takeover, or lock
  recovery framework.
- No generic artifact-operation journal.
- No automatic reconciliation between a product database and Microsandbox.
- No repair/adoption subsystem for arbitrary native resources.

Microsandbox owns sandbox and process state. If an SDK result is uncertain,
`sbox` reinspects Microsandbox by the known native identity and returns an
actionable result.

## No speculative resource manager

- No versioned QCOW2 template lineage in the initial release.
- No general snapshot manager.
- No automatic expiry scheduler.
- No global image prune or automatic native-resource deletion.
- No cross-process build coalescing.
- No generalized idempotency-key or request-journal system.

Simple disk attachment may be added if it maps directly to the SDK. Managed,
publishable template lineage is a separate future product decision.

## Narrow remote trust model

- No multi-tenant authorization.
- No per-user quotas or isolation.
- No built-in service installer.
- No custom SSH command protocol.
- No claim that HTTP bearer authentication provides transport encryption;
  deploy behind a trusted private network or external TLS.

## Narrow configuration

- No general YAML inheritance or merging language.
- No arbitrary pass-through SDK arguments.
- No implicit repository copy.
- No continuous or bidirectional filesystem synchronization.
- No pluggable runtime or image-builder framework.

## Complexity tests

Before adding infrastructure, ask:

1. Can the state be read from Microsandbox instead of persisted again?
2. Can retry plus reinspection handle failure safely?
3. Is concurrency required across processes, or only inside one request?
4. Is this supporting a current workflow or a hypothetical future adapter?
5. Does extracting a module shrink what callers must understand?
6. Would deleting the module merely move the same complexity into callers?

The preferred answer is the smallest deep module at a real seam. A generic
framework without two real adapters is rejected.

