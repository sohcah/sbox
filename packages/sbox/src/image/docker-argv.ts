/**
 * Exact argv encoding for Docker and `msb image` without shell interpolation.
 */

export interface DockerBuildSecretRef {
  readonly id: string;
  readonly src: string;
}

export interface DockerBuildRequest {
  readonly context: string;
  readonly dockerfile: string;
  readonly tag: string;
  readonly platform: string;
  readonly target?: string;
  readonly args?: Readonly<Record<string, string>>;
  readonly secrets?: readonly DockerBuildSecretRef[];
  readonly labels?: Readonly<Record<string, string>>;
}

export function encodeDockerBuild(request: DockerBuildRequest): {
  readonly executable: "docker";
  readonly args: readonly string[];
} {
  const args: string[] = [
    "build",
    "--file",
    request.dockerfile,
    "--tag",
    request.tag,
    "--platform",
    request.platform,
  ];
  if (request.target !== undefined && request.target !== "") {
    args.push("--target", request.target);
  }
  const buildArgs = request.args ?? {};
  for (const key of Object.keys(buildArgs).toSorted()) {
    args.push("--build-arg", `${key}=${buildArgs[key] ?? ""}`);
  }
  const secrets = [...(request.secrets ?? [])].toSorted((left, right) =>
    left.id.localeCompare(right.id),
  );
  for (const secret of secrets) {
    args.push("--secret", `id=${secret.id},src=${secret.src}`);
  }
  const labels = request.labels ?? {};
  for (const key of Object.keys(labels).toSorted()) {
    args.push("--label", `${key}=${labels[key] ?? ""}`);
  }
  args.push(request.context);
  return { executable: "docker", args };
}

export function encodeDockerSave(
  tag: string,
  outputPath: string,
): {
  readonly executable: "docker";
  readonly args: readonly string[];
} {
  return { executable: "docker", args: ["save", "--output", outputPath, tag] };
}

export function encodeDockerImageRemove(tag: string): {
  readonly executable: "docker";
  readonly args: readonly string[];
} {
  return { executable: "docker", args: ["image", "rm", "--force", tag] };
}

export function encodeDockerCreate(tag: string): {
  readonly executable: "docker";
  readonly args: readonly string[];
} {
  return { executable: "docker", args: ["create", tag] };
}

export function encodeDockerCommit(
  containerId: string,
  tag: string,
  changes: readonly string[],
): {
  readonly executable: "docker";
  readonly args: readonly string[];
} {
  const args: string[] = ["commit"];
  for (const change of changes) {
    args.push("--change", change);
  }
  args.push(containerId, tag);
  return { executable: "docker", args };
}

export function encodeDockerContainerRemove(containerId: string): {
  readonly executable: "docker";
  readonly args: readonly string[];
} {
  return { executable: "docker", args: ["rm", "--force", containerId] };
}

export function encodeMsbImageLoad(
  inputPath: string,
  tag: string,
): {
  readonly executable: "msb";
  readonly args: readonly string[];
} {
  return {
    executable: "msb",
    args: ["image", "load", "--input", inputPath, "--tag", tag, "--quiet"],
  };
}
