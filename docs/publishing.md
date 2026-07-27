# Publishing

Packages: `@sohcah/sbox`, `@sohcah/sbox-sandcastle` (both `0.2.2`).

Releases use **npm trusted publishing** (OIDC) from GitHub Actions — no long-lived
`NPM_TOKEN`. Provenance attestations are generated automatically.

## First publish (one-time)

npm cannot attach a Trusted Publisher until the package exists on the registry.
For each package, publish once locally (with your npm account + 2FA), then
configure trusted publishing:

```bash
pnpm build
pnpm --filter @sohcah/sbox publish --access public
pnpm --filter @sohcah/sbox-sandcastle publish --access public
```

## Trusted Publisher on npmjs.com

For **each** package → Settings → Trusted Publisher → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `sohcah` |
| Repository | `sbox` |
| Workflow filename | `publish.yml` (filename only, with extension) |
| Environment name | leave blank |
| Allowed actions | `npm publish` (at least) |

Values are case-sensitive and must match exactly. After this works, you can
restrict Publishing access to disallow tokens.

CLI alternative (package must already exist; requires account 2FA):

```bash
npm trust github @sohcah/sbox --repo sohcah/sbox --file publish.yml --allow-publish
npm trust github @sohcah/sbox-sandcastle --repo sohcah/sbox --file publish.yml --allow-publish
```

## Subsequent releases

1. Bump both package versions in lockstep.
2. Commit, then tag and push: `git tag v0.1.1 && git push origin v0.1.1`
3. Workflow [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
   runs `pnpm check`, then publishes `@sohcah/sbox` then
   `@sohcah/sbox-sandcastle`. The tag (without `v`) must match both
   `package.json` versions.

Dry-run packing/install without publishing: `pnpm publish:dry-run`.

## Requirements

- GitHub-hosted runners only (self-hosted is unsupported for trusted publishing)
- Public GitHub repository for provenance
- Node 24+ / npm CLI ≥ 11.5.1 in the publish job
