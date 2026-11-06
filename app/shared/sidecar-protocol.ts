/**
 * The version of the accessibility sidecar's protocol, in one place for every side of it: the Python sidecar
 * (sidecar/atspi/ember_atspi.py `VERSION`, a test keeps the two equal), the TypeScript host (app/sidecar-host/protocol.ts)
 * and the client (app/main/perception/sidecar.ts), which refuses a helper whose `ping` reports anything else. Plain, so
 * the remote agent's bundle can load it. Change it with the wire format, in all three together.
 */
export const SIDECAR_PROTOCOL_VERSION = 3;
