/**
 * Zod schemas for remote HTTP JSON DTOs.
 */

import { z } from "zod";
import { isAbsoluteOrHomeRelativeHostPath } from "../directory/home-path.js";

const portableSlug = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

export const identitySchema = z.object({
  project: portableSlug,
  profile: portableSlug,
  instance: portableSlug,
});

const networkPortSpecSchema = z.union([
  z.number().int().min(1).max(65535),
  z.object({
    start: z.number().int().min(1).max(65535),
    end: z.number().int().min(1).max(65535),
  }),
]);

const networkAllowRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("domain"),
    domain: z.string().min(1),
    ports: z.array(networkPortSpecSchema).optional(),
    protocols: z.array(z.enum(["tcp", "udp"])).optional(),
  }),
  z.object({
    kind: z.literal("suffix"),
    suffix: z.string().min(1),
    ports: z.array(networkPortSpecSchema).optional(),
    protocols: z.array(z.enum(["tcp", "udp"])).optional(),
  }),
  z.object({
    kind: z.literal("ip"),
    ip: z.string().min(1),
    ports: z.array(networkPortSpecSchema).optional(),
    protocols: z.array(z.enum(["tcp", "udp"])).optional(),
  }),
  z.object({
    kind: z.literal("cidr"),
    cidr: z.string().min(1),
    ports: z.array(networkPortSpecSchema).optional(),
    protocols: z.array(z.enum(["tcp", "udp"])).optional(),
  }),
]);

const publishedPortSchema = z.object({
  guest: z.number().int().min(1).max(65535),
  host: z.number().int().min(0).max(65535).optional(),
  protocol: z.enum(["tcp", "udp"]).optional(),
  bind: z.string().min(1).optional(),
});

const hostNetworkSchema = z.object({
  mode: z.enum(["disabled", "default-deny"]),
  allow: z.array(networkAllowRuleSchema),
  publish: z.array(publishedPortSchema),
});

const resolvedSecretSchema = z.object({
  env: z.string().min(1),
  value: z.string(),
  placeholder: z.string().min(1),
  destinations: z.array(z.string().min(1)),
});

const volumeAttachmentSchema = z.object({
  volume: portableSlug,
  path: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});

const hostMountSchema = z
  .object({
    source: z.enum(["client", "host"]),
    path: z.string().min(1),
    mount: z.string().min(1),
    readonly: z.boolean(),
    kind: z.enum(["file", "directory"]).optional(),
    quotaMiB: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source === "host") {
      if (!isAbsoluteOrHomeRelativeHostPath(value.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["path"],
          message: 'Host path must be absolute or home-relative (starting with "~/").',
        });
      }
    }
    if (value.source === "client" && !value.readonly) {
      ctx.addIssue({
        code: "custom",
        path: ["readonly"],
        message: "Client-sourced Host mounts must be read-only.",
      });
    }
    if (value.readonly && value.quotaMiB !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["quotaMiB"],
        message: "Quota is only allowed for writable Host mounts.",
      });
    }
  });

export const createRequestSchema = z.object({
  identity: identitySchema,
  image: z.string().min(1),
  cpus: z.number().int().positive().optional(),
  memoryMiB: z.number().int().positive().optional(),
  workdir: z.string().optional(),
  user: z.string().optional(),
  shell: z.string().optional(),
  hostname: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  maxDurationSecs: z.number().int().nonnegative().nullable().optional(),
  idleTimeoutSecs: z.number().int().nonnegative().nullable().optional(),
  network: hostNetworkSchema.optional(),
  secrets: z.array(resolvedSecretSchema).optional(),
  volumes: z.array(volumeAttachmentSchema).optional(),
  mounts: z.array(hostMountSchema).optional(),
});

export const listSandboxesQuerySchema = z.object({
  project: portableSlug.optional(),
});

export const ensureVolumeRequestSchema = z.object({
  project: portableSlug,
  volume: portableSlug,
  sizeBytes: z.number().int().positive(),
});

export const removeVolumeRequestSchema = z.object({
  project: portableSlug,
  volume: portableSlug,
});

export const volumeShellRequestSchema = z.object({
  project: portableSlug,
  volume: portableSlug,
  sizeBytes: z.number().int().positive(),
  profile: portableSlug,
  image: z.string().min(1),
  cpus: z.number().int().positive().optional(),
  memoryMiB: z.number().int().positive().optional(),
  workdir: z.string().optional(),
  user: z.string().optional(),
  shell: z.string().optional(),
  hostname: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  maxDurationSecs: z.number().int().nonnegative().nullable().optional(),
  idleTimeoutSecs: z.number().int().nonnegative().nullable().optional(),
  path: z.string().min(1),
});

export const ensureImageMetaSchema = z.object({
  dockerfile: z.string().min(1),
  platform: z.string().min(1),
  target: z.string().optional(),
  args: z.record(z.string(), z.string()),
  secrets: z.record(z.string(), z.string()),
  includeGit: z.boolean(),
  force: z.boolean().optional(),
});

export const collectedExecSchema = z.object({
  identity: identitySchema,
  argv: z.array(z.string()).optional(),
  script: z.string().optional(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  user: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  stdin: z.string().optional(),
  maxStdoutBytes: z.number().int().positive().optional(),
  maxStderrBytes: z.number().int().positive().optional(),
});

export const transferMetaSchema = z.object({
  identity: identitySchema,
  guestPath: z.string().min(1),
  overwrite: z.enum(["error", "replace"]).optional(),
});

export const listImagesQuerySchema = z.object({
  includeUnowned: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
});

export const removeImageBodySchema = z.object({
  reference: z.string().min(1),
  force: z.boolean().optional(),
});

export const sessionStartSchema = z.discriminatedUnion("kind", [
  z.object({
    type: z.literal("start"),
    kind: z.literal("argv"),
    identity: identitySchema,
    argv: z.array(z.string()).min(1),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    user: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("start"),
    kind: z.literal("shell"),
    identity: identitySchema,
    script: z.string().min(1),
    shell: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    user: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("start"),
    kind: z.literal("pty"),
    identity: identitySchema,
    argv: z.array(z.string()).min(1),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    user: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
    cols: z.number().int().positive().optional(),
  }),
]);

export const sessionControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdin_end") }),
  z.object({ type: z.literal("cancel"), reason: z.string().optional() }),
  /**
   * Client `wait()` for hosts that settle only when wait is observed (FakePty).
   * No-op for real PTYs that already exit independently.
   */
  z.object({ type: z.literal("complete") }),
  z.object({
    type: z.literal("resize"),
    rows: z.number().int().positive(),
    cols: z.number().int().positive(),
  }),
]);
