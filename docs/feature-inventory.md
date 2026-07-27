# Feature inventory (0.1.0)

Every public behavior maps to **delegation** (Microsandbox / Docker / qemu-img),
a **bounded helper** in `sbox`, or a **deliberate exclusion** (`docs/non-goals.md`).

| Behavior | Kind | Notes |
| --- | --- | --- |
| Project/user YAML load | Helper | Typed model primary; upward discovery |
| Profile create settings | Helper → delegation | Curated subset only |
| Deterministic native names / labels | Helper | Hash + reserved keys |
| Lifecycle create/get/list/inspect/start/stop/remove | Delegation | Via Host |
| `up` narrow reconcile | Helper | No drift repair |
| `recreate` | Helper | Explicit remove+create |
| Dockerfile image ensure | Helper + Docker + msb load | Content-addressed |
| OCI image reference | Delegation | As-is to Microsandbox |
| Default-deny / allow / publish | Helper → delegation | Curated network DTO |
| Runtime secrets interception | Helper → delegation | Values never logged |
| Host directory mounts | Helper → delegation | Profile `directories:`; remote stages Client trees (protocol v2) |
| QCOW2 base + child overlay | Helper + qemu-img + formatter | One lock per base |
| `volume shell` exclusive base | Helper | Maintenance only |
| Exact argv exec / stream | Delegation | Byte events |
| Guest shell exec | Helper | `exec --shell` → `[shell,-c,script]` |
| Interactive CLI shell | Native local attach / PTY fallback | Profile shell, terminal input/resize |
| Collected UTF-8 / limits | Helper | Default 10 MiB |
| PTY | Helper | Private agent protocol adapter |
| File/dir transfer | Helper | Archive for remote; no sync/watch |
| Remote HTTP/WS Host | Helper | Auth + protocol v2 |
| `sbox serve` | Helper | Foreground; no install service |
| CLI lifecycle/process/image/volume | Helper | Exact identities; no prune |
| `run` unique create/exec/remove | Helper | finally cleanup |
| Sandcastle isolated provider | Helper | Peer Sandcastle; uses stable API |
| Doctor | Helper | Read-only probes |
| SQLite / catalog / claims / prune / sync / telemetry | Exclusion | See non-goals |
| Arbitrary SDK pass-through | Exclusion | Curated model only |
| Built-in TLS | Exclusion | Operator proxy |
| Cross-process image locks | Exclusion | In-process coalesce only |
| Detached process supervision | Exclusion | Session-owned only |

Public exports are the allowlists in `packages/sbox/src/index.ts` and
`packages/sbox-sandcastle/src/index.ts`. Declaration-leak tests guard the
published `.d.ts` graphs.
