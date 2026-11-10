// The DevTools calls footprint.mjs makes to each of Ember's pages (Performance.getMetrics), over the page's WebSocket.
// A page can close while the sample waits (listening starting again closes the microphone's), and Node's WebSocket
// neither throws nor answers a send on a closed socket, so every call answers undefined once its socket has closed,
// whether it closed before the call was made or while the call waited: otherwise the run (CI's el8 footprint step)
// waits until the job times out. The unit tests drive it with a fake socket (reliability-performance-w6-1,
// reliability-y6-1).

/**
 * A page's DevTools connection, once its socket opens: `call(method, params)` answers the command's result, or
 * undefined once the socket has closed (before the call, or while it waited). Rejects if the socket fails to open.
 * @param {WebSocket} ws a new socket to the page's webSocketDebuggerUrl
 * @returns {Promise<{ ws: WebSocket; call: (method: string, params?: object) => Promise<unknown> }>}
 */
export function devtoolsPage(ws) {
  return new Promise((resolve, reject) => {
    let id = 0;
    const pending = new Map();
    const call = (method, params = {}) => new Promise(r => {
      // Closed (a page gone during the sample's wait, with nothing pending for onclose to answer): a send would be lost.
      if (ws.readyState !== WebSocket.OPEN) { r(undefined); return; }
      pending.set(++id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m.result); pending.delete(m.id); };
    ws.onclose = () => { for (const r of pending.values()) r(undefined); pending.clear(); };
    ws.onerror = reject;
    ws.onopen = () => resolve({ ws, call });
  });
}
