/**
 * Read-only `sbox doctor` — local capabilities or remote handshake.
 */

import { createLocalHost } from "../../local-host.js";
import { createRemoteHost } from "../../remote/remote-host.js";
import { SBOX_PROTOCOL_VERSION } from "../../remote/protocol.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-meta.js";
import { resolveTarget } from "../../config/targets.js";
import { discoverProjectConfig, discoverUserConfig } from "../../config/discovery.js";
import { SboxError, isSboxError } from "../../errors.js";
import type { CliContext } from "../context.js";
import { writeResult } from "../context.js";
import { EXIT_SUCCESS, EXIT_OPERATIONAL } from "../exit-codes.js";
import { formatCliResult } from "../format.js";

/** Detail string for doctor remote-url check (exported for unit coverage). */
export function formatRemoteUrlCheckDetail(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const isCleartextHttp = parsed.protocol === "http:";
  const host = parsed.hostname;
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (isCleartextHttp && !loopback) {
    return `${url} (warning: non-loopback HTTP is unencrypted)`;
  }
  return url;
}

export async function runDoctor(ctx: CliContext): Promise<number> {
  const checks: Array<{ readonly name: string; readonly ok: boolean; readonly detail?: string }> =
    [];

  checks.push({
    name: "node",
    ok: true,
    detail: `node ${process.version}; ${PACKAGE_NAME}@${PACKAGE_VERSION}`,
  });

  try {
    const project = await discoverProjectConfig({
      cwd: ctx.io.cwd,
      env: ctx.io.env,
      ...(ctx.flags.configPath !== undefined ? { configPath: ctx.flags.configPath } : {}),
    });
    const user = await discoverUserConfig({
      cwd: ctx.io.cwd,
      env: ctx.io.env,
      ...(ctx.flags.userConfigPath !== undefined
        ? { userConfigPath: ctx.flags.userConfigPath }
        : {}),
      ...(ctx.io.homeDir !== undefined ? { homeDir: ctx.io.homeDir } : {}),
    });
    const target = await resolveTarget({
      project: project.value,
      user: user.value,
      ...(ctx.flags.target !== undefined ? { explicitTarget: ctx.flags.target } : {}),
      external: {
        configDirectory: project.directory,
        env: ctx.io.env,
        invocation: {},
      },
    });

    if (target.kind === "remote") {
      checks.push({
        name: "remote-url",
        ok: true,
        detail: formatRemoteUrlCheckDetail(target.url),
      });
      await using host = createRemoteHost({ url: target.url, bearerToken: target.token });
      const caps = await host.capabilities();
      checks.push({
        name: "remote-handshake",
        ok: true,
        detail: `protocol ${SBOX_PROTOCOL_VERSION}; localMicrosandbox=${caps.localMicrosandbox}`,
      });
    } else {
      await using host = ctx.host ?? createLocalHost();
      const caps = await host.capabilities();
      checks.push({
        name: "local-host",
        ok: true,
        detail: `localMicrosandbox=${caps.localMicrosandbox}; qemuImg=${caps.qemuImg}`,
      });
    }
  } catch (error) {
    checks.push({
      name: "target",
      ok: false,
      detail: isSboxError(error) ? error.message : String(error),
    });
  }

  const ok = checks.every((c) => c.ok);
  writeResult(
    ctx,
    formatCliResult(
      {
        ok,
        command: "doctor",
        data: { checks },
        ...(ok
          ? {}
          : {
              error: SboxError.capability(
                "doctor reported one or more failed checks.",
              ).toSafeJSON(),
            }),
      },
      ctx.format,
    ),
  );
  return ok ? EXIT_SUCCESS : EXIT_OPERATIONAL;
}
