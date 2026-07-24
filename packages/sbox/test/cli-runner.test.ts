import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXIT_ALREADY_EXISTS,
  EXIT_NOT_FOUND,
  EXIT_SUCCESS,
  EXIT_VALIDATION,
} from "../src/index.js";
import { runCli } from "../src/cli/runner.js";
import { FakeHost } from "../src/fake-host.js";
import { loadProjectConfigFromYaml } from "../src/config/yaml.js";

function collectingIo(cwd: string, env: Record<string, string | undefined> = {}) {
  let stdout = "";
  let stderr = "";
  return {
    stdoutText: () => stdout,
    stderrText: () => stderr,
    io: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
        },
      },
      cwd,
      env,
      homeDir: cwd,
      platform: "linux" as const,
    },
  };
}

async function writeProject(dir: string, body?: string): Promise<void> {
  await writeFile(
    join(dir, "sbox.yaml"),
    body ??
      `
version: 1
project: demo
defaultProfile: default
profiles:
  default:
    image: alpine:3.20
    cpus: 1
    memory: 512MiB
    workdir: /root
`,
    "utf8",
  );
}

describe("CLI runner", () => {
  it("parses commands and formats text/json without process.exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-"));
    await writeProject(root);
    const host = new FakeHost();
    const collected = collectingIo(root);

    const help = await runCli({ argv: ["--help"], io: collected.io, host });
    expect(help).toBe(EXIT_SUCCESS);
    expect(collected.stdoutText()).toMatch(/sbox up/);

    const validate = await runCli({
      argv: ["config", "validate", "--json"],
      io: collected.io,
      host,
    });
    expect(validate).toBe(EXIT_SUCCESS);
    expect(collected.stdoutText()).toContain('"ok": true');

    const up = await runCli({
      argv: ["up", "default", "--json"],
      io: collectingIo(root).io,
      host,
    });
    expect(up).toBe(EXIT_SUCCESS);

    const list = collectingIo(root);
    const listCode = await runCli({ argv: ["list", "--json"], io: list.io, host });
    expect(listCode).toBe(EXIT_SUCCESS);
    expect(list.stdoutText()).toContain('"instance": "default"');

    const inspect = collectingIo(root);
    expect(await runCli({ argv: ["inspect", "default", "--json"], io: inspect.io, host })).toBe(
      EXIT_SUCCESS,
    );

    const stop = collectingIo(root);
    expect(await runCli({ argv: ["stop", "default", "--json"], io: stop.io, host })).toBe(
      EXIT_SUCCESS,
    );

    const remove = collectingIo(root);
    expect(await runCli({ argv: ["remove", "default", "--json"], io: remove.io, host })).toBe(
      EXIT_SUCCESS,
    );

    const missing = collectingIo(root);
    expect(await runCli({ argv: ["inspect", "default", "--json"], io: missing.io, host })).toBe(
      EXIT_NOT_FOUND,
    );
  });

  it("init writes sbox.yaml and validate fails with exit 2 on bad config", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-init-"));
    const initIo = collectingIo(root);
    expect(await runCli({ argv: ["init", "--project", "demo"], io: initIo.io })).toBe(EXIT_SUCCESS);
    const body = await readFile(join(root, "sbox.yaml"), "utf8");
    expect(loadProjectConfigFromYaml(body).project).toBe("demo");

    await writeFile(join(root, "sbox.yaml"), "version: 9\nproject: demo\nprofiles: {}\n", "utf8");
    const bad = collectingIo(root);
    expect(await runCli({ argv: ["config", "validate", "--json"], io: bad.io })).toBe(
      EXIT_VALIDATION,
    );
    expect(bad.stdoutText()).toContain('"ok": false');
  });

  it.each([["Demo"], ["bad_slug"], ["has space"], ["has:colon"], ['has"quote'], ["line\nbreak"]])(
    "init rejects invalid --project %j without writing a file",
    async (project) => {
      const root = await mkdtemp(join(tmpdir(), "sbox-cli-init-bad-"));
      const collected = collectingIo(root);
      expect(await runCli({ argv: ["init", "--project", project], io: collected.io })).toBe(
        EXIT_VALIDATION,
      );
      await expect(access(join(root, "sbox.yaml"), fsConstants.F_OK)).rejects.toBeTruthy();
    },
  );

  it("init --force keeps the published file when stdout fails after write", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-init-force-"));
    const path = join(root, "sbox.yaml");
    await writeFile(
      path,
      `version: 1
project: original
defaultProfile: default
profiles:
  default:
    image: alpine:3.20
    cpus: 1
    memory: 512MiB
`,
      "utf8",
    );

    const io = {
      ...collectingIo(root).io,
      stdout: {
        write(_chunk: string): void {
          throw new Error("stdout failed");
        },
      },
    };

    await expect(
      runCli({
        argv: ["init", "--force", "--project", "replaced"],
        io,
      }),
    ).rejects.toThrow("stdout failed");

    const body = await readFile(path, "utf8");
    expect(loadProjectConfigFromYaml(body).project).toBe("replaced");
    expect(body).toContain("alpine:3.20");
  });

  it("init failure before publication preserves an existing config", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-init-preserve-"));
    const path = join(root, "sbox.yaml");
    const original = `version: 1
project: keep-me
defaultProfile: default
profiles:
  default:
    image: alpine:3.19
    cpus: 2
    memory: 1024MiB
`;
    await writeFile(path, original, "utf8");

    expect(
      await runCli({
        argv: ["init", "--project", "would-replace"],
        io: collectingIo(root).io,
      }),
    ).toBe(EXIT_ALREADY_EXISTS);
    expect(await readFile(path, "utf8")).toBe(original);

    expect(
      await runCli({
        argv: ["init", "--force", "--project", "BadProject"],
        io: collectingIo(root).io,
      }),
    ).toBe(EXIT_VALIDATION);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("config show redacts external values", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-cli-show-"));
    await mkdir(root, { recursive: true });
    await writeProject(
      root,
      `
version: 1
project: demo
profiles:
  default:
    image: alpine:3.20
    environment:
      TOKEN:
        env: SECRET_TOKEN
`,
    );
    const collected = collectingIo(root, { SECRET_TOKEN: "super-secret-value" });
    expect(await runCli({ argv: ["config", "show", "--json"], io: collected.io })).toBe(
      EXIT_SUCCESS,
    );
    expect(collected.stdoutText()).not.toContain("super-secret-value");
    expect(collected.stdoutText()).toContain('"TOKEN": "env"');
  });
});
