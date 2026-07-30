#!/usr/bin/env bash
# Pack both workspace packages with pnpm (rewrites workspace: ranges) and prove
# the tarballs install into a clean temporary consumer project.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
pnpm build

pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/sbox-publish-dry-run.XXXXXX")"
cleanup() {
  rm -rf "$pack_dir"
}
trap cleanup EXIT

echo "==> pnpm pack (packages/sbox)"
(
  cd packages/sbox
  pnpm pack --pack-destination "$pack_dir"
)
echo "==> pnpm pack (packages/sbox-sandcastle)"
(
  cd packages/sbox-sandcastle
  pnpm pack --pack-destination "$pack_dir"
)

sbox_tgz="$(find "$pack_dir" -maxdepth 1 -name 'sohcah-sbox-*.tgz' ! -name '*sandcastle*' | head -n 1)"
sandcastle_tgz="$(find "$pack_dir" -maxdepth 1 -name 'sohcah-sbox-sandcastle-*.tgz' | head -n 1)"
if [[ -z "$sbox_tgz" || -z "$sandcastle_tgz" ]]; then
  echo "expected packed tarballs in $pack_dir" >&2
  ls -la "$pack_dir" >&2 || true
  exit 1
fi

echo "==> inspect packed manifests"
sbox_manifest="$(tar -xzOf "$sbox_tgz" package/package.json)"
sandcastle_manifest="$(tar -xzOf "$sandcastle_tgz" package/package.json)"
printf '%s\n' "$sbox_manifest" | node --input-type=module -e '
const fs = await import("node:fs");
const pkg = JSON.parse(fs.readFileSync(0, "utf8"));
if (pkg.version !== "0.2.7") throw new Error(`unexpected sbox version: ${pkg.version}`);
if (JSON.stringify(pkg).includes("workspace:")) {
  throw new Error("sbox packed manifest still contains workspace:");
}
console.log("sbox packed ok", pkg.name, pkg.version);
'
printf '%s\n' "$sandcastle_manifest" | node --input-type=module -e '
const fs = await import("node:fs");
const pkg = JSON.parse(fs.readFileSync(0, "utf8"));
const dep = pkg.dependencies?.["@sohcah/sbox"];
if (typeof dep !== "string" || dep.includes("workspace:")) {
  throw new Error(`sandcastle dependency not rewritten: ${dep}`);
}
if (!/^\^0\.2\.7$/.test(dep)) {
  throw new Error(`expected @sohcah/sbox ^0.2.7, got ${dep}`);
}
console.log("sandcastle packed ok", pkg.name, pkg.version, "depends on", dep);
'

echo "==> install packed tarballs into a clean consumer"
consumer="$(mktemp -d "${TMPDIR:-/tmp}/sbox-publish-consumer.XXXXXX")"
cleanup_consumer() {
  rm -rf "$consumer"
}
trap 'cleanup_consumer; cleanup' EXIT

cat > "$consumer/package.json" <<'EOF'
{
  "name": "sbox-publish-consumer",
  "private": true,
  "type": "module",
  "dependencies": {
    "@sohcah/sbox": "file:PLACEHOLDER_SBOX",
    "@sohcah/sbox-sandcastle": "file:PLACEHOLDER_SC"
  }
}
EOF
# portable in-place path substitution
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[1];
const sbox = process.argv[2];
const sc = process.argv[3];
const text = readFileSync(path, "utf8")
  .replaceAll("PLACEHOLDER_SBOX", sbox)
  .replaceAll("PLACEHOLDER_SC", sc);
writeFileSync(path, text);
' "$consumer/package.json" "$sbox_tgz" "$sandcastle_tgz"

(
  cd "$consumer"
  # Use npm so resolution does not depend on the monorepo workspace protocol.
  npm install --ignore-scripts --no-fund --no-audit
  node --input-type=module -e '
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const sboxPkg = require("@sohcah/sbox/package.json");
    const scPkg = require("@sohcah/sbox-sandcastle/package.json");
    if (sboxPkg.name !== "@sohcah/sbox") throw new Error("sbox package missing");
    if (scPkg.name !== "@sohcah/sbox-sandcastle") throw new Error("sandcastle package missing");
    if (JSON.stringify(scPkg.dependencies).includes("workspace:")) {
      throw new Error("installed sandcastle still has workspace:");
    }
    console.log("consumer install ok", sboxPkg.version, scPkg.version);
  '
)

echo "publish dry-run ok"
