/**
 * Remote Host transport: protocol, server, and RemoteHost client.
 */

export { SBOX_PROTOCOL_VERSION, type HealthResponse, type HandshakeResponse } from "./protocol.js";
export { createRemoteHost, type RemoteHostOptions } from "./remote-host.js";
export { createSboxServer, type SboxServer, type SboxServerOptions } from "./server.js";
export { DEFAULT_REMOTE_LIMITS, resolveRemoteLimits, type RemoteLimits } from "./limits.js";
