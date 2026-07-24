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
