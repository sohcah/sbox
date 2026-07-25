/**
 * Host architecture → Docker `--platform` for Phase 4 (host arch only).
 */

import { SboxError } from "../errors.js";

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
