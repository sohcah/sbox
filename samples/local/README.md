# Local sample

```bash
cd samples/local
sbox doctor
sbox config validate
sbox up default
sbox run default -- printf '%s\n' hello
sbox volume list
sbox stop default && sbox remove default
```

Uses default-deny networking with an optional `cache` volume. Volume commands
require host `qemu-img` and a formatter image; omit the `volumes` block if you
only need a plain sandbox.

Target definitions live in user configuration (not project YAML). This sample
relies on the implicit local target.
