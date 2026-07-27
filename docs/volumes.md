# Volumes (QCOW2 safety)

## Model

- One mutable **base** QCOW2 per declared volume under `~/.sbox/volumes`
  (override with `SBOX_VOLUME_DATA_ROOT`)
- Ordinary sandbox create attaches a **disposable direct child** overlay
- `volume shell <profile> <volume>` mounts the **base** exclusively for
  maintenance
- Remove sandbox discards the child; remove volume deletes the exact base

There are no snapshots, retained overlay chains, rebasing, resize, or prune.

## Integrity lock

A single OS-released lock per base covers child create/publish and the full
maintenance session. This is the only cross-process lock in `sbox` and must not
grow into general workflow machinery.

## Formatting

Blank bases are formatted via a pinned formatter image that already contains
`mkfs.ext4`. The default tag `sbox-volume-formatter:1` is **auto-built** from
the shipped `formatter/Dockerfile` and loaded into Microsandbox on first volume
ensure (requires Docker + `msb`). Override with `SBOX_VOLUME_FORMATTER_IMAGE`
to supply an equivalent image (overrides are not auto-built). Host `qemu-img`
is required only when volumes are used (`SBOX_QEMU_IMG` optional path override).

## Safety rules

- Never edit a base while a child exists (lock enforces this)
- Do not share bases across projects
- Do not treat child overlays as durable storage
- Prefer `volume shell` for intentional base mutation

## CLI

```bash
sbox volume list
sbox volume shell default cache
sbox volume remove cache   # exact; no prompt; no prune
```
