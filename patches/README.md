# Package patches

## `microsandbox@0.6.6`

Pinned `microsandbox@0.6.6` ships an illegal TypeScript 7 declaration in
`native/index.d.ts`:

```ts
export declare class SecretBuilder {
  env(var: string): this
}
```

TypeScript 7 rejects `var` as a parameter name (`TS1390`). `skipLibCheck`
cannot suppress a declaration **syntax** error.

This repository applies the narrowest pnpm patch:

- Registration: root `package.json` → `pnpm.patchedDependencies["microsandbox@0.6.6"]`
- Patch file: `patches/microsandbox@0.6.6.patch`
- Exact change: `env(var: string)` → `env(variable: string)`
- Runtime JavaScript is untouched. Parameter names do not change the callable
  TypeScript signature of `env(string): this`.

A compile-time guard under `packages/sbox/test/microsandbox-secret-builder.types.ts`
imports `SecretBuilder` so typecheck fails if the patch stops applying.

**Remove this patch** when the pinned Microsandbox version includes the upstream
fix.

## Private PTY / FS agent adapter (Phase 3)

Microsandbox 0.6.6 high-level `Sandbox.attach*` bridges the host terminal and
returns only an exit code. It cannot satisfy arbitrary Node readable/writable
streams, merged PTY output, or resize.

`sbox` therefore keeps one private adapter under
`packages/sbox/src/internal/`:

- `agent-protocol.ts` — CBOR envelope codec for protocol generation **6**
  (`{ v, t, p }` with nested payload bytes). Empty `core.exec.stdin` data
  signals EOF. Resize uses `core.exec.resize` `{ rows, cols }`.
- `agent-pty.ts` — interactive PTY session over `AgentClient.connectSandbox` +
  `stream` / `send`.
- `agent-fs.ts` — narrow `Symlink` / `ReadLink` / `SetStat` RPCs for transfer
  mode and symlink preservation (not exposed on the Node `SandboxFsOps`
  wrapper).

These modules are never exported from `@sohcah/sbox`. Declaration-leak tests
forbid them at the package boundary. Contract fixtures live in
`packages/sbox/test/agent-protocol.test.ts`.

**Replace this adapter** when Microsandbox ships a stable high-level API for
arbitrary-stream PTY sessions with resize (and when Node `SandboxFsOps` exposes
symlink/mode helpers). The Microsandbox declaration patch above is unrelated and
remains until upstream fixes `SecretBuilder.env`.
