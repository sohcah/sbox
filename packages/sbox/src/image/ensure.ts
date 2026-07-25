/**
 * Ensure a content-addressed Microsandbox image from a Dockerfile build.
 *
 * In-process coalescing shares the underlying build while preserving
 * per-subscriber progress and cancellation. No cross-process locks.
 */

import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSboxError, SboxError, throwIfAborted } from "../errors.js";
import { discoverBuildContext, materializeContextEntries } from "./context.js";
import { computeGeneratedImageIdentity, identityInputsFromEnsureRequest } from "./compute.js";
import {
  encodeDockerBuild,
  encodeDockerCommit,
  encodeDockerContainerRemove,
  encodeDockerCreate,
  encodeDockerImageRemove,
  encodeDockerSave,
} from "./docker-argv.js";
import type { ImageContentIdentity } from "./identity.js";
import {
  buildImageOwnershipLabels,
  buildOwnershipDockerChanges,
  hasNoReservedImageEvidence,
  inspectImageOwnershipEvidence,
} from "./naming.js";
import {
  nativeImageGet,
  nativeImageLoad,
  nativeImageRemove,
  type NativeImageEvidence,
} from "./native-images.js";
import { runExactCommand, type RunExactCommand } from "./subprocess.js";
import type {
  HostEnsureImageOptions,
  HostEnsureImageRequest,
  HostImageInspection,
  ImageBuildProgressEvent,
} from "./types.js";
import {
  cleanupImageWorkspace,
  createImageWorkspace,
  defaultImageWorkspaceRoot,
  type ImageWorkspace,
} from "./workspace.js";

export interface EnsureImagePorts {
  readonly get: (reference: string) => Promise<NativeImageEvidence | null>;
  readonly load: (
    archivePath: string,
    tag: string,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ) => Promise<void>;
  readonly remove: (reference: string, force?: boolean) => Promise<void>;
  readonly workspaceRoot?: string;
  readonly runCommand?: RunExactCommand;
  readonly createWorkspace?: (
    workspaceRoot: string,
    signal?: AbortSignal,
  ) => Promise<ImageWorkspace>;
  readonly cleanupWorkspace?: (workspaceRootPath: string) => Promise<void>;
  /** Test seam: skip Docker/msb and publish evidence after identity. */
  readonly fakePublish?: (
    identity: ImageContentIdentity,
    request: HostEnsureImageRequest,
  ) => Promise<void>;
}

const defaultPorts: EnsureImagePorts = {
  get: nativeImageGet,
  load: nativeImageLoad,
  remove: nativeImageRemove,
};

type InflightEntry = {
  readonly promise: Promise<HostImageInspection>;
  readonly listeners: Set<(event: ImageBuildProgressEvent) => void>;
  readonly sharedAbort: AbortController;
  waiterCount: number;
};

/** In-process coalescing of identical concurrent builds. */
const inflight = new Map<string, InflightEntry>();

export async function ensureImage(
  request: HostEnsureImageRequest,
  options: HostEnsureImageOptions = {},
  ports: EnsureImagePorts = defaultPorts,
): Promise<HostImageInspection> {
  throwIfAborted(options.signal);

  emitSafe(options.onProgress, { type: "phase", phase: "identity" });
  const identity = await computeGeneratedImageIdentity(
    identityInputsFromEnsureRequest(request, options.signal),
  );
  emitSafe(options.onProgress, {
    type: "phase",
    phase: "identity",
    reference: identity.nativeReference,
  });

  if (request.force === true) {
    // Force is not coalesced. A subscriber timeout/cancel stops this sole wait's work.
    const localAbort = new AbortController();
    const forwardAbort = (): void => {
      localAbort.abort();
    };
    if (options.signal !== undefined) {
      throwIfAborted(options.signal);
      options.signal.addEventListener("abort", forwardAbort, { once: true });
    }
    try {
      return await raceSubscriberWait(
        runEnsure(
          request,
          {
            signal: localAbort.signal,
            onProgress: (event) => {
              emitSafe(options.onProgress, event);
            },
          },
          ports,
          identity,
        ),
        options,
        forwardAbort,
      );
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  const coalesceKey = identity.digestHex;
  let entry = inflight.get(coalesceKey);
  if (entry === undefined) {
    const sharedAbort = new AbortController();
    const listeners = new Set<(event: ImageBuildProgressEvent) => void>();
    // Shared work has no subscriber timeout — only the shared abort signal.
    const promise = runEnsure(
      request,
      {
        signal: sharedAbort.signal,
        onProgress: (event) => {
          for (const listener of listeners) {
            emitSafe(listener, event);
          }
        },
      },
      ports,
      identity,
    ).finally(() => {
      if (inflight.get(coalesceKey)?.promise === promise) {
        inflight.delete(coalesceKey);
      }
    });
    entry = { promise, listeners, sharedAbort, waiterCount: 0 };
    inflight.set(coalesceKey, entry);
  }

  return await subscribeToInflight(entry, options);
}

async function subscribeToInflight(
  entry: InflightEntry,
  options: HostEnsureImageOptions,
): Promise<HostImageInspection> {
  const listener = options.onProgress;
  if (listener !== undefined) {
    entry.listeners.add(listener);
  }
  entry.waiterCount += 1;

  let abandoned = false;
  try {
    const result = await raceSubscriberWait(entry.promise, options, () => {
      abandoned = true;
    });
    return result;
  } finally {
    if (listener !== undefined) {
      entry.listeners.delete(listener);
    }
    entry.waiterCount -= 1;
    if (entry.waiterCount === 0 && abandoned) {
      entry.sharedAbort.abort();
    }
  }
}

async function raceSubscriberWait(
  work: Promise<HostImageInspection>,
  options: HostEnsureImageOptions,
  onAbandon?: () => void,
): Promise<HostImageInspection> {
  const callerSignal = options.signal;
  const timeoutMs = options.timeoutMs;
  let onCallerAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const races: Array<Promise<HostImageInspection>> = [work];

  if (callerSignal !== undefined) {
    throwIfAborted(callerSignal);
    races.push(
      new Promise<never>((_resolve, reject) => {
        onCallerAbort = () => {
          onAbandon?.();
          reject(SboxError.cancellation("Image operation was cancelled."));
        };
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }),
    );
  }

  if (timeoutMs !== undefined) {
    races.push(
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onAbandon?.();
          reject(
            SboxError.timeout("Image operation timed out.", {
              details: { timeoutMs },
            }),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    );
  }

  try {
    return await Promise.race(races);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onCallerAbort !== undefined) {
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

/** Test helper: clear in-process coalescing map. */
export function clearEnsureImageCoalescing(): void {
  inflight.clear();
}

async function runEnsure(
  request: HostEnsureImageRequest,
  options: HostEnsureImageOptions,
  ports: EnsureImagePorts,
  identity: ImageContentIdentity,
): Promise<HostImageInspection> {
  throwIfAborted(options.signal);
  const progress = options.onProgress;
  const runCommand = ports.runCommand ?? runExactCommand;
  const createWorkspace = ports.createWorkspace ?? createImageWorkspace;
  const cleanupWorkspace = ports.cleanupWorkspace ?? cleanupImageWorkspace;

  if (request.force !== true) {
    const existing = await ports.get(identity.nativeReference);
    if (existing !== null) {
      const ownership = inspectImageOwnershipEvidence(
        existing.labels,
        existing.env,
        identity.digestHex,
      );
      if (ownership.ok) {
        emitSafe(progress, { type: "phase", phase: "reuse", reference: identity.nativeReference });
        return {
          reference: identity.nativeReference,
          contentIdentity: identity.contentIdentity,
          algorithmVersion: identity.algorithmVersion,
          owned: true,
          labels: existing.labels,
          reused: true,
          built: false,
        };
      }
      throw SboxError.ownershipConflict(
        "Generated image reference exists but is not an owned sbox image with matching identity.",
        {
          details: {
            reference: identity.nativeReference,
            reason: ownership.reason,
          },
        },
      );
    }
  } else {
    const existing = await ports.get(identity.nativeReference);
    if (existing !== null) {
      const ownership = inspectImageOwnershipEvidence(
        existing.labels,
        existing.env,
        identity.digestHex,
      );
      if (!ownership.ok) {
        throw SboxError.ownershipConflict(
          "Refusing to force-rebuild a conflicting non-owned image at the generated reference.",
          {
            details: {
              reference: identity.nativeReference,
              reason: ownership.reason,
            },
          },
        );
      }
      await ports.remove(identity.nativeReference, true);
    }
  }

  if (ports.fakePublish !== undefined) {
    await ports.fakePublish(identity, request);
    const evidence = await ports.get(identity.nativeReference);
    if (
      evidence === null ||
      !inspectImageOwnershipEvidence(evidence.labels, evidence.env, identity.digestHex).ok
    ) {
      throw SboxError.internal("Fake image publish did not produce owned evidence.");
    }
    return {
      reference: identity.nativeReference,
      contentIdentity: identity.contentIdentity,
      algorithmVersion: identity.algorithmVersion,
      owned: true,
      labels: evidence.labels,
      reused: false,
      built: true,
    };
  }

  const workspaceRoot = ports.workspaceRoot ?? defaultImageWorkspaceRoot();
  emitSafe(progress, { type: "phase", phase: "workspace" });

  let workspace: ImageWorkspace | undefined;
  let primaryError: unknown;
  let result: HostImageInspection | undefined;

  try {
    workspace = await createWorkspace(workspaceRoot, options.signal);
    const activeWorkspace = workspace;
    emitSafe(progress, { type: "phase", phase: "context" });
    const discovered = await discoverBuildContext({
      contextRoot: request.contextRoot,
      dockerfile: request.dockerfile,
      includeGit: request.includeGit,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    await materializeContextEntries(activeWorkspace.contextDir, discovered.entries, options.signal);

    for (const [id, value] of Object.entries(request.secrets)) {
      throwIfAborted(options.signal);
      const src = join(activeWorkspace.secretsDir, id);
      await writeFile(src, value, { encoding: "utf8", mode: 0o600 });
      await chmod(src, 0o600);
    }

    const secretRefs = Object.keys(request.secrets).map((id) => ({
      id,
      src: join(activeWorkspace.secretsDir, id),
    }));

    const labels = buildImageOwnershipLabels(identity.digestHex);
    const dockerfileAbs = join(
      activeWorkspace.contextDir,
      ...discovered.dockerfileRelativePath.split("/"),
    );
    const build = encodeDockerBuild({
      context: activeWorkspace.contextDir,
      dockerfile: dockerfileAbs,
      tag: identity.nativeReference,
      platform: request.platform,
      ...(request.target !== undefined ? { target: request.target } : {}),
      args: request.args,
      secrets: secretRefs,
      labels,
    });

    emitSafe(progress, { type: "phase", phase: "docker", reference: identity.nativeReference });
    await runCommand({
      executable: build.executable,
      args: build.args,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      failureCode: "native_state",
      failureMessage: "Docker build failed.",
      failureDetails: { phase: "docker" },
    });

    emitSafe(progress, { type: "phase", phase: "stamp", reference: identity.nativeReference });
    await stampOwnershipEvidence(runCommand, identity, options.signal);

    emitSafe(progress, { type: "phase", phase: "export" });
    const save = encodeDockerSave(identity.nativeReference, activeWorkspace.exportPath);
    await runCommand({
      executable: save.executable,
      args: save.args,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      failureCode: "native_state",
      failureMessage: "Docker export (save) failed.",
      failureDetails: { phase: "export" },
    });

    emitSafe(progress, { type: "phase", phase: "load" });
    try {
      await ports.load(
        activeWorkspace.exportPath,
        identity.nativeReference,
        options.signal !== undefined ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      const after = await ports.get(identity.nativeReference);
      if (after !== null) {
        const ownership = inspectImageOwnershipEvidence(
          after.labels,
          after.env,
          identity.digestHex,
        );
        if (!ownership.ok) {
          throw SboxError.ownershipConflict(
            "Native image load conflicted with an unowned or mismatched image.",
            {
              cause: error,
              details: { reference: identity.nativeReference, reason: ownership.reason },
            },
          );
        }
      } else {
        throw error;
      }
    }

    emitSafe(progress, { type: "phase", phase: "verify" });
    const verified = await ports.get(identity.nativeReference);
    if (verified === null) {
      throw SboxError.nativeState("Image load completed but the exact reference is absent.");
    }
    const ownership = inspectImageOwnershipEvidence(
      verified.labels,
      verified.env,
      identity.digestHex,
    );
    if (!ownership.ok) {
      if (hasNoReservedImageEvidence(verified.labels, verified.env)) {
        throw SboxError.capability(
          "Native image runtime did not preserve ownership evidence required for generated images.",
          {
            details: {
              unavailableReason: "image_ownership_evidence_unavailable",
              reference: identity.nativeReference,
              reason: ownership.reason,
            },
          },
        );
      }
      throw SboxError.ownershipConflict("Loaded image failed ownership/identity verification.", {
        details: { reference: identity.nativeReference, reason: ownership.reason },
      });
    }

    const rm = encodeDockerImageRemove(identity.nativeReference);
    await runCommand({
      executable: rm.executable,
      args: rm.args,
      failureCode: "internal",
      failureMessage: "Failed to remove temporary Docker tag.",
    }).catch(() => undefined);

    result = {
      reference: identity.nativeReference,
      contentIdentity: identity.contentIdentity,
      algorithmVersion: identity.algorithmVersion,
      owned: true,
      labels: verified.labels,
      reused: false,
      built: true,
    };
  } catch (error) {
    primaryError = error;
  }

  emitSafe(progress, { type: "phase", phase: "cleanup" });
  if (workspace !== undefined) {
    try {
      await cleanupWorkspace(workspace.root);
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw withCleanupFailure(primaryError, cleanupError);
      }
      throw SboxError.internal("Image build succeeded but workspace cleanup failed.", {
        cause: cleanupError,
        details: { cleanupFailed: true },
      });
    }
  }

  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (result === undefined) {
    throw SboxError.internal("Image ensure completed without a result.");
  }
  return result;
}

async function stampOwnershipEvidence(
  runCommand: RunExactCommand,
  identity: ImageContentIdentity,
  signal: AbortSignal | undefined,
): Promise<void> {
  const create = encodeDockerCreate(identity.nativeReference);
  const created = await runCommand({
    executable: create.executable,
    args: create.args,
    ...(signal !== undefined ? { signal } : {}),
    retainOutput: true,
    maxRetainBytes: 4096,
    failureCode: "native_state",
    failureMessage: "Docker create failed while stamping ownership evidence.",
    failureDetails: { phase: "stamp" },
  });
  const containerId = created.stdout.trim().split(/\s+/).at(-1);
  if (containerId === undefined || containerId.length === 0) {
    throw SboxError.nativeState(
      "Docker create did not return a container id for ownership stamp.",
      {
        details: { phase: "stamp" },
      },
    );
  }

  let primaryError: unknown;
  try {
    const commit = encodeDockerCommit(
      containerId,
      identity.nativeReference,
      buildOwnershipDockerChanges(identity.digestHex),
    );
    await runCommand({
      executable: commit.executable,
      args: commit.args,
      ...(signal !== undefined ? { signal } : {}),
      failureCode: "native_state",
      failureMessage: "Docker commit failed while stamping ownership evidence.",
      failureDetails: { phase: "stamp" },
    });
  } catch (error) {
    primaryError = error;
  }

  try {
    const rm = encodeDockerContainerRemove(containerId);
    await runCommand({
      executable: rm.executable,
      args: rm.args,
      failureCode: "internal",
      failureMessage: "Failed to remove temporary stamp container.",
      failureDetails: { phase: "stamp", cleanupFailed: true },
    });
  } catch (cleanupError) {
    if (primaryError !== undefined) {
      throw withCleanupFailure(primaryError, cleanupError);
    }
    throw SboxError.internal("Ownership stamp succeeded but stamp container cleanup failed.", {
      cause: cleanupError,
      details: { phase: "stamp", cleanupFailed: true },
    });
  }

  if (primaryError !== undefined) {
    throw primaryError;
  }
}

function withCleanupFailure(primary: unknown, _cleanupError: unknown): SboxError {
  const base = isSboxError(primary)
    ? primary
    : SboxError.internal("Image operation failed.", { cause: primary });
  return new SboxError(base.code, base.message, {
    cause: base,
    details: {
      ...base.details,
      cleanupFailed: true,
    },
  });
}

function emitSafe(
  progress: ((event: ImageBuildProgressEvent) => void) | undefined,
  event: ImageBuildProgressEvent,
): void {
  if (progress === undefined) {
    return;
  }
  try {
    progress(event);
  } catch {
    // Progress is observational — never affect lifecycle or other subscribers.
  }
}
