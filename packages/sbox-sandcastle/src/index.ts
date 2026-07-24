/**
 * Public surface for `@sohcah/sbox-sandcastle`.
 *
 * Phase 1 only exports package identity. The Sandcastle factory and peer
 * dependency arrive in a later phase.
 */
export {
  PACKAGE_NAME as SBOX_PACKAGE_NAME,
  PACKAGE_VERSION as SBOX_PACKAGE_VERSION,
} from "@sohcah/sbox";

export const PACKAGE_NAME = "@sohcah/sbox-sandcastle" as const;
export const PACKAGE_VERSION = "0.1.0" as const;
