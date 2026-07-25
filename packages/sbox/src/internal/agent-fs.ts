/**
 * Narrow agent FS helpers for symlink and mode ops not exposed by the Node
 * SandboxFsOps wrapper in Microsandbox 0.6.6.
 *
 * Private. Replace when the Node SDK exposes readLink/symlink/setStat.
 */

import { AgentClient, FLAG_SESSION_START } from "microsandbox";
import { SboxError } from "../errors.js";
import { mapNativeError } from "../microsandbox-runtime.js";
import {
  MSG_FS_RESPONSE,
  decodeEnvelope,
  decodePayload,
  encodeFsRequest,
  type FsResponsePayload,
} from "./agent-protocol.js";

export async function agentSymlink(
  nativeName: string,
  target: string,
  linkPath: string,
): Promise<void> {
  await fsRequest(nativeName, { Symlink: { target, link_path: linkPath } });
}

export async function agentReadLink(nativeName: string, path: string): Promise<string> {
  const response = await fsRequest(nativeName, { ReadLink: { path } });
  const data = response.data as { Path?: string } | undefined;
  if (data === undefined || typeof data.Path !== "string") {
    throw SboxError.protocol("Unexpected filesystem response for readlink.");
  }
  return data.Path;
}

export async function agentSetMode(
  nativeName: string,
  path: string,
  mode: number,
  followSymlink = false,
): Promise<void> {
  await fsRequest(nativeName, {
    SetStat: {
      path,
      follow_symlink: followSymlink,
      attrs: { mode },
    },
  });
}

export async function agentStat(
  nativeName: string,
  path: string,
  followSymlink: boolean,
): Promise<{ kind: string; mode: number; size: number }> {
  const response = await fsRequest(nativeName, {
    Stat: { path, follow_symlink: followSymlink },
  });
  const data = response.data as { Stat?: { kind: string; mode: number; size: number } } | undefined;
  if (data?.Stat === undefined) {
    throw SboxError.protocol("Unexpected filesystem response for stat.");
  }
  return data.Stat;
}

async function fsRequest(
  nativeName: string,
  op: Record<string, unknown>,
): Promise<FsResponsePayload> {
  let client: AgentClient;
  try {
    client = await AgentClient.connectSandbox(nativeName);
  } catch (error) {
    throw mapNativeError(error);
  }
  try {
    const frame = await client.request(FLAG_SESSION_START, encodeFsRequest(op));
    const envelope = decodeEnvelope(frame.body);
    if (envelope.t !== MSG_FS_RESPONSE) {
      throw SboxError.protocol("Expected core.fs.response from agent.");
    }
    const response = decodePayload<FsResponsePayload>(envelope);
    if (!response.ok) {
      throw SboxError.nativeState("Guest filesystem operation failed.", {
        details: { operation: Object.keys(op)[0] ?? "fs" },
      });
    }
    return response;
  } catch (error) {
    if (error instanceof SboxError) {
      throw error;
    }
    throw mapNativeError(error);
  } finally {
    try {
      await client.close();
    } catch {
      // Ignore close failures.
    }
  }
}
