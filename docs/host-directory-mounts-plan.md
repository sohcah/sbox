# Host directory mounts — implementation plan

Decisions from the grill (`CONTEXT.md`). Curated **Host directory mounts**
(`directories:` on profiles).

## Goals

- Profile `directories:` mount a Client path or Host path into the guest.
- Defaults: `source: client`, `readonly: true`.
- `source: client` → always read-only; relative paths resolve against project config directory.
- `source: host` → absolute Host path only; read-only or writable; writable requires explicit `quota`.
- Create-time only (with recreate / `run`); part of immutable creation; no overlays; no content hashing; no copy-back; no live refresh.
- LocalHost binds resolved paths directly.
- RemoteHost stages `source: client` trees once at create (Directory stage), binds RO, deletes stage on remove / failed create.
- Protocol `1` → `2`. Sandcastle unchanged.

## Config sketch

```yaml
profiles:
  default:
    directories:
      - path: ./vendor
        mount: /vendor
      - path: /var/cache/tools
        source: host
        mount: /tools
        readonly: false
        quota: 512MiB
```

Validation: unique `mount` across directories ∪ volumes; reject client+writable;
quota only when writable; host paths absolute; create requires a real
non-symlink directory.

## Phase 1: Config through LocalHost

Ship end-to-end on a local target (no remote wire change yet).

Implement:

- Profile schema/types/validation + safe `config show` projection.
- `HostCreateRequest.directories`, resolve-intent, immutable-creation fingerprint,
  inspection projection (configured path, never stage paths).
- Native bind: RO → `.bind().readonly()`; RW → `.bind().quota()`; decode bind
  mounts from SandboxConfig for inspect/drift (not DiskImage-only).
- LocalHost: validate directory roots, map to `bindMounts`, create/remove.
- Unit coverage + local acceptance (RO client, RO/RW host, drift, bad roots).

Exit: `sbox up` with `directories:` works locally; changing directories reports
creation drift; Sandcastle untouched.

## Phase 2: Remote stages + protocol 2 + docs

Implement:

- Directory stage root (e.g. `~/.sbox/directory-stages/<project>/<instance>/…`),
  materialize via existing transfer archive rules, cleanup on remove/failed create.
- Bump `SBOX_PROTOCOL_VERSION` to `2`. Create uses metadata header + archive body
  (like `ensureImage`); client trees in the archive; server stages then binds;
  `source: host` validated on the serve machine.
- Docs (`configuration`, `remote`, `product`/`system-plan` as needed), feature
  inventory row, sample touch if useful; drop “arbitrary host binds” from
  “explicitly later” in the main implementation plan.

Exit: remote client RO mount works; remove cleans stages; mismatched protocol
fails; docs match.

## Risks

- Confirm MSB 0.6.6 RO binds work without quota early in Phase 1.
- Decode bind mounts are required for inspect/drift after process restart.
- Protocol 2 is hard-cut (no dual-stack).

## Non-goals

Writable client sources, copy-back/sync, creation overlays, Sandcastle
auto-mount, nested guest-path overlap detection, relative Host paths, symlink
roots, tmpfs/named volumes/raw disk pass-through.
