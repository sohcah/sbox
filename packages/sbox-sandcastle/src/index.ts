/**
 * Public surface for `@sohcah/sbox-sandcastle`.
 *
 * Adapts an existing `SboxClient` to Sandcastle's isolated provider contract.
 * Sandcastle itself is a peer dependency — wrap the returned config with
 * `createIsolatedSandboxProvider` from `@ai-hero/sandcastle`.
 */

export {
  PACKAGE_NAME as SBOX_PACKAGE_NAME,
  PACKAGE_VERSION as SBOX_PACKAGE_VERSION,
} from "@sohcah/sbox";

export const PACKAGE_NAME = "@sohcah/sbox-sandcastle" as const;
export const PACKAGE_VERSION = "0.2.7" as const;

export { createSboxSandcastleProvider, type SboxSandcastleOptions } from "./provider.js";

export { createSboxIsolatedHandle, type SboxIsolatedHandleOptions } from "./handle.js";

export { uniqueSandcastleInstanceId } from "./instance.js";
