# Host mounts — implementation plan

Decisions from the grill (`CONTEXT.md`). Supersedes the Host directory mounts
plan: unified **Host mounts** (`mounts:`), file or directory inferred at create.

## Goals

- Profile `mounts:` attach a Client or Host path (file or directory) into the guest.
- Hard cut: reject `directories:`; rename Host DTO / label to `mounts` /
  `dev.sohcah.sbox/mounts`.
- Defaults: `source: client`, `readonly: true`.
- No YAML `kind` — create-time `lstat` decides file vs directory; kind is part of
  the immutable creation fingerprint.
- `source: client` → always read-only; relative paths resolve against project
  config directory; `~/…` → client home.
- `source: host` → absolute or `~/…` on the Host; RO or RW; `quota` optional
  (omit → plain MSB `.bind()`, accept protective default; spike decides how
  omitted quota matches fingerprint / decoded native `quotaMib`).
- Create-time only; immutable creation; no overlays; no content hashing; no
  copy-back; no live refresh.
- Symlink roots rejected; guest `mount` unique across `mounts` ∪ `volumes`
  (exact string only).
- LocalHost binds resolved paths directly.
- RemoteHost stages Client mounts once at create (Mount stage; same generation
  layout under `~/.sbox/directory-stages`), binds RO, deletes stage on remove /
  failed create (generation-isolated).
- Protocol `2` → `3`. Sandcastle unchanged.

## Config sketch

```yaml
profiles:
  default:
    mounts:
      - path: ./vendor
        mount: /vendor
      - path: ./config.json
        mount: /etc/app/config.json
      - path: ~/cache/tools
        source: host
        mount: /tools
        readonly: false
        quota: 512MiB
      - path: /var/log/app.log
        source: host
        mount: /var/log/app.log
        readonly: false
```

## Phase 0: MSB spike (gate)

On microsandbox@0.6.6 prove:

- RO file bind; RO directory bind
- RW file / directory with explicit `.quota(n)`
- RW file / directory with plain `.bind()` (no quota) and whether SandboxConfig
  persists a default `quotaMib`

Exit: file binds work; omitted-quota fingerprint rule chosen (effective quota
after create, or match-omitted-to-default). Stop/replan if file binds fail.

## Phase 1: Rename + LocalHost files

- Schema/types: `mounts:`; reject `directories:`; optional quota for writable Host
- Infer kind at create; fingerprint + labels include kind
- Assert bindable file or directory (non-symlink)
- LocalHost binds; decode/ownership use `mounts`
- Unit + local acceptance (RO file/dir, RW with/without quota per spike rule, drift on kind flip, bad roots)

Exit: `sbox up` with `mounts:` works locally for file and directory; old
`directories:` rejected; Sandcastle untouched.

## Phase 2: Remote + protocol 3 + docs

- Client pack/stage files and directories in the same archive/generation mechanism
- `SBOX_PROTOCOL_VERSION` = `3`; create metadata uses `mounts` + kind
- Docs (`configuration`, `remote`, product/system as needed), feature inventory,
  retire directory-only wording; keep on-disk `directory-stages` path

Exit: remote Client file and directory RO mounts work; remove cleans stages;
protocol mismatch fails; docs match.

## Risks

- MSB bind API is documented for host *directories*; Phase 0 is mandatory.
- Omitted quota vs persisted MSB default can break ownership match — resolve in spike.
- Hard cuts (`directories:`, label key, protocol 3) require recreate of existing
  sandboxes that used directory mounts.

## Non-goals

Writable client sources, copy-back/sync, creation overlays, Sandcastle
auto-mount, nested guest-path overlap detection, relative Host paths (except
`~/`), symlink roots, tmpfs/named volumes/raw disk pass-through, permanent
`directories:` alias, renaming the on-disk `directory-stages` directory.
