/**
 * Project and user configuration discovery.
 *
 * Project configs search upward for `sbox.yaml`. User configs use XDG on
 * Unix (`~/.config/sbox`) and `%APPDATA%\sbox` on Windows.
 */

import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { SboxError } from "../errors.js";
import type { ProjectConfig, UserConfig } from "./types.js";
import { loadProjectConfigFromYaml, loadUserConfigFromYaml } from "./yaml.js";

export type PlatformKind = "linux" | "darwin" | "win32";

export type DiscoverySource = "explicit" | "nearest-ancestor" | "platform-user" | "default";

export interface DiscoveryEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly platform: PlatformKind;
  readonly homeDir: string;
  readonly readFile: (path: string) => Promise<string>;
  readonly pathExists: (path: string) => Promise<boolean>;
}

export interface DiscoveredProjectConfig {
  readonly value: ProjectConfig;
  readonly path: string;
  readonly directory: string;
  readonly source: DiscoverySource;
}

export interface DiscoveredUserConfig {
  readonly value: UserConfig;
  readonly path: string | undefined;
  readonly source: DiscoverySource;
}

export interface ConfigDiscoveryOptions {
  readonly configPath?: string;
  readonly userConfigPath?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: PlatformKind;
  readonly homeDir?: string;
  readonly discovery?: Partial<DiscoveryEnvironment>;
}

const PROJECT_FILE_NAME = "sbox.yaml";

function createDefaultDiscovery(options: ConfigDiscoveryOptions = {}): DiscoveryEnvironment {
  const env = options.env ?? process.env;
  const platform = (options.platform ?? process.platform) as PlatformKind;
  return {
    env,
    cwd: options.cwd ?? process.cwd(),
    platform,
    homeDir: options.homeDir ?? homedir(),
    readFile: async (path) => readFile(path, "utf8"),
    pathExists: async (path) => {
      try {
        await access(path, fsConstants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    ...options.discovery,
  };
}

function platformUserConfigPath(
  platform: PlatformKind,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === "win32") {
    const appData = env["APPDATA"];
    if (appData === undefined || appData.length === 0) {
      return join(homeDir, "AppData", "Roaming", "sbox", "config.yaml");
    }
    return join(appData, "sbox", "config.yaml");
  }
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, "sbox", "config.yaml");
  }
  return join(homeDir, ".config", "sbox", "config.yaml");
}

async function findNearestAncestor(
  startDir: string,
  fileName: string,
  pathExists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  let current = resolve(startDir);
  for (;;) {
    const candidate = join(current, fileName);
    if (await pathExists(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function discoverProjectConfig(
  options: ConfigDiscoveryOptions = {},
): Promise<DiscoveredProjectConfig> {
  const discovery = createDefaultDiscovery(options);

  if (options.configPath !== undefined) {
    const path = resolve(discovery.cwd, options.configPath);
    if (!(await discovery.pathExists(path))) {
      throw SboxError.notFound(`Project configuration not found at ${path}.`, {
        details: { path, source: "explicit" },
      });
    }
    const text = await discovery.readFile(path);
    return {
      value: loadProjectConfigFromYaml(text),
      path,
      directory: dirname(path),
      source: "explicit",
    };
  }

  const found = await findNearestAncestor(discovery.cwd, PROJECT_FILE_NAME, discovery.pathExists);
  if (found === undefined) {
    throw SboxError.notFound(
      `No ${PROJECT_FILE_NAME} found from ${discovery.cwd} or its ancestors.`,
      {
        details: { cwd: discovery.cwd, fileName: PROJECT_FILE_NAME },
      },
    );
  }
  const text = await discovery.readFile(found);
  return {
    value: loadProjectConfigFromYaml(text),
    path: found,
    directory: dirname(found),
    source: "nearest-ancestor",
  };
}

export async function discoverUserConfig(
  options: ConfigDiscoveryOptions = {},
): Promise<DiscoveredUserConfig> {
  const discovery = createDefaultDiscovery(options);

  if (options.userConfigPath !== undefined) {
    const path = resolve(discovery.cwd, options.userConfigPath);
    if (!(await discovery.pathExists(path))) {
      throw SboxError.notFound(`User configuration not found at ${path}.`, {
        details: { path, source: "explicit" },
      });
    }
    const text = await discovery.readFile(path);
    return {
      value: loadUserConfigFromYaml(text),
      path,
      source: "explicit",
    };
  }

  const path = platformUserConfigPath(discovery.platform, discovery.homeDir, discovery.env);
  if (await discovery.pathExists(path)) {
    const text = await discovery.readFile(path);
    return {
      value: loadUserConfigFromYaml(text),
      path,
      source: "platform-user",
    };
  }

  return {
    value: {
      version: 1,
      targets: Object.freeze({
        local: Object.freeze({ kind: "local" as const }),
      }),
    },
    path: undefined,
    source: "default",
  };
}
