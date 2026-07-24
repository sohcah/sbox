/**
 * Compile-time guard for the microsandbox@0.6.6 TypeScript 7 declaration patch.
 *
 * If upstream fixes SecretBuilder.env(var: string) and the patch is removed,
 * this import should continue to typecheck. If the patch stops applying while
 * the illegal parameter name remains, `pnpm typecheck` fails here.
 */
import { SecretBuilder } from "microsandbox/native";

export const secretBuilderPatchProbe: SecretBuilder = new SecretBuilder();
void secretBuilderPatchProbe.env("EXAMPLE");
