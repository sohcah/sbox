# sbox

A curated configuration and Host layer over Microsandbox: project profiles, managed volumes, networking, transfer, and remote serve.

## Language

**Host directory mount**:
A profile attachment that places a directory into the guest at a path. Declared only on profiles (not creation overlays). Independent of Sandcastle's worktree `copyIn` path. Each attachment names a Client path or Host path source and an access mode. Client-sourced mounts are read-only; Host-sourced mounts may be read-only or writable. Writable Host mounts require an explicit guest write quota. Guest always sees a mount; staging of Client paths onto a remote Host is plumbing, not a user feature.
_Avoid_: bind mount (as the product name), arbitrary host path, raw disk path, volume (reserved for managed QCOW2)

**Client path**:
A directory on the machine running the sbox client. Declared with `source: client` on a host directory mount. Relative paths resolve against the project config directory; absolute paths are allowed. Must exist as a real directory at create (symlink roots rejected). On a remote target the tree is transferred once at create into a Directory stage before bind. Client-sourced mounts are read-only.
_Avoid_: local folder (ambiguous with Host), project path (unless we later pin that meaning)

**Host path**:
A directory already on the Host that runs Microsandbox (the local machine for LocalHost, the serve machine for RemoteHost). Declared with `source: host`. Must be an absolute path on that Host and exist as a real directory at create (symlink roots rejected). May be mounted read-only or writable.
_Avoid_: server path, remote path

**Directory stage**:
A Host-side materialization of a Client path created at sandbox create for remote targets, then bound read-only into the guest. Deleted when the sandbox is removed or create fails. Not a user-visible Volume or Transfer feature.
_Avoid_: cache copy, sync folder, bind mount
