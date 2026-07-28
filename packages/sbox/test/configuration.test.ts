import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverProjectConfig,
  loadProjectConfigFromYaml,
  parseProjectConfig,
  parseYamlProjectInput,
  selectProfile,
  toSafeProjectConfig,
  tryParseProjectConfig,
  tryLoadProjectConfigFromYaml,
} from "../src/index.js";
import { resolveEnvironmentMap } from "../src/config/external.js";
import { requireLocalTarget, resolveTarget, selectTargetName } from "../src/config/targets.js";

const minimalProject = {
  version: 1 as const,
  project: "demo",
  defaultProfile: "default",
  profiles: {
    default: {
      image: "alpine:3.20",
      cpus: 1,
      memoryMiB: 512,
    },
  },
};

describe("typed project configuration", () => {
  it("accepts a complete typed configuration", () => {
    const config = parseProjectConfig({
      version: 1,
      project: "demo",
      defaultProfile: "dev",
      target: "local",
      volumes: { cache: { size: "1GiB" } },
      profiles: {
        dev: {
          image: "alpine:3.20",
          cpus: 2,
          memoryMiB: 1024,
          workdir: "/root",
          user: "root",
          shell: "/bin/sh",
          hostname: "dev",
          environment: {
            LITERAL: "ok",
            FROM_ENV: { env: "TOKEN" },
            FROM_FILE: { file: "./secret.txt" },
            FROM_INVOCATION: { invocation: "token" },
          },
          maxDurationSecs: 3600,
          idleTimeoutSecs: 600,
        },
      },
    });
    expect(config.project).toBe("demo");
    expect(config.profiles["dev"]?.memoryMiB).toBe(1024);
    expect(config.volumes?.["cache"]?.size).toBe("1GiB");
  });

  it("rejects unknown fields and wrong schema versions with accumulated issues", () => {
    const unknown = tryParseProjectConfig({
      version: 1,
      project: "demo",
      mystery: true,
      profiles: { default: { image: "alpine:3.20", extra: 1 } },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.issues.length).toBeGreaterThan(0);
      const blob = JSON.stringify(unknown.issues);
      expect(blob).toMatch(/unrecognized|Unrecognized|mystery|extra/i);
    }

    const version = tryParseProjectConfig({
      version: 2,
      project: "demo",
      profiles: { default: { image: "alpine:3.20" } },
    });
    expect(version.ok).toBe(false);
    if (!version.ok) {
      expect(
        version.issues.some(
          (issue) => issue.path.includes("version") || issue.message.includes("version"),
        ),
      ).toBe(true);
    }
  });

  it("rejects invalid portable project slugs", () => {
    expect(() =>
      parseProjectConfig({
        version: 1,
        project: "Bad_Slug",
        profiles: { default: { image: "alpine:3.20" } },
      }),
    ).toThrow(/validation/);
  });

  it("rejects missing and ambiguous default profile selection", () => {
    const missingDefault = tryParseProjectConfig({
      version: 1,
      project: "demo",
      defaultProfile: "missing",
      profiles: { default: { image: "alpine:3.20" } },
    });
    expect(missingDefault.ok).toBe(false);

    const config = parseProjectConfig({
      version: 1,
      project: "demo",
      profiles: {
        a: { image: "alpine:3.20" },
        b: { image: "alpine:3.20" },
      },
    });
    expect(() => selectProfile(config)).toThrow(/ambiguous/i);
    expect(selectProfile(config, "a").source).toBe("explicit");
  });

  it("selects defaultProfile and sole profile", () => {
    const withDefault = parseProjectConfig(minimalProject);
    expect(selectProfile(withDefault).source).toBe("default-profile");

    const sole = parseProjectConfig({
      version: 1,
      project: "demo",
      profiles: { only: { image: "alpine:3.20" } },
    });
    expect(selectProfile(sole).name).toBe("only");
    expect(selectProfile(sole).source).toBe("sole-profile");
  });

  it("does not support profile inheritance or interpolation", () => {
    const parsed = tryParseProjectConfig({
      version: 1,
      project: "demo",
      profiles: {
        base: { image: "alpine:3.20" },
        child: { extends: "base", image: "alpine:3.20" },
      },
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("YAML configuration adapter", () => {
  it("parses YAML with human memory and duration fields", () => {
    const config = loadProjectConfigFromYaml(`
version: 1
project: demo
defaultProfile: default
volumes:
  data:
    size: 4GiB
profiles:
  default:
    image: alpine:3.20
    cpus: 1
    memory: 512MiB
    tmp: 2GiB
    workdir: /root
    maxDuration: 1h
    idleTimeout: 10m
`);
    expect(config.profiles["default"]?.memoryMiB).toBe(512);
    expect(config.profiles["default"]?.tmpMiB).toBe(2048);
    expect(config.profiles["default"]?.maxDurationSecs).toBe(3600);
    expect(config.profiles["default"]?.idleTimeoutSecs).toBe(600);
  });

  it("rejects mounts and volumes at reserved /tmp", () => {
    const mountResult = tryLoadProjectConfigFromYaml(`
version: 1
project: demo
profiles:
  default:
    image: alpine:3.20
    mounts:
      - path: ./x
        mount: /tmp
`);
    expect(mountResult.ok).toBe(false);

    const volumeResult = tryLoadProjectConfigFromYaml(`
version: 1
project: demo
volumes:
  data:
    size: 1GiB
profiles:
  default:
    image: alpine:3.20
    volumes:
      - volume: data
        path: /tmp
`);
    expect(volumeResult.ok).toBe(false);
  });

  it("rejects unknown YAML fields and accumulates issues", () => {
    const result = tryLoadProjectConfigFromYaml(`
version: 1
project: demo
mystery: true
profiles:
  default:
    image: alpine:3.20
    extraField: 1
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(1);
    }
  });

  it("discovers upward and supports explicit paths with config-relative resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-config-"));
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    const configPath = join(root, "sbox.yaml");
    await writeFile(
      configPath,
      `
version: 1
project: demo
profiles:
  default:
    image: alpine:3.20
`,
      "utf8",
    );

    const discovered = await discoverProjectConfig({ cwd: nested });
    expect(discovered.source).toBe("nearest-ancestor");
    expect(discovered.path).toBe(configPath);

    const explicitAbs = await discoverProjectConfig({
      cwd: nested,
      configPath,
    });
    expect(explicitAbs.source).toBe("explicit");
    expect(explicitAbs.directory).toBe(root);
  });
});

describe("external references", () => {
  it("resolves invocation, environment, and file references and accumulates misses", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-ext-"));
    await writeFile(join(root, "token.txt"), "file-secret\n", "utf8");

    const ok = await resolveEnvironmentMap(
      {
        A: "literal",
        B: { env: "SBOX_TEST_TOKEN" },
        C: { file: "./token.txt" },
        D: { invocation: "token" },
      },
      {
        configDirectory: root,
        env: { SBOX_TEST_TOKEN: "env-secret" },
        invocation: { token: "inv-secret" },
      },
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.values).toEqual({
        A: "literal",
        B: "env-secret",
        C: "file-secret",
        D: "inv-secret",
      });
      expect(JSON.stringify(toSafeProjectConfig(parseProjectConfig(minimalProject)))).not.toContain(
        "env-secret",
      );
    }

    const emptyOk = await resolveEnvironmentMap(
      {
        EMPTY_ENV: { env: "EMPTY_VAR" },
        EMPTY_FILE: { file: "./empty.txt" },
        NEWLINE_FILE: { file: "./newline.txt" },
        EMPTY_INV: { invocation: "empty" },
      },
      {
        configDirectory: root,
        env: { EMPTY_VAR: "" },
        invocation: { empty: "" },
        readFile: async (path) => {
          if (path.endsWith("empty.txt")) {
            return "";
          }
          if (path.endsWith("newline.txt")) {
            return "\n";
          }
          throw new Error(`unexpected path ${path}`);
        },
      },
    );
    expect(emptyOk.ok).toBe(true);
    if (emptyOk.ok) {
      expect(emptyOk.values).toEqual({
        EMPTY_ENV: "",
        EMPTY_FILE: "",
        NEWLINE_FILE: "",
        EMPTY_INV: "",
      });
    }

    const missing = await resolveEnvironmentMap(
      {
        B: { env: "MISSING_ENV" },
        C: { file: "./missing.txt" },
        D: { invocation: "missing" },
      },
      { configDirectory: root, env: {}, invocation: {} },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues).toHaveLength(3);
      expect(JSON.stringify(missing.issues)).not.toContain("secret");
    }
  });

  it("redacts resolved external values in safe config projections", () => {
    const safe = toSafeProjectConfig(
      parseProjectConfig({
        version: 1,
        project: "demo",
        profiles: {
          default: {
            image: "alpine:3.20",
            environment: {
              LITERAL: "visible-but-classified",
              SECRET: { env: "TOKEN" },
            },
          },
        },
      }),
    );
    expect(safe.profiles["default"]?.environment).toEqual({
      LITERAL: "literal",
      SECRET: "env",
    });
    expect(JSON.stringify(safe)).not.toContain("visible-but-classified");
  });
});

describe("target precedence", () => {
  it("resolves explicit > project > user default > local", async () => {
    const project = parseProjectConfig({
      version: 1,
      project: "demo",
      target: "project-target",
      profiles: { default: { image: "alpine:3.20" } },
    });
    const user = {
      version: 1 as const,
      defaultTarget: "user-target",
      targets: {
        local: { kind: "local" as const },
        "project-target": { kind: "local" as const },
        "user-target": { kind: "local" as const },
        explicit: { kind: "local" as const },
      },
    };

    expect(selectTargetName({ project, user, explicitTarget: "explicit" }).source).toBe("explicit");
    expect(selectTargetName({ project, user }).source).toBe("project");
    expect(
      selectTargetName({
        project: parseProjectConfig(minimalProject),
        user,
      }).source,
    ).toBe("user-default");
    expect(
      selectTargetName({
        project: parseProjectConfig(minimalProject),
        user: { version: 1, targets: { local: { kind: "local" } } },
      }).source,
    ).toBe("implicit-local");

    const remote = await resolveTarget({
      project: parseProjectConfig(minimalProject),
      user: {
        version: 1,
        targets: {
          local: { kind: "local" },
          remote: {
            kind: "remote",
            url: "http://127.0.0.1:8787",
            token: { env: "SBOX_TOKEN" },
          },
        },
        defaultTarget: "remote",
      },
      external: { configDirectory: "/", env: { SBOX_TOKEN: "tok" } },
    });
    expect(remote.kind).toBe("remote");
    if (remote.kind === "remote") {
      expect(remote.token).toBe("tok");
    }

    await expect(
      requireLocalTarget({
        project: parseProjectConfig(minimalProject),
        user: {
          version: 1,
          defaultTarget: "remote",
          targets: {
            local: { kind: "local" },
            remote: {
              kind: "remote",
              url: "http://127.0.0.1:8787",
              token: { env: "SBOX_TOKEN" },
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "capability" });
  });
});

describe("no lifecycle catalog from configuration", () => {
  it("parsing configuration does not create durable workflow state", () => {
    const before = Object.keys(process.env).length;
    parseYamlProjectInput({
      version: 1,
      project: "demo",
      profiles: { default: { image: "alpine:3.20" } },
    });
    expect(Object.keys(process.env).length).toBe(before);
  });

  it("wraps validation failures as SboxError without leaking file contents", () => {
    expect(() => loadProjectConfigFromYaml("not: [unterminated")).toThrow(/validation|YAML/i);
  });
});
