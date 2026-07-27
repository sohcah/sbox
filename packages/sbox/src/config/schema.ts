/**
 * Strict Zod schemas for version-1 project and user configuration.
 */

import * as z from "zod";
import { isPortableSlug } from "../identity.js";
import { isAbsoluteGuestPath, isBinarySize, isEnvVarName, isPositiveDuration } from "./scalars.js";
import type { ProjectConfig, UserConfig } from "./types.js";

const portableSlugSchema = z
  .string()
  .refine((value) => isPortableSlug(value), {
    error: "Expected a lowercase portable slug.",
  })
  .describe("Portable lowercase slug.");

const envVarNameSchema = z.string().refine((value) => isEnvVarName(value), {
  error: "Expected an environment variable name matching [A-Za-z_][A-Za-z0-9_]*.",
});

const absoluteGuestPathSchema = z.string().refine((value) => isAbsoluteGuestPath(value), {
  error: "Expected an absolute POSIX guest path.",
});

const binarySizeSchema = z.string().refine((value) => isBinarySize(value), {
  error: 'Expected a positive binary size such as "512MiB" or "4GiB".',
});

const durationSchema = z.string().refine((value) => isPositiveDuration(value), {
  error: 'Expected a positive duration such as "30s", "10m", or "8h".',
});

const externalValueRefSchema = z.union([
  z.strictObject({ env: envVarNameSchema }),
  z.strictObject({ file: z.string().min(1) }),
  z.strictObject({ invocation: z.string().min(1) }),
]);

const configValueSchema = z.union([z.string(), externalValueRefSchema]);

const volumeDeclarationSchema = z.strictObject({
  size: binarySizeSchema,
});

const volumeAttachmentSchema = z.strictObject({
  volume: portableSlugSchema,
  path: absoluteGuestPathSchema,
});

const directoryMountSchema = z
  .strictObject({
    path: z.string().min(1),
    mount: absoluteGuestPathSchema,
    source: z.enum(["client", "host"]).optional(),
    readonly: z.boolean().optional(),
    quota: binarySizeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const source = value.source ?? "client";
    const readonly = value.readonly ?? true;
    if (source === "host") {
      const path = value.path;
      if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
        ctx.addIssue({
          code: "custom",
          path: ["path"],
          message: "Host path must be absolute.",
        });
      }
    }
    if (source === "client" && !readonly) {
      ctx.addIssue({
        code: "custom",
        path: ["readonly"],
        message: "Client-sourced directory mounts must be read-only.",
      });
    }
    if (readonly && value.quota !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["quota"],
        message: "Quota is only allowed for writable Host directory mounts.",
      });
    }
    if (!readonly && value.quota === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["quota"],
        message: "Writable Host directory mounts require an explicit quota.",
      });
    }
  });

const buildkitSecretIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, {
    error: "Expected a BuildKit secret id matching [A-Za-z_][A-Za-z0-9_.-]*.",
  });

const buildArgNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    error: "Expected a build-arg name matching [A-Za-z_][A-Za-z0-9_]*.",
  });

/** Dockerfile path relative to context: no absolute path, no escaping. */
function isInContextDockerfilePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0")) {
    return false;
  }
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }
  const parts = value.replace(/\\/g, "/").split("/");
  return !parts.some((part) => part === "" || part === "." || part === "..");
}

const dockerfilePathSchema = z.string().refine((value) => isInContextDockerfilePath(value), {
  error: "Dockerfile must be a relative path inside the build context.",
});

export const imageBuildConfigSchema = z.strictObject({
  context: z.string().min(1),
  dockerfile: dockerfilePathSchema.optional(),
  target: z.string().min(1).optional(),
  args: z.record(buildArgNameSchema, configValueSchema).optional(),
  secrets: z.record(buildkitSecretIdSchema, externalValueRefSchema).optional(),
  includeGit: z.boolean().optional(),
});

const networkPortSpecSchema = z.union([
  z.number().int().min(1).max(65535),
  z.strictObject({
    start: z.number().int().min(1).max(65535),
    end: z.number().int().min(1).max(65535),
  }),
]);

const networkProtocolSchema = z.enum(["tcp", "udp"]);

const networkAllowRuleRawSchema = z
  .strictObject({
    domain: z.string().min(1).optional(),
    suffix: z.string().min(1).optional(),
    ip: z.string().min(1).optional(),
    cidr: z.string().min(1).optional(),
    ports: z.array(networkPortSpecSchema).min(1).optional(),
    protocols: z.array(networkProtocolSchema).min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const kinds = [value.domain, value.suffix, value.ip, value.cidr].filter(
      (item) => item !== undefined,
    );
    if (kinds.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Specify exactly one of domain, suffix, ip, or cidr.",
      });
    }
  });

const networkAllowRuleTypedSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("domain"),
    domain: z.string().min(1),
    ports: z.array(networkPortSpecSchema).min(1).optional(),
    protocols: z.array(networkProtocolSchema).min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("suffix"),
    suffix: z.string().min(1),
    ports: z.array(networkPortSpecSchema).min(1).optional(),
    protocols: z.array(networkProtocolSchema).min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("ip"),
    ip: z.string().min(1),
    ports: z.array(networkPortSpecSchema).min(1).optional(),
    protocols: z.array(networkProtocolSchema).min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("cidr"),
    cidr: z.string().min(1),
    ports: z.array(networkPortSpecSchema).min(1).optional(),
    protocols: z.array(networkProtocolSchema).min(1).optional(),
  }),
]);

const networkAllowRuleSchema = z.union([networkAllowRuleTypedSchema, networkAllowRuleRawSchema]);

const networkPublishSchema = z.strictObject({
  guest: z.number().int().min(1).max(65535),
  host: z.number().int().min(0).max(65535).optional(),
  protocol: networkProtocolSchema.optional(),
  bind: z.string().min(1).optional(),
});

export const networkConfigSchema = z
  .strictObject({
    mode: z.enum(["disabled", "default-deny"]).optional(),
    allow: z.array(networkAllowRuleSchema).optional(),
    publish: z.array(networkPublishSchema).optional(),
  })
  .superRefine((value, ctx) => {
    const mode = value.mode ?? "default-deny";
    if (mode === "disabled") {
      if ((value.allow?.length ?? 0) > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["allow"],
          message: "Network allow rules are not permitted when mode is disabled.",
        });
      }
      if ((value.publish?.length ?? 0) > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["publish"],
          message: "Published ports are not permitted when mode is disabled.",
        });
      }
    }
  });

export const runtimeSecretConfigSchema = z.strictObject({
  env: envVarNameSchema,
  value: externalValueRefSchema,
  placeholder: z.string().min(1).optional(),
  destinations: z.array(z.string().min(1)).min(1),
});

const profileCommonFields = {
  cpus: z.number().int().positive().optional(),
  memoryMiB: z.number().int().positive().optional(),
  workdir: absoluteGuestPathSchema.optional(),
  user: z.string().min(1).optional(),
  shell: absoluteGuestPathSchema.optional(),
  hostname: z.string().min(1).optional(),
  environment: z.record(envVarNameSchema, configValueSchema).optional(),
  maxDurationSecs: z.number().int().positive().nullable().optional(),
  idleTimeoutSecs: z.number().int().positive().nullable().optional(),
  network: networkConfigSchema.optional(),
  secrets: z.array(runtimeSecretConfigSchema).optional(),
  volumes: z.array(volumeAttachmentSchema).optional(),
  directories: z.array(directoryMountSchema).optional(),
} as const;

function refineImageOrBuild(
  value: { readonly image?: string | undefined; readonly build?: unknown },
  ctx: z.RefinementCtx,
  pathPrefix: readonly (string | number)[] = [],
): void {
  const hasImage = value.image !== undefined;
  const hasBuild = value.build !== undefined;
  if (hasImage && hasBuild) {
    ctx.addIssue({
      code: "custom",
      path: [...pathPrefix, "image"],
      message: 'Specify only one of "image" or "build".',
    });
    ctx.addIssue({
      code: "custom",
      path: [...pathPrefix, "build"],
      message: 'Specify only one of "image" or "build".',
    });
    return;
  }
  if (!hasImage && !hasBuild) {
    ctx.addIssue({
      code: "custom",
      path: [...pathPrefix, "image"],
      message: 'Specify exactly one of "image" or "build".',
    });
    ctx.addIssue({
      code: "custom",
      path: [...pathPrefix, "build"],
      message: 'Specify exactly one of "image" or "build".',
    });
  }
}

/**
 * Typed profile schema (primary API). Memory and durations are numeric seconds/MiB.
 */
export const profileConfigSchema = z
  .strictObject({
    image: z.string().min(1).optional(),
    build: imageBuildConfigSchema.optional(),
    ...profileCommonFields,
  })
  .superRefine((value, ctx) => {
    refineImageOrBuild(value, ctx);
  });

export const projectConfigSchema = z
  .strictObject({
    version: z.literal(1),
    project: portableSlugSchema,
    defaultProfile: portableSlugSchema.optional(),
    target: portableSlugSchema.optional(),
    volumes: z.record(portableSlugSchema, volumeDeclarationSchema).optional(),
    profiles: z
      .record(portableSlugSchema, profileConfigSchema)
      .refine((profiles) => Object.keys(profiles).length > 0, {
        error: "At least one profile is required.",
      }),
  })
  .superRefine((value, ctx) => {
    if (value.defaultProfile !== undefined && !(value.defaultProfile in value.profiles)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultProfile"],
        message: `defaultProfile "${value.defaultProfile}" does not exist in profiles.`,
      });
    }
    refineProfileVolumeAttachments(value, ctx);
  });

const localTargetSchema = z.strictObject({
  kind: z.literal("local"),
});

const remoteTargetSchema = z.strictObject({
  kind: z.literal("remote"),
  url: z.url({ protocol: /^https?$/ }),
  token: externalValueRefSchema,
});

const targetConfigSchema = z.discriminatedUnion("kind", [localTargetSchema, remoteTargetSchema]);

export const userConfigSchema = z
  .strictObject({
    version: z.literal(1),
    defaultTarget: portableSlugSchema.optional(),
    targets: z.record(portableSlugSchema, targetConfigSchema).default({
      local: { kind: "local" },
    }),
  })
  .superRefine((value, ctx) => {
    if (value.defaultTarget !== undefined && !(value.defaultTarget in value.targets)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultTarget"],
        message: `defaultTarget "${value.defaultTarget}" does not exist in targets.`,
      });
    }
  });

/**
 * YAML-oriented profile input. Accepts human memory/duration strings that the
 * YAML adapter normalizes into the typed model.
 */
export const yamlProfileInputSchema = z
  .strictObject({
    image: z.string().min(1).optional(),
    build: imageBuildConfigSchema.optional(),
    cpus: z.number().int().positive().optional(),
    memoryMiB: z.number().int().positive().optional(),
    memory: binarySizeSchema.optional(),
    workdir: absoluteGuestPathSchema.optional(),
    user: z.string().min(1).optional(),
    shell: absoluteGuestPathSchema.optional(),
    hostname: z.string().min(1).optional(),
    environment: z.record(envVarNameSchema, configValueSchema).optional(),
    maxDurationSecs: z.number().int().positive().nullable().optional(),
    idleTimeoutSecs: z.number().int().positive().nullable().optional(),
    maxDuration: durationSchema.nullable().optional(),
    idleTimeout: durationSchema.nullable().optional(),
    network: networkConfigSchema.optional(),
    secrets: z.array(runtimeSecretConfigSchema).optional(),
    volumes: z.array(volumeAttachmentSchema).optional(),
    directories: z.array(directoryMountSchema).optional(),
  })
  .superRefine((value, ctx) => {
    refineImageOrBuild(value, ctx);
  });

export const yamlProjectInputSchema = z
  .strictObject({
    version: z.literal(1),
    project: portableSlugSchema,
    defaultProfile: portableSlugSchema.optional(),
    target: portableSlugSchema.optional(),
    volumes: z.record(portableSlugSchema, volumeDeclarationSchema).optional(),
    profiles: z
      .record(portableSlugSchema, yamlProfileInputSchema)
      .refine((profiles) => Object.keys(profiles).length > 0, {
        error: "At least one profile is required.",
      }),
  })
  .superRefine((value, ctx) => {
    if (value.defaultProfile !== undefined && !(value.defaultProfile in value.profiles)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultProfile"],
        message: `defaultProfile "${value.defaultProfile}" does not exist in profiles.`,
      });
    }
    refineProfileVolumeAttachments(value, ctx);
    refineProfileDirectoryMounts(value, ctx);
    for (const [name, profile] of Object.entries(value.profiles)) {
      if (profile.memory !== undefined && profile.memoryMiB !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", name, "memory"],
          message: 'Specify only one of "memory" or "memoryMiB".',
        });
      }
      if (profile.maxDuration !== undefined && profile.maxDurationSecs !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", name, "maxDuration"],
          message: 'Specify only one of "maxDuration" or "maxDurationSecs".',
        });
      }
      if (profile.idleTimeout !== undefined && profile.idleTimeoutSecs !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", name, "idleTimeout"],
          message: 'Specify only one of "idleTimeout" or "idleTimeoutSecs".',
        });
      }
    }
  });

export type YamlProjectInput = z.infer<typeof yamlProjectInputSchema>;
export type ParsedProjectConfig = ProjectConfig;
export type ParsedUserConfig = UserConfig;

function refineProfileVolumeAttachments(
  value: {
    readonly volumes?: Readonly<Record<string, { readonly size: string }>> | undefined;
    readonly profiles: Readonly<
      Record<
        string,
        {
          readonly volumes?:
            | readonly { readonly volume: string; readonly path: string }[]
            | undefined;
          readonly directories?: readonly { readonly mount: string }[] | undefined;
        }
      >
    >;
  },
  ctx: z.RefinementCtx,
): void {
  const declared = value.volumes ?? {};
  for (const [profileName, profile] of Object.entries(value.profiles)) {
    const attachments = profile.volumes;
    if (attachments === undefined || attachments.length === 0) {
      continue;
    }
    const seenVolumes = new Set<string>();
    const seenPaths = new Set<string>();
    for (let i = 0; i < attachments.length; i += 1) {
      const attachment = attachments[i]!;
      const pathPrefix = ["profiles", profileName, "volumes", i] as const;
      if (!(attachment.volume in declared)) {
        ctx.addIssue({
          code: "custom",
          path: [...pathPrefix, "volume"],
          message: `Volume "${attachment.volume}" is not declared in project volumes.`,
        });
      }
      if (seenVolumes.has(attachment.volume)) {
        ctx.addIssue({
          code: "custom",
          path: [...pathPrefix, "volume"],
          message: `Volume "${attachment.volume}" is attached more than once in this profile.`,
        });
      }
      seenVolumes.add(attachment.volume);
      if (seenPaths.has(attachment.path)) {
        ctx.addIssue({
          code: "custom",
          path: [...pathPrefix, "path"],
          message: `Guest path "${attachment.path}" is used by more than one volume attachment.`,
        });
      }
      seenPaths.add(attachment.path);
    }
  }
}

function refineProfileDirectoryMounts(
  value: {
    readonly profiles: Readonly<
      Record<
        string,
        {
          readonly volumes?:
            | readonly { readonly volume: string; readonly path: string }[]
            | undefined;
          readonly directories?: readonly { readonly mount: string }[] | undefined;
        }
      >
    >;
  },
  ctx: z.RefinementCtx,
): void {
  for (const [profileName, profile] of Object.entries(value.profiles)) {
    const seenPaths = new Set<string>();
    for (const attachment of profile.volumes ?? []) {
      seenPaths.add(attachment.path);
    }
    const directories = profile.directories;
    if (directories === undefined) {
      continue;
    }
    for (let i = 0; i < directories.length; i += 1) {
      const entry = directories[i]!;
      const pathPrefix = ["profiles", profileName, "directories", i] as const;
      if (seenPaths.has(entry.mount)) {
        ctx.addIssue({
          code: "custom",
          path: [...pathPrefix, "mount"],
          message: `Guest path "${entry.mount}" is already used by a volume or directory mount.`,
        });
      }
      seenPaths.add(entry.mount);
    }
  }
}
