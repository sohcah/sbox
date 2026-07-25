# Remote sample

On the host:

```bash
export SBOX_SERVE_TOKEN='dev-token-at-least-16'
sbox serve --bind 127.0.0.1 --port 8787
```

On the client (same machine for this sample):

```bash
cd samples/remote
export SBOX_SAMPLE_REMOTE_TOKEN="$SBOX_SERVE_TOKEN"
sbox --user-config ./user-config.yaml doctor
sbox --user-config ./user-config.yaml up default
sbox --user-config ./user-config.yaml run default -- printf '%s\n' hello-remote
sbox --user-config ./user-config.yaml stop default
sbox --user-config ./user-config.yaml remove default
```

Project `sbox.yaml` selects `target: lab`. Connection URL and token references
live in `user-config.yaml` (user configuration). Edit `targets.lab.url` there if
the Host listens elsewhere. The server never reads project or user YAML from the
client.
