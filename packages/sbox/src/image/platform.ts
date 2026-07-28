/**
 * Host machine architecture → Docker `--platform` (no cross-arch builds).
 *
 * Call only on the Host that runs Docker / Microsandbox — never on a remote
 * Client to decide build platform.
 */

import { SboxError } from "../errors.js";
import type { HostCapabilities } from "../types.js";

export function hostDockerPlatform(arch: string = process.arch): string {
  switch (arch) {
    case "arm64":
      return "linux/arm64";
    case "x64":
      return "linux/amd64";
    case "arm":
      return "linux/arm/v7";
    default:
      throw SboxError.capability("Host architecture is not supported for Dockerfile builds.", {
        details: { unavailableReason: "unsupported_hypervisor", arch },
      });
  }
}

/** Read Host-advertised Docker platform; reject hosts that omit it. */
export function requireDockerPlatform(
  capabilities: Pick<HostCapabilities, "dockerPlatform">,
): string {
  const platform = capabilities.dockerPlatform;
  if (typeof platform !== "string" || platform.trim() === "") {
    throw SboxError.capability(
      "Host did not advertise dockerPlatform; upgrade sbox serve to a version that reports build platform.",
      { details: { unavailableReason: "missing_docker_platform" } },
    );
  }
  return platform;
}
