/**
 * Unit coverage for the Sandcastle isolated handle over FakeHost.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createSboxClient,
  parseProjectConfig,
  SboxError,
  utf8ToBytes,
  type SboxClient,
} from "@sohcah/sbox";
import { createSboxSandcastleProvider } from "../src/index.js";
import { FakeHost } from "../../sbox/src/fake-host.js";
import { defaultFakeExec } from "../../sbox/src/fake-process.js";

function project() {
  return parseProjectConfig({
    version: 1,
    project: "demo",
    defaultProfile: "default",
    profiles: {
      default: {
        image: "alpine:3.20",
        cpus: 1,
        memoryMiB: 512,
        shell: "/bin/sh",
        workdir: "/workspace",
      },
    },
  });
}

async function openClient(host: FakeHost): Promise<SboxClient> {
  return createSboxClient({
    project: project(),
    host,
    ownsHost: false,
  });
}

describe("sbox-sandcastle handle", () => {
  it("creates a unique sandbox and exposes absolute worktreePath", async () => {
    const host = new FakeHost();
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client, worktreePath: "/workspace" });
      const a = await provider.create({ env: {} });
      const b = await provider.create({ env: {} });
      expect(a.worktreePath).toBe("/workspace");
      const listed = await client.list();
      expect(listed).toHaveLength(2);
      expect(listed[0]!.identity.instance).not.toBe(listed[1]!.identity.instance);
      await a.close();
      await b.close();
      expect(await client.list()).toHaveLength(0);
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  it("exec supports cwd, sudo→root, stdin, and collected result", async () => {
    const host = new FakeHost();
    let capturedUser: string | undefined;
    let capturedCwd: string | undefined;
    let capturedStdin: Uint8Array | undefined;
    const originalShell = host.execShell.bind(host);
    host.execShell = async (request, options) => {
      capturedUser = options?.user;
      capturedCwd = options?.cwd;
      capturedStdin =
        typeof options?.stdin === "string"
          ? utf8ToBytes(options.stdin)
          : options?.stdin instanceof Uint8Array
            ? options.stdin
            : undefined;
      return originalShell(request, options);
    };
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client });
      const handle = await provider.create({ env: {} });
      const result = await handle.exec("echo hi", {
        cwd: "/tmp",
        sudo: true,
        stdin: "payload",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("shell:echo hi");
      expect(capturedUser).toBe("root");
      expect(capturedCwd).toBe("/tmp");
      expect(Buffer.from(capturedStdin ?? new Uint8Array()).toString("utf8")).toBe("payload");
      await handle.close();
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  it("onLine receives live lines from stdout and stderr including a final partial", async () => {
    const host = new FakeHost();
    host.execHandler = async () => ({
      exitCode: 0,
      stdout: utf8ToBytes("out1\nout2\n"),
      stderr: utf8ToBytes("err1\npartial"),
    });
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client });
      const handle = await provider.create({ env: {} });
      const lines: string[] = [];
      const result = await handle.exec("mixed", {
        onLine: (line) => {
          lines.push(line);
        },
      });
      expect(lines).toEqual(["out1", "out2", "err1", "partial"]);
      expect(result.stdout).toBe("out1\nout2\n");
      expect(result.stderr).toBe("err1\npartial");
      await handle.close();
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  it("interactiveExec merges PTY output when stdin is a TTY", async () => {
    const host = new FakeHost();
    let resized = false;
    host.pty = async (request, options) => {
      expect(request.argv).toEqual(["/bin/sh"]);
      expect(options?.cwd).toBe("/workspace");
      return {
        output: (async function* () {
          yield utf8ToBytes("merged-out");
        })(),
        write: async () => {},
        resize: async () => {
          resized = true;
        },
        wait: async () => {
          // Hold the session open long enough for the resize listener to fire.
          await new Promise<void>((resolve) => setTimeout(resolve, 80));
          return { exitCode: 0, signal: null };
        },
        cancel: async () => {},
        async [Symbol.asyncDispose]() {},
      };
    };
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client });
      const handle = await provider.create({ env: {} });
      const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
      stdin.isTTY = true;
      const stdout = new PassThrough() as PassThrough & {
        rows?: number;
        columns?: number;
      };
      stdout.rows = 30;
      stdout.columns = 100;
      const stderr = new PassThrough();
      let out = "";
      stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });

      const done = handle.interactiveExec!(["/bin/sh"], { stdin, stdout, stderr });
      // Wait until interactiveExec has registered the resize listener (after pty()).
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      stdout.emit("resize");
      await expect.poll(() => resized).toBe(true);
      stdin.end();
      await expect(done).resolves.toEqual({ exitCode: 0 });
      expect(out).toBe("merged-out");
      await handle.close();
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  it("interactiveExec pipes separate streams when stdin is not a TTY", async () => {
    const host = new FakeHost();
    host.execHandler = async () => ({
      exitCode: 0,
      stdout: utf8ToBytes("OUT"),
      stderr: utf8ToBytes("ERR"),
    });
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client });
      const handle = await provider.create({ env: {} });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = "";
      let err = "";
      stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString("utf8");
      });
      const done = handle.interactiveExec!(["echo"], { stdin, stdout, stderr });
      stdin.end();
      await expect(done).resolves.toEqual({ exitCode: 0 });
      expect(out).toBe("OUT");
      expect(err).toBe("ERR");
      expect(host.operations).toContain("execArgvStream");
      await handle.close();
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  it("copyIn is recursive and copyFileOut is single-file only", async () => {
    const host = new FakeHost();
    host.execHandler = async (argv, stdin) => {
      if (argv[0] === "test" && argv[1] === "-f") {
        const guestPath = argv[2]!;
        // Resolve identity from any running sandbox.
        const listed = [...(await host.list())];
        const id = listed[0]!.identity;
        const node = host.filesystemFor(id).get(guestPath);
        return {
          exitCode: node?.kind === "file" ? 0 : 1,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
      return defaultFakeExec(argv, stdin);
    };
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client });
      const handle = await provider.create({ env: {} });
      const root = await mkdtemp(join(tmpdir(), "sbox-sc-copy-"));
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, "nested", "a.txt"), "alpha", "utf8");
      await writeFile(join(root, "file.txt"), "beta", "utf8");

      await handle.copyIn(root, "/tree");
      const listed = await client.list();
      const fs = host.filesystemFor(listed[0]!.identity);
      expect(fs.get("/tree/nested/a.txt")?.kind).toBe("file");
      expect(fs.get("/tree/file.txt")?.kind).toBe("file");

      const outFile = join(root, "out.txt");
      await handle.copyFileOut("/tree/file.txt", outFile);
      expect(await readFile(outFile, "utf8")).toBe("beta");

      await expect(handle.copyFileOut("/tree", join(root, "bad"))).rejects.toMatchObject({
        code: "validation",
      });

      await handle.close();
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  it("close is idempotent and treats already-absent as success", async () => {
    const host = new FakeHost();
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client });
      const handle = await provider.create({ env: {} });
      const listed = await client.list();
      await client.remove(listed[0]!.identity);
      await handle.close();
      await handle.close();
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  it("retries close after a transient remove failure", async () => {
    const host = new FakeHost();
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client });
      const handle = await provider.create({ env: {} });
      let removeAttempts = 0;
      const originalRemove = host.remove.bind(host);
      host.remove = async (identity, options) => {
        removeAttempts += 1;
        if (removeAttempts === 1) {
          throw SboxError.busy("remove temporarily busy");
        }
        return originalRemove(identity, options);
      };

      await expect(handle.close()).rejects.toMatchObject({ code: "busy" });
      expect(await client.list()).toHaveLength(1);
      // Failed close must not reopen the handle for new work.
      await expect(handle.exec("echo hi")).rejects.toMatchObject({ code: "validation" });

      await handle.close();
      expect(await client.list()).toHaveLength(0);
      await handle.close();
      expect(removeAttempts).toBe(2);
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  it("awaits in-flight session starts and disposes them on close", async () => {
    const host = new FakeHost();
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client });
      const handle = await provider.create({ env: {} });
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      let disposed = false;
      const originalStream = host.execShellStream.bind(host);
      host.execShellStream = async (request, options) => {
        await streamGate;
        const session = await originalStream(request, options);
        const originalDispose = session[Symbol.asyncDispose].bind(session);
        session[Symbol.asyncDispose] = async () => {
          disposed = true;
          await originalDispose();
        };
        return session;
      };

      const live = handle.exec("echo live", {
        onLine: () => undefined,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const closing = handle.close();
      releaseStream();
      await expect(live).rejects.toMatchObject({ code: "validation" });
      await closing;
      expect(disposed).toBe(true);
      expect(await client.list()).toHaveLength(0);
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  it("rejects new operations while close is in flight", async () => {
    const host = new FakeHost();
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client });
      const handle = await provider.create({ env: {} });
      let releaseRemove!: () => void;
      const removeGate = new Promise<void>((resolve) => {
        releaseRemove = resolve;
      });
      const originalRemove = host.remove.bind(host);
      host.remove = async (identity, options) => {
        await removeGate;
        return originalRemove(identity, options);
      };

      const closing = handle.close();
      await expect(handle.exec("echo hi")).rejects.toMatchObject({ code: "validation" });
      releaseRemove();
      await closing;
      await expect(handle.exec("echo hi")).rejects.toMatchObject({ code: "validation" });
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  it("interactiveExec surfaces cancellation when close disposes the PTY", async () => {
    const host = new FakeHost();
    let cancelCalled = false;
    host.pty = async () => {
      let rejectWait!: (error: unknown) => void;
      const waitBarrier = new Promise<{ exitCode: number; signal: string | null }>(
        (_resolve, reject) => {
          rejectWait = reject;
        },
      );
      const session = {
        output: {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<Uint8Array>> => {
              try {
                await waitBarrier;
              } catch {
                // Session cancelled before any output.
              }
              return { done: true, value: undefined };
            },
          }),
        },
        write: async () => {},
        resize: async () => {},
        wait: async () => waitBarrier,
        cancel: async () => {
          cancelCalled = true;
          rejectWait(SboxError.cancellation("PTY session was cancelled (disposed)."));
        },
        async [Symbol.asyncDispose]() {
          await session.cancel();
        },
      };
      return session;
    };
    const client = await openClient(host);
    try {
      const provider = createSboxSandcastleProvider({ client });
      const handle = await provider.create({ env: {} });
      const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
      stdin.isTTY = true;
      const stdout = new PassThrough();
      const stderr = new PassThrough();

      const done = handle.interactiveExec!(["/bin/sh"], { stdin, stdout, stderr });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      await handle.close();
      await expect(done).rejects.toMatchObject({ code: "cancellation" });
      expect(cancelCalled).toBe(true);
      expect(await client.list()).toHaveLength(0);
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });
});
