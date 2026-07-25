/**
 * Unique portable instance identities for Sandcastle-owned sandboxes.
 */

import { randomBytes } from "node:crypto";
import { assertInstanceId, type InstanceId } from "@sohcah/sbox";

/** Generate a unique portable instance slug for one Sandcastle create. */
export function uniqueSandcastleInstanceId(): InstanceId {
  return assertInstanceId(`sc-${randomBytes(8).toString("hex")}`);
}
