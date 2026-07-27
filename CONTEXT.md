# sbox

A curated configuration and Host layer over Microsandbox: project profiles, managed volumes, networking, transfer, and remote serve.

## Language

**Host mount**:
A profile attachment that places a Client or Host path into the guest at a path. Declared only on profiles as `mounts:` (not creation overlays). Independent of Sandcastle's worktree `copyIn` path. Each attachment names a Client path or Host path source and an access mode. Kind (file vs directory) is inferred at create from the real path — not a YAML field. Client-sourced mounts are read-only; Host-sourced mounts may be read-only or writable. Writable Host mounts may omit `quota` (Microsandbox applies a protective default) or set an explicit guest write quota. Guest always sees a mount; staging of Client paths onto a remote Host is plumbing, not a user feature.
_Avoid_: bind mount (as the product name), Host directory mount (superseded name), arbitrary host path, raw disk path, volume (reserved for managed QCOW2)

**Client path**:
A file or directory on the machine running the sbox client. Declared with `source: client` on a Host mount. Relative paths resolve against the project config directory; `~/…` expands to the client home directory; absolute paths are allowed. Must exist at create as a real file or real directory (symlink roots rejected). On a remote target the tree or file is transferred once at create into a Mount stage before bind. Client-sourced mounts are read-only.
_Avoid_: local folder (ambiguous with Host), project path (unless we later pin that meaning)

**Host path**:
A file or directory already on the Host that runs Microsandbox (the local machine for LocalHost, the serve machine for RemoteHost). Declared with `source: host`. Must be an absolute path on that Host, or a home-relative path beginning with `~/` (expanded on the Host), and exist at create as a real file or real directory (symlink roots rejected). May be mounted read-only or writable.
_Avoid_: server path, remote path

**Mount stage**:
A Host-side materialization of a Client path created at sandbox create for remote targets, then bound read-only into the guest. Deleted when the sandbox is removed or create fails. Not a user-visible Volume or Transfer feature. On-disk root remains under `~/.sbox/directory-stages` (plumbing path; not renamed with the glossary).
_Avoid_: Directory stage (superseded name), cache copy, sync folder, bind mount
