/**
 * Public LocalHost factory.
 *
 * Runtime injection for tests is deliberately kept out of this module's
 * declaration surface.
 */

import type { Host } from "./host.js";
import type { Logger } from "./logging.js";
import { createLocalHostInternal } from "./local-host-internal.js";

export interface LocalHostOptions {
  readonly logger?: Logger;
}

export function createLocalHost(options: LocalHostOptions = {}): Host {
  return createLocalHostInternal(options);
}
