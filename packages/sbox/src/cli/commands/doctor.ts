/**
 * Read-only `sbox doctor` — environment probes and target handshake.
 *
 * Required checks fail the command. Tooling probes (Docker, qemu-img, formatter
 * image) are informational so remote-client and CI hosts without local
 * virtualization still pass `pnpm check`.
 */

import { createLocalHost } from "../../local-host.js";
import { createRemoteHost } from "../../remote/remote-host.js";
import { SBOX_PROTOCOL_VERSION } from "../../remote/protocol.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-meta.js";
import { resolveTarget } from "../../config/targets.js";
import { discoverProjectConfig, discoverUserConfig } from "../../config/discovery.js";
import { SboxError, isSboxError } from "../../errors.js";
import { runExactCommand } from "../../image/subprocess.js";
import { probeQemuImg } from "../../volume/qemu-img.js";
import { DEFAULT_VOLUME_FORMATTER_IMAGE, volumeFormatterImage } from "../../volume/format-base.js";
import type { CliContext } from "../context.js";
import { writeResult } from "../context.js";
import { EXIT_SUCCESS, EXIT_OPERATIONAL } from "../exit-codes.js";
import { formatCliResult } from "../format.js";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  /** When false, a failed check does not fail the overall doctor result. */
  readonly required: boolean;
  readonly detail?: string;
}

export interface DoctorProbePorts {
  /** Override `process.version` for deterministic Node checks (e.g. `v24.1.0`). */
  readonly nodeVersion?: string;
  readonly probeDocker?: () => Promise<{
    readonly available: boolean;
    readonly detail: string;
  }>;
  readonly probeQemu?: () => Promise<{
    readonly available: boolean;
    readonly detail: string;
  }>;
  readonly probeFormatterImage?: (dockerAvailable: boolean) => Promise<{
    readonly available: boolean;
    readonly detail: string;
  }>;
}

/** Minimum supported Node.js major (matches package `engines`). */
export const MIN_NODE_MAJOR = 24;

/**
 * Evaluate a Node.js version string (`process.version` form, e.g. `v24.0.0`).
 * Exported for unit coverage of supported and unsupported majors.
 */
export function evaluateNodeVersion(
  version: string,
  minMajor: number = MIN_NODE_MAJOR,
): { readonly ok: boolean; readonly detail: string } {
  const match = /^v(\d+)(?:\.(\d+)\.(\d+))?/.exec(version.trim());
  if (match === null) {
    return {
      ok: false,
      detail: `unrecognized Node version ${version}; require Node ${minMajor}+`,
    };
  }
  const major = Number(match[1]);
  if (!Number.isInteger(major) || major < minMajor) {
    return {
      ok: false,
      detail: `node ${version}; require Node ${minMajor}+ (${PACKAGE_NAME}@${PACKAGE_VERSION})`,
    };
  }
  return {
    ok: true,
    detail: `node ${version}; ${PACKAGE_NAME}@${PACKAGE_VERSION}`,
  };
}

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

export async function probeDockerCli(): Promise<{
  readonly available: boolean;
  readonly detail: string;
}> {
  try {
    const result = await runExactCommand({
      executable: "docker",
      args: ["version", "--format", "{{.Client.Version}}"],
      retainOutput: true,
      maxRetainBytes: 4096,
      failureCode: "capability",
      failureMessage: "docker is not available.",
    });
    const version = result.stdout.trim();
    return {
      available: true,
      detail: version.length > 0 ? `docker client ${version}` : "docker client available",
    };
  } catch (error) {
    return {
      available: false,
      detail:
        error instanceof Error ? `docker probe failed: ${error.message}` : "docker probe failed.",
    };
  }
}

export async function probeFormatterImagePresence(
  dockerAvailable: boolean,
): Promise<{ readonly available: boolean; readonly detail: string }> {
  const image = volumeFormatterImage();
  const override =
    image !== DEFAULT_VOLUME_FORMATTER_IMAGE ? ` (via SBOX_VOLUME_FORMATTER_IMAGE)` : "";
  if (!dockerAvailable) {
    return {
      available: false,
      detail: `configured ${image}${override}; docker unavailable to inspect`,
    };
  }
  try {
    await runExactCommand({
      executable: "docker",
      args: ["image", "inspect", image, "--format", "{{.Id}}"],
      retainOutput: true,
      maxRetainBytes: 4096,
      failureCode: "capability",
      failureMessage: `formatter image ${image} not found.`,
    });
    return {
      available: true,
      detail: `formatter image present: ${image}${override}`,
    };
  } catch {
    return {
      available: false,
      detail: `formatter image missing: ${image}${override} (auto-built on first volume ensure when using the default tag)`,
    };
  }
}

async function defaultProbeQemu(): Promise<{
  readonly available: boolean;
  readonly detail: string;
}> {
  const probe = await probeQemuImg();
  return {
    available: probe.available,
    detail: probe.notes[0] ?? (probe.available ? "qemu-img available" : "qemu-img unavailable"),
  };
}

function toolingCheck(
  name: string,
  result: { readonly available: boolean; readonly detail: string },
): DoctorCheck {
  return {
    name,
    ok: result.available,
    required: false,
    detail: result.detail,
  };
}

export async function runDoctor(ctx: CliContext, ports: DoctorProbePorts = {}): Promise<number> {
  const checks: DoctorCheck[] = [];

  const node = evaluateNodeVersion(ports.nodeVersion ?? process.version);
  checks.push({
    name: "node",
    ok: node.ok,
    required: true,
    detail: node.detail,
  });

  checks.push({
    name: "protocol",
    ok: true,
    required: true,
    detail: `sbox remote protocol ${SBOX_PROTOCOL_VERSION}`,
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

    const probeDocker = ports.probeDocker ?? probeDockerCli;
    const probeQemu = ports.probeQemu ?? defaultProbeQemu;
    const probeFormatter = ports.probeFormatterImage ?? probeFormatterImagePresence;

    if (target.kind === "remote") {
      checks.push({
        name: "remote-url",
        ok: true,
        required: true,
        detail: formatRemoteUrlCheckDetail(target.url),
      });
      checks.push({
        name: "remote-auth",
        ok: true,
        required: true,
        detail: "bearer token resolved (value redacted)",
      });
      await using host = createRemoteHost({ url: target.url, bearerToken: target.token });
      const caps = await host.capabilities();
      checks.push({
        name: "remote-handshake",
        ok: true,
        required: true,
        detail: `protocol ${SBOX_PROTOCOL_VERSION}; localMicrosandbox=${caps.localMicrosandbox}; qemuImg=${caps.qemuImg}`,
      });
      checks.push({
        name: "target-mode",
        ok: true,
        required: true,
        detail: "remote-client (local Docker/qemu/formatter not required)",
      });
    } else {
      await using host = ctx.host ?? createLocalHost();
      const caps = await host.capabilities();
      checks.push({
        name: "local-host",
        ok: true,
        required: true,
        detail: `localMicrosandbox=${caps.localMicrosandbox}; dynamicHostPorts=${caps.dynamicHostPorts}`,
      });
      checks.push({
        name: "microsandbox",
        ok: caps.localMicrosandbox,
        required: false,
        detail: caps.localMicrosandbox
          ? "Microsandbox available via Host probe"
          : "Microsandbox unavailable on this host (use a remote target or install the runtime)",
      });
      checks.push({
        name: "target-mode",
        ok: true,
        required: true,
        detail: "local-host",
      });
    }

    const docker = await probeDocker();
    checks.push(toolingCheck("docker", docker));
    const qemu = await probeQemu();
    checks.push(toolingCheck("qemu-img", qemu));
    const formatter = await probeFormatter(docker.available);
    checks.push(toolingCheck("formatter-image", formatter));
  } catch (error) {
    checks.push({
      name: "target",
      ok: false,
      required: true,
      detail: isSboxError(error) ? error.message : String(error),
    });
  }

  const ok = checks.filter((c) => c.required).every((c) => c.ok);
  if (ctx.format === "text") {
    writeResult(ctx, formatDoctorText(checks, ok));
    return ok ? EXIT_SUCCESS : EXIT_OPERATIONAL;
  }
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
                "doctor reported one or more failed required checks.",
              ).toSafeJSON(),
            }),
      },
      ctx.format,
    ),
  );
  return ok ? EXIT_SUCCESS : EXIT_OPERATIONAL;
}

function formatDoctorText(checks: readonly DoctorCheck[], ok: boolean): string {
  const lines = checks.map((check) => {
    const status = check.ok ? "ok" : check.required ? "FAIL" : "unavailable";
    const requirement = check.required ? "required" : "informational";
    const detail = check.detail !== undefined ? `: ${check.detail}` : "";
    return `[${status}] ${check.name} (${requirement})${detail}`;
  });
  if (!ok) {
    lines.push("error(capability): doctor reported one or more failed required checks.");
  }
  return `${lines.join("\n")}\n`;
}
