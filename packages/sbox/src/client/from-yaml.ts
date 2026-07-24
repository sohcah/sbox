/**
 * YAML convenience entrypoint for SboxClient.
 */

import {
  discoverProjectConfig,
  discoverUserConfig,
  type ConfigDiscoveryOptions,
} from "../config/discovery.js";
import type { Host } from "../host.js";
import type { Logger } from "../logging.js";
import { createSboxClient, type SboxClient, type SboxClientOptions } from "./client.js";

export interface YamlSboxClientOptions extends ConfigDiscoveryOptions {
  readonly host?: Host;
  readonly logger?: Logger;
  readonly ownsHost?: boolean;
  readonly invocation?: Readonly<Record<string, string>>;
}

export async function createSboxClientFromYaml(
  options: YamlSboxClientOptions = {},
): Promise<SboxClient> {
  const project = await discoverProjectConfig(options);
  const user = await discoverUserConfig(options);
  const clientOptions: SboxClientOptions = {
    project: project.value,
    user: user.value,
    configDirectory: project.directory,
    env: options.env ?? process.env,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.ownsHost !== undefined ? { ownsHost: options.ownsHost } : {}),
    ...(options.invocation !== undefined ? { invocation: options.invocation } : {}),
  };
  return createSboxClient(clientOptions);
}
