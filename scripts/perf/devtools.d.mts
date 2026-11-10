// Types for devtools.mjs (footprint.mjs and the unit tests import it).

/** What devtoolsPage uses of a WebSocket (a fake one in the unit tests). */
export interface DevtoolsSocket {
  readonly readyState: number;
  send(data: string): void;
  onopen: ((ev: never) => unknown) | null;
  onmessage: ((ev: { data: string }) => unknown) | null;
  onclose: ((ev: never) => unknown) | null;
  onerror: ((ev: never) => unknown) | null;
}

/**
 * A page's DevTools connection, once its socket opens: `call` answers the command's result, or undefined once the
 * socket has closed (before the call, or while it waited). Rejects if the socket fails to open.
 */
export declare function devtoolsPage<S extends DevtoolsSocket>(ws: S): Promise<{ ws: S; call: (method: string, params?: Record<string, unknown>) => Promise<unknown> }>;
