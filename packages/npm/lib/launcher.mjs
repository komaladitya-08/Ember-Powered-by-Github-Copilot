// The ember-copilot npm launcher: `ember` (or `ember-copilot`) downloads the Ember release matching this package's
// version from GitHub Releases on first run, checks it against the release's SHA256SUMS, unpacks it into a per-user
// cache folder and starts it detached, passing its arguments on. Node built-ins only: the package has no dependencies.
// Downloads use node:http and node:https through the proxy npm itself would use (proxyFor), because Node's fetch
// ignores proxies before Node 24, and behind one said only "fetch failed".
//   Windows: Ember-<v>-win-x64.zip         unpacked with tar.exe (bsdtar, Windows 10 1803+) or Expand-Archive
//   macOS:   Ember-<v>-mac-<arch>.zip      unpacked with ditto, quarantine removed, started with open(1)
//   Linux:   Ember-<v>-x86_64.AppImage     made executable
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import pathPosix from "node:path/posix";
import pathWin32 from "node:path/win32";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

/** The repository whose GitHub Releases hold Ember's packages. */
export const REPO = "komaladitya-08/Ember-Powered-by-Github-Copilot";

/** The name of the per-user cache folder (one subfolder per version). */
export const CACHE_NAME = "ember-npm";

/**
 * The release file for a platform and architecture, what kind it is, and where the program is once it is unpacked
 * (relative to the version's folder, POSIX separators). Throws for a platform Ember has no release for.
 * @param {string} platform process.platform
 * @param {string} arch process.arch
 * @param {string} version the app's version, without a leading "v"
 * @returns {{ asset: string; kind: "zip" | "appimage"; exe: string; app: string }}
 */
export function assetFor(platform, arch, version) {
  if (platform === "win32" && arch === "x64") {
    return { asset: `Ember-${version}-win-x64.zip`, kind: "zip", exe: "Ember/Ember.exe", app: "Ember" };
  }
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return { asset: `Ember-${version}-mac-${arch}.zip`, kind: "zip", exe: "Ember.app/Contents/MacOS/Ember", app: "Ember.app" };
  }
  if (platform === "linux" && arch === "x64") {
    const asset = `Ember-${version}-x86_64.AppImage`;
    return { asset, kind: "appimage", exe: asset, app: asset };
  }
  throw new Error(`Ember ${version} has no release for ${platform}-${arch} (there are builds for win32-x64, darwin-arm64, darwin-x64 and linux-x64)`);
}

/**
 * The hashes in a SHA256SUMS file (sha256sum's "hash  name" or "hash *name" lines), by file name. Blank lines and
 * comments are skipped; any other line that isn't a SHA-256 line throws.
 * @param {string} text
 * @returns {Map<string, string>} file name → lowercase hex hash
 */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS line ${i + 1} isn't "<sha256>  <file>": ${JSON.stringify(line.slice(0, 120))}`);
    sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

/**
 * The folder a version is unpacked into: %LOCALAPPDATA%\ember-npm\<v> on Windows, ~/Library/Caches/ember-npm/<v> on
 * macOS, $XDG_CACHE_HOME/ember-npm/<v> (default ~/.cache) elsewhere. EMBER_NPM_CACHE overrides the ember-npm folder.
 * @param {{ platform: string; env: Record<string, string | undefined>; home: string; version: string }} o
 */
export function cacheDir(o) {
  const p = o.platform === "win32" ? pathWin32 : pathPosix;
  if (o.env.EMBER_NPM_CACHE) return p.join(o.env.EMBER_NPM_CACHE, o.version);
  if (o.platform === "win32") return p.join(o.env.LOCALAPPDATA || p.join(o.home, "AppData", "Local"), CACHE_NAME, o.version);
  if (o.platform === "darwin") return p.join(o.home, "Library", "Caches", CACHE_NAME, o.version);
  const xdg = o.env.XDG_CACHE_HOME && p.isAbsolute(o.env.XDG_CACHE_HOME) ? o.env.XDG_CACHE_HOME : p.join(o.home, ".cache");
  return p.join(xdg, CACHE_NAME, o.version);
}

/**
 * Where a release file is downloaded from. EMBER_NPM_DOWNLOAD_BASE replaces "https://github.com/<repo>/releases/download"
 * (a mirror, or a local server in tests); the tag folder "v<version>" is added either way.
 * @param {string} version
 * @param {string} file
 * @param {Record<string, string | undefined>} [env]
 */
export function downloadUrl(version, file, env = {}) {
  const base = (env.EMBER_NPM_DOWNLOAD_BASE || `https://github.com/${REPO}/releases/download`).replace(/\/+$/, "");
  return `${base}/v${encodeURIComponent(version)}/${encodeURIComponent(file)}`;
}

/**
 * Where the launcher gets Ember from, in what it says: GitHub Releases, or the mirror EMBER_NPM_DOWNLOAD_BASE names.
 * @param {Record<string, string | undefined>} [env]
 */
export function releaseSource(env = {}) {
  return env.EMBER_NPM_DOWNLOAD_BASE ? `the mirror at ${env.EMBER_NPM_DOWNLOAD_BASE}` : "GitHub Releases";
}

/**
 * What the launcher says when its version's release isn't there (the release's SHA256SUMS answers 404): the package
 * can reach npm before its release is published, and a mirror can lag behind GitHub.
 * @param {string} version
 * @param {Record<string, string | undefined>} [env]
 */
export function notReleased(version, env = {}) {
  return `Ember ${version} isn't on ${releaseSource(env)} yet, so there is nothing to start. Install a published version from https://github.com/${REPO}/releases instead.`;
}

/**
 * What the launcher says when the release file can't be checked against the release's SHA256SUMS, so nothing is
 * installed: what came for SHA256SUMS is a web page (a Wi-Fi's or a proxy's sign-in, which it never repeats) or isn't
 * a list of hashes, it has no line for the file, or the file doesn't match its line; each with what to do next
 * (install-docs-c4-1).
 * @param {{ problem: "page" | "garbled" | "missing" | "mismatch"; version: string; asset: string; name: string; env?: Record<string, string | undefined>; host?: string; want?: string; got?: string }} o
 *   host: the host that sent SHA256SUMS (after any redirect); want, got: the hashes that differ
 */
export function notChecked(o) {
  const env = o.env ?? {};
  const mirror = !!env.EMBER_NPM_DOWNLOAD_BASE;
  const tag = `https://github.com/${REPO}/releases/tag/v${o.version}`;
  const sums = `What ${o.host} sent for the v${o.version} release's SHA256SUMS`;
  if (o.problem === "page") {
    return `${sums} is a web page, perhaps a Wi-Fi or proxy sign-in, not its list of hashes, so nothing was installed. Open https://github.com/${REPO}/releases in your browser and sign in if it asks${mirror ? ", or check EMBER_NPM_DOWNLOAD_BASE" : ""}, then run '${o.name}' again.`;
  }
  if (o.problem === "garbled") {
    return `${sums} isn't its list of hashes, so nothing was installed. Run '${o.name}' again${mirror ? ", check EMBER_NPM_DOWNLOAD_BASE" : ""}, or download ${o.asset} from ${tag} in your browser.`;
  }
  if (o.problem === "missing") {
    const next = mirror ? `Ask whoever runs the mirror to copy the v${o.version} release again, or download ${o.asset} from ${tag} in your browser.` : `Download ${o.asset} from ${tag} in your browser instead.`;
    return `The v${o.version} release's SHA256SUMS on ${releaseSource(env)} has no line for ${o.asset}, so nothing was installed. ${next}`;
  }
  return `${o.asset} doesn't match SHA256SUMS (expected ${o.want}, got ${o.got}), so nothing was installed: it was damaged or changed on the way. Run '${o.name}' again, or download it from ${tag} in your browser.`;
}

/** The version of this package, which is the version of Ember it starts. */
export function packageVersion() {
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  return String(pkg.version);
}

const MARKER = ".ember-npm-complete";

/** @param {string} msg */
const say = msg => { if (!process.env.EMBER_NPM_QUIET) process.stderr.write(`ember-copilot: ${msg}\n`); };

/** The value of npm's `key` setting in its environment (npm_config_<key>, in any case), or undefined. */
function npmEnv(/** @type {Record<string, string | undefined>} */ env, /** @type {string} */ key) {
  const want = `npm_config_${key.replace(/-/g, "_")}`;
  const name = Object.keys(env).find(k => k.toLowerCase() === want);
  return name ? env[name] : undefined;
}

/**
 * The proxy settings in npm's configuration files (the user's .npmrc, then npm's global npmrc), which npm installed
 * this package through but which aren't in a global command's environment. Only https-proxy, proxy and noproxy are
 * read (nothing else in the files, such as a token, is kept); a file that can't be read counts as empty.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ home?: string; platform?: string; execPath?: string }} [o] this computer's, unless a test says otherwise
 * @returns {{ "https-proxy"?: string; proxy?: string; noproxy?: string }}
 */
export function npmrcProxy(env = {}, o = {}) {
  const platform = o.platform ?? process.platform;
  const p = platform === "win32" ? pathWin32 : pathPosix;
  const exec = o.execPath ?? process.execPath;
  // npm's global prefix is Node's own folder on Windows and the folder above Node's bin elsewhere.
  const prefix = npmEnv(env, "prefix") || (platform === "win32" ? p.dirname(exec) : p.dirname(p.dirname(exec)));
  const files = [npmEnv(env, "userconfig") || p.join(o.home ?? os.homedir(), ".npmrc"), npmEnv(env, "globalconfig") || p.join(prefix, "etc", "npmrc")];
  /** @type {Record<string, string>} */
  const out = {};
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // No such file, or not ours to read: npm would have gone without it too.
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(https-proxy|proxy|noproxy)\s*=\s*(.*?)\s*$/i.exec(line);
      const key = m?.[1].toLowerCase();
      if (!m || !key || out[key] !== undefined) continue;
      out[key] = m[2].replace(/^(["'])(.*)\1$/, "$2").replace(/\$\{([^}]+)\}/g, (_all, n) => env[n] ?? "");
    }
  }
  return out;
}

/** Whether `host` is this computer, which no proxy can reach for it. */
function isLoopback(/** @type {string} */ host) {
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || (net.isIPv4(host) && host.startsWith("127."));
}

/** Whether IPv4 `host` is in `cidr` ("10.0.0.0/8"). */
function inCidr(/** @type {string} */ host, /** @type {string} */ cidr) {
  const [base, bits] = cidr.split("/");
  const n = Number(bits);
  const v4 = (/** @type {string} */ s) => net.isIPv4(s) ? s.split(".").reduce((a, b) => a * 256 + Number(b), 0) : null;
  const h = v4(host), b = v4(base);
  if (h === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) return false;
  const size = 2 ** (32 - n);
  return Math.floor(h / size) === Math.floor(b / size);
}

/**
 * Whether a NO_PROXY list names `host` (and `port`): "*", a domain and its subdomains ("example.com", ".example.com",
 * "*.example.com"), an address, an IPv4 range ("10.0.0.0/8"), each with an optional ":port".
 */
function bypasses(/** @type {string} */ host, /** @type {number} */ port, /** @type {string} */ list) {
  for (const raw of list.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry);
    if (withPort) {
      if (Number(withPort[2]) !== port) continue;
      entry = withPort[1];
    }
    entry = entry.replace(/^\[|\]$/g, "");
    if (entry.includes("/")) {
      if (inCidr(host, entry)) return true;
      continue;
    }
    entry = entry.replace(/^\*?\./, "");
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * The proxy a download from `url` goes through, chosen as npm chooses the one it installed this package through:
 * npm's https-proxy or proxy setting (from npm's environment, then its .npmrc files), else HTTPS_PROXY for an https
 * URL or HTTP_PROXY for an http one (in either case). None for a host that NO_PROXY (or npm's noproxy) names, or for
 * this computer itself.
 * @param {string} url
 * @param {Record<string, string | undefined>} [env]
 * @param {{ "https-proxy"?: string; proxy?: string; noproxy?: string }} [npmrc] what npm's files set (npmrcProxy)
 * @returns {{ url: URL; setting: string } | null} the proxy, and the setting that names it (to name it when it fails)
 */
export function proxyFor(url, env = {}, npmrc = {}) {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  /** @type {[string, string | undefined][]} */
  const settings = [
    ["npm's https-proxy setting", npmEnv(env, "https-proxy")], ["npm's proxy setting", npmEnv(env, "proxy")],
    ["npm's https-proxy setting", npmrc["https-proxy"]], ["npm's proxy setting", npmrc.proxy],
    ...(/** @type {[string, string | undefined][]} */ (secure ? [["HTTPS_PROXY", env.HTTPS_PROXY], ["https_proxy", env.https_proxy]] : [["HTTP_PROXY", env.HTTP_PROXY], ["http_proxy", env.http_proxy]])),
  ];
  // npm takes "false" for no proxy.
  const chosen = settings.find(([, v]) => v !== undefined && v.trim() !== "" && v.trim() !== "false");
  if (!chosen) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = Number(u.port) || (secure ? 443 : 80);
  const noProxy = [npmEnv(env, "noproxy"), npmrc.noproxy, env.NO_PROXY, env.no_proxy].find(v => v !== undefined && v.trim() !== "") ?? "";
  if (isLoopback(host) || bypasses(host, port, noProxy)) return null;
  const value = String(chosen[1]).trim();
  let proxy;
  try {
    proxy = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    throw new Error(`${chosen[0]} isn't a proxy address the launcher can use; set it like http://proxy.example.com:8080`);
  }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(`${chosen[0]} names a ${proxy.protocol.replace(/:$/, "")} proxy; the launcher can use an http:// or https:// one`);
  }
  return { url: proxy, setting: chosen[0] };
}

/** How long a download waits for the network (a connection, the proxy's answer, the next bytes) before it gives up. */
const NET_TIMEOUT_MS = 30_000;

/**
 * One GET with Node's http and https: straight to the server, or through `proxy`, which an https URL reaches by a
 * CONNECT tunnel and an http URL by asking it for the whole URL. Resolves with the response once its headers arrive;
 * `signal` ends it, and NET_TIMEOUT_MS without a byte fails it with ETIMEDOUT.
 * @param {string} url
 * @param {URL | null} proxy
 * @param {AbortSignal} [signal]
 * @returns {Promise<http.IncomingMessage>}
 */
function request(url, proxy, signal) {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  const port = Number(u.port) || (secure ? 443 : 80);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const servername = net.isIP(host) ? undefined : host;
  const headers = { "user-agent": "ember-copilot-npm-launcher", accept: "*/*", host: u.host };
  const auth = proxy?.username
    ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` }
    : {};
  const via = proxy?.protocol === "https:" ? https : http;
  const viaHost = proxy?.hostname.replace(/^\[|\]$/g, "");
  const viaPort = proxy ? Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80) : 0;
  return new Promise((resolve, reject) => {
    /** @type {{ destroy(err?: Error): unknown }[]} */
    const parts = [];
    let settled = false;
    let finished = false;
    const fail = (/** @type {Error} */ err) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      for (const part of parts) part.destroy(err);
      if (!settled) { settled = true; reject(err); }
    };
    const onAbort = () => fail(signal?.reason);
    if (signal?.aborted) { reject(signal.reason); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    // Whoever reads a response (pipeline, text()) gets its error too; this keeps one nobody reads, such as a
    // redirect's or a tunnel's socket, from stopping the launcher with an unhandled error when it is ended.
    const quiet = (/** @type {NodeJS.EventEmitter} */ part) => part.on("error", () => {});
    const timedOut = () => Object.assign(new Error("no answer in time"), { code: "ETIMEDOUT" });
    const send = (/** @type {typeof http | typeof https} */ mod, /** @type {https.RequestOptions} */ options) => {
      const req = mod.request({ ...options, method: "GET", headers: { ...headers, ...options.headers }, timeout: NET_TIMEOUT_MS });
      parts.push(req);
      req.on("timeout", () => fail(timedOut()));
      req.on("error", fail);
      req.once("response", res => {
        parts.push(res);
        quiet(res);
        res.once("close", () => { finished = true; signal?.removeEventListener("abort", onAbort); });
        settled = true;
        resolve(res);
      });
      req.end();
    };
    if (!proxy) {
      send(secure ? https : http, { host, port, path: `${u.pathname}${u.search}`, servername });
    } else if (!secure) {
      send(via, { host: viaHost, port: viaPort, path: u.href, headers: auth });
    } else {
      // An https download through the proxy: a CONNECT tunnel, then TLS to the server inside it, checked as usual.
      const connect = via.request({ host: viaHost, port: viaPort, method: "CONNECT", path: `${u.hostname}:${port}`, headers: { host: `${u.hostname}:${port}`, ...auth }, timeout: NET_TIMEOUT_MS });
      parts.push(connect);
      connect.on("timeout", () => fail(timedOut()));
      connect.on("error", fail);
      connect.once("connect", (res, socket) => {
        parts.push(socket);
        quiet(socket);
        if (res.statusCode !== 200) {
          fail(Object.assign(new Error(`the proxy answered ${res.statusCode}`), { code: "EMBER_PROXY_REFUSED", status: res.statusCode, host: u.host }));
          return;
        }
        send(https, { host, port, path: `${u.pathname}${u.search}`, createConnection: () => tls.connect({ socket, host, servername }) });
      });
      connect.end();
    }
  });
}

/**
 * @typedef {{ env: Record<string, string | undefined>; signal?: AbortSignal; version: string; asset: string; name: string }} Net
 *   what a download needs: the environment (for the proxy and the mirror), what stops it, and what to name when it fails
 */

/** In a few words, why the network failed, by Node's error code. */
const WHY = /** @type {Record<string, string>} */ ({
  ECONNREFUSED: "the connection was refused",
  ECONNRESET: "the connection was cut off",
  ENOTFOUND: "its name didn't resolve",
  EAI_AGAIN: "its name didn't resolve",
  ETIMEDOUT: "nothing answered for 30 seconds",
  ENETUNREACH: "there is no network",
  EHOSTUNREACH: "it is unreachable",
});

/**
 * What the launcher says when it can't reach where Ember comes from, a proxy or server answers with an error (code
 * EMBER_HTTP, with the status and the host that answered), or the download stops part way, in place of Node's bare
 * "fetch failed" or an HTTP status: where, why in a few words, and what to do next (the proxy setting, the browser
 * download, a mirror). A proxy is named by its host only: its address can hold a password.
 * @param {any} err
 * @param {Net & { proxy: { url: URL; setting: string } | null; midway?: boolean }} o
 */
function cantReach(err, o) {
  const code = String(err?.code ?? err?.cause?.code ?? "");
  const where = releaseSource(o.env);
  const via = o.proxy ? ` through the proxy at ${o.proxy.url.host}` : "";
  const cert = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS/.test(code);
  const answered = code === "EMBER_HTTP";
  const status = answered ? `${err.status}${err.statusText ? ` ${err.statusText}` : ""}` : "";
  // A proxy's Bad Gateway and Gateway Timeout are its own when it forwards a plain http request, or answers a CONNECT:
  // it couldn't get to that host. Inside an https tunnel it only passes bytes, so the answer is the host's
  // (install-docs-v4-3), unless the proxy inspects HTTPS: then its own comes inside the tunnel too, and the launcher
  // can't tell the two apart, so a tunnelled 502 or 504 names both (install-docs-r4-1).
  const gatewayCode = err?.status === 502 || err?.status === 504;
  const gateway = answered && o.proxy && !err.tunnelled && gatewayCode;
  const inspected = answered && o.proxy && err.tunnelled && gatewayCode;
  const why = code === "EMBER_PROXY_REFUSED"
    ? err.status === 407 ? "the proxy asked for a user name and password (407)"
    : gatewayCode ? `the proxy couldn't get an answer from ${err.host} (${err.status})`
    : `the proxy refused to connect to it (${err.status})`
    : gateway ? `the proxy couldn't get an answer from ${err.host} (${status})`
    : inspected ? `${err.host}, or the proxy if it inspects HTTPS, answered ${status}`
    : answered ? `${err.host} answered ${status}`
    : cert ? `the certificate it showed isn't one this computer trusts (${code})`
    : WHY[code] ? `${WHY[code]} (${code})`
    : code || String(err?.message ?? err);
  const first = o.midway ? `The download of ${o.asset} from ${where}${via} stopped: ${why}.`
    : answered ? `The download of Ember ${o.version} from ${where}${via} failed: ${why}.`
    : `Ember couldn't reach ${where}${via}: ${why}.`;
  const secure = !o.env.EMBER_NPM_DOWNLOAD_BASE || /^https:/i.test(o.env.EMBER_NPM_DOWNLOAD_BASE);
  // The host that answered or was refused, which an organisation's allow-list may be missing (GitHub's storage host,
  // after its redirect): not for an answer inside an https tunnel, the host's own, unless it is a block (one from a
  // proxy that inspects HTTPS).
  const ask = o.proxy && (code === "EMBER_PROXY_REFUSED" || (answered && (!err.tunnelled || err.status === 403 || err.status === 451)));
  const next = code === "EMBER_PROXY_REFUSED" && err.status === 407 && o.proxy
    ? `Put your user name and password in ${o.proxy.setting} (http://name:password@${o.proxy.url.host}).`
    : cert ? "Behind a proxy that inspects HTTPS, set NODE_EXTRA_CA_CERTS to your organisation's certificate file."
    : ask ? `Check ${o.proxy.setting}, which names that proxy, or ask whoever runs it to let this computer reach ${err.host}.`
    : o.proxy && !answered ? `Check ${o.proxy.setting}, which names that proxy.`
    : o.midway || answered ? ""
    : `If this computer reaches the internet through a proxy, set ${secure ? "HTTPS_PROXY" : "HTTP_PROXY"} (or npm's ${secure ? "https-proxy" : "proxy"} setting) to it.`;
  const mirror = o.env.EMBER_NPM_DOWNLOAD_BASE ? "" : ", or set EMBER_NPM_DOWNLOAD_BASE to your organisation's mirror";
  // A server's own failure (5xx) is its to mend: run again later.
  const later = answered && !gateway && err.status >= 500 ? " later" : "";
  const again = `un '${o.name}' again${later}, or download ${o.asset} from https://github.com/${REPO}/releases/tag/v${o.version} in your browser${mirror}.`;
  // Running again later can't help while a proxy that inspects HTTPS can't reach the host.
  const keeps = inspected ? ` If it keeps happening, ask whoever runs the proxy whether it can reach ${err.host}.` : "";
  // "Then" only after a step to take first.
  return next ? `${first} ${next} Then r${again}${keeps}` : `${first} R${again}${keeps}`;
}

/**
 * GET `url`, following redirects, through the proxy proxyFor picks for each address; throws with cantReach's sentence
 * (and the status) on any answer but 2xx, and with cantReach's sentence when the network fails.
 * @param {string} url
 * @param {Net} o
 * @returns {Promise<{ status: number; length: number; host: string; body: http.IncomingMessage; text(): Promise<string> }>}
 *   host: the host that answered (after any redirect)
 */
async function get(url, o) {
  const npmrc = npmrcProxy(o.env);
  let at = url;
  for (let hop = 0; hop <= 10; hop++) {
    const proxy = proxyFor(at, o.env, npmrc);
    let res;
    try {
      res = await request(at, proxy?.url ?? null, o.signal);
    } catch (err) {
      if (o.signal?.aborted) throw o.signal.reason;
      throw new Error(cantReach(err, { ...o, proxy }), { cause: err });
    }
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.resume();
      at = new URL(res.headers.location, at).href;
      continue;
    }
    if (status === 407) {
      res.resume();
      throw new Error(cantReach({ code: "EMBER_PROXY_REFUSED", status }, { ...o, proxy }));
    }
    if (status < 200 || status >= 300) {
      res.resume();
      // Named by the host that answered (after a redirect, not the one asked first), its status text kept printable.
      const statusText = String(res.statusMessage ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 60);
      // Inside an https tunnel (through a proxy), the answer is the host's own, not the proxy's (install-docs-v4-3).
      const tunnelled = proxy !== null && new URL(at).protocol === "https:";
      throw Object.assign(new Error(cantReach({ code: "EMBER_HTTP", status, statusText, host: new URL(at).host, tunnelled }, { ...o, proxy })), { status });
    }
    const body = res;
    return {
      status, body, length: Number(res.headers["content-length"]) || 0, host: new URL(at).host,
      async text() {
        let s = "";
        body.setEncoding("utf8");
        for await (const chunk of body) s += chunk;
        return s;
      },
    };
  }
  throw new Error(`downloading ${url} failed: it redirected more than 10 times`);
}

/**
 * Downloads `url` to `file`, returning the SHA-256 of what was written (lowercase hex).
 * @param {string} url
 * @param {string} file
 * @param {Net} o
 */
async function download(url, file, o) {
  const res = await get(url, o);
  const total = res.length;
  const hash = createHash("sha256");
  let seen = 0;
  let shown = -1;
  const tty = process.stderr.isTTY && !process.env.EMBER_NPM_QUIET;
  const tap = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      seen += chunk.length;
      const pct = total ? Math.floor((seen / total) * 100) : -1;
      if (tty && pct !== shown && pct % 5 === 0) { shown = pct; process.stderr.write(`\rember-copilot: ${pct}% of ${(total / 1048576).toFixed(0)} MB`); }
      done(null, chunk);
    },
  });
  try {
    await pipeline(res.body, tap, fs.createWriteStream(file));
  } catch (err) {
    if (tty && shown >= 0) process.stderr.write("\n");
    if (o.signal?.aborted) throw o.signal.reason;
    const e = /** @type {any} */ (err);
    // This computer's disk, not the network: no room left (a write stream's failed write names no file, so its code
    // tells it; ensureInstalled says it with the size), or a file that couldn't be opened, which names its file.
    if (ROOM.has(e?.code)) throw Object.assign(e, { bytes: total });
    if (e?.path) throw err;
    throw new Error(cantReach(err, { ...o, proxy: proxyFor(url, o.env, npmrcProxy(o.env)), midway: true }), { cause: err });
  }
  if (tty) process.stderr.write("\n");
  return hash.digest("hex");
}

/**
 * Runs a command to completion, rejecting with its output when it fails. Not spawnSync: unpacking takes seconds, and
 * the launcher must hear a stop meanwhile (`signal` ends the command).
 * @param {string} file
 * @param {string[]} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function run(file, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal });
    let said = "";
    const keep = (/** @type {Buffer} */ d) => { said = `${said}${d}`.slice(-4000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", err => { if (!signal?.aborted) reject(new Error(`${file} could not start: ${err.message}`)); });
    // What it said is kept apart too (`output`), to be read without the paths in its command line.
    child.once("close", (code, sig) => code === 0 ? resolve() : reject(Object.assign(new Error(`${file} ${args.join(" ")} failed (exit ${code ?? sig}): ${said.trim().slice(-2000)}`), { output: said })));
  });
}

/**
 * Unpacks a zip into `dir`: Windows's tar.exe, or PowerShell's Expand-Archive when tar.exe is missing; ditto on macOS
 * (it keeps the app's symlinks and signature). `signal` ends it.
 * @param {string} zip
 * @param {string} dir
 * @param {AbortSignal} [signal]
 */
function unzip(zip, dir, signal) {
  if (process.platform === "win32") {
    const tar = pathWin32.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(tar)) return run(tar, ["-x", "-f", zip, "-C", dir], signal);
    const q = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`;
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dir)} -Force`], signal);
  }
  if (process.platform === "darwin") return run("ditto", ["-x", "-k", zip, dir], signal);
  return run("unzip", ["-q", zip, "-d", dir], signal);
}

/**
 * Makes sure Ember `version` is unpacked in its cache folder, downloading and checking it first if it isn't, and
 * returns where it is. Ctrl+C, a closed terminal or a kill while it downloads ends the download and removes what it
 * made, its lock included, so the next run starts over.
 * @param {{ version: string; platform?: string; arch?: string; env?: Record<string, string | undefined>; force?: boolean; name?: string }} o
 *   name: what the person runs the launcher as (invokedAs), to name it in what goes wrong
 * @returns {Promise<{ dir: string; exe: string; app: string; fresh: boolean }>}
 */
export async function ensureInstalled(o) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const name = o.name ?? "ember";
  const target = assetFor(platform, o.arch ?? process.arch, o.version);
  const dir = cacheDir({ platform, env, home: os.homedir(), version: o.version });
  const p = platform === "win32" ? pathWin32 : pathPosix;
  const at = (/** @type {string} */ rel) => p.join(dir, ...rel.split("/"));
  if (!o.force && fs.existsSync(p.join(dir, MARKER)) && fs.existsSync(at(target.exe))) {
    return { dir, exe: at(target.exe), app: at(target.app), fresh: false };
  }

  const parent = p.dirname(dir);
  // The copy a reinstall started from, which is there until a new one is published.
  const haveCopy = () => fs.existsSync(p.join(dir, MARKER)) && fs.existsSync(at(target.exe));
  // A full disk or quota, wherever it strikes (a disk already full strikes here or at the lock, before the download's
  // size is known), said as this computer's, not as Node's bare "ENOSPC" (install-docs-v4-1); and, where the cache
  // folder, the lock and the work folder are made (`making`), a folder this user can't write in, not Node's "EACCES:
  // permission denied, mkdir …". Only there: a rename that fails with EPERM later is a file in use on Windows. Either
  // way a reinstall's copy, still there, is said to be kept (install-docs-c4-1).
  const roomy = (/** @type {any} */ err, making = false) => onDisk(err, { folder: parent, version: o.version, name, kept: haveCopy(), making });
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (err) {
    throw roomy(err, true);
  }
  // Caught from before the lock is taken until it is given back, so no stop leaves it behind: the download is ended,
  // and the finally below removes the work folder and the lock. A second Ctrl+C stops the launcher at once.
  const stop = new AbortController();
  const onSignal = (/** @type {string} */ sig) => {
    // A reinstall stopped before it publishes leaves the copy that was there, which a plain run starts.
    const kept = haveCopy();
    stop.abort(Object.assign(
      new Error(kept
        ? `Stopped before Ember ${o.version} was downloaded again, and the copy you had is kept. Run '${name}' to start it, or '${name} --npm-reinstall' to download it again.`
        : `Stopped before Ember ${o.version} was installed, and nothing was kept. Run '${name}' again to download it.`),
      { code: "EMBER_NPM_STOPPED", exitCode: 128 + (/** @type {Record<string, number>} */ ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }))[sig] },
    ));
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of signals) process.once(sig, onSignal);
  const unhook = () => { for (const sig of signals) process.removeListener(sig, onSignal); };
  // Serialise installers before downloading (takeLock never takes a lock from an installer that may still be at work).
  const lock = p.join(parent, `.${o.version}-install-lock`);
  try {
    takeLock({ lock, parent, version: o.version, name, p });
  } catch (err) {
    unhook();
    throw roomy(err, true);
  }
  let work;
  let preserveWork = false;
  let installError;
  try {
    // A first install may have completed between our initial cache check and acquiring the lock.
    if (!o.force && fs.existsSync(p.join(dir, MARKER)) && fs.existsSync(at(target.exe))) {
      return { dir, exe: at(target.exe), app: at(target.app), fresh: false };
    }
    try {
      work = fs.mkdtempSync(p.join(parent, `.${o.version}-`));
    } catch (err) {
      throw roomy(err, true);
    }
    say(`getting Ember ${o.version} for ${platform}-${o.arch ?? process.arch} (${target.asset}) from ${releaseSource(env)}`);
    const how = { env, signal: stop.signal, version: o.version, asset: target.asset, name };
    const sums = await get(downloadUrl(o.version, "SHA256SUMS", env), how).catch(err => {
      throw err?.status === 404 ? new Error(notReleased(o.version, env), { cause: err }) : err;
    });
    const sumsText = await sums.text();
    const unchecked = { version: o.version, asset: target.asset, name, env, host: sums.host };
    let listed;
    try {
      listed = parseSha256Sums(sumsText);
    } catch (err) {
      // A web page in its place (a Wi-Fi's or a proxy's sign-in, a mirror's index), never repeated (install-docs-c4-1).
      throw new Error(notChecked({ ...unchecked, problem: /^\s*</.test(sumsText) ? "page" : "garbled" }), { cause: err });
    }
    const want = listed.get(target.asset);
    if (!want) throw new Error(notChecked({ ...unchecked, problem: "missing" }));
    const file = p.join(work, target.asset);
    const got = await download(downloadUrl(o.version, target.asset, env), file, how);
    if (got !== want) throw new Error(notChecked({ ...unchecked, problem: "mismatch", want, got }));
    say(`checked ${target.asset} against SHA256SUMS (sha256 ${got})`);

    const stage = p.join(work, "app");
    fs.mkdirSync(stage);
    if (target.kind === "zip") {
      const failed = await unzip(file, stage, stop.signal).then(() => null, err => err);
      // Ctrl+C reaches the unpacker too, which can end before the launcher hears of it: a moment for the stop to
      // arrive, so it is said as a stop, not as the unpacker's failure (install-docs-r3-1).
      if (failed && !stop.signal.aborted) await new Promise(resolve => setTimeout(resolve, 100));
      if (stop.signal.aborted) throw stop.signal.reason;
      // The zips unpack to about 2.5 times their size, so the disk often fills here: the unpacker's words for that are
      // said as noRoom's (install-docs-v4-1).
      const full = roomSaid(failed?.output);
      if (full) throw Object.assign(failed, { code: full });
      if (failed) throw failed;
      fs.rmSync(file, { force: true });
    } else {
      fs.renameSync(file, p.join(stage, target.asset));
    }
    const staged = p.join(stage, ...target.exe.split("/"));
    if (!fs.existsSync(staged)) throw new Error(`${target.asset} has no ${target.exe}`);
    if (target.kind === "appimage") fs.chmodSync(staged, 0o755);
    if (platform === "darwin") {
      // The download came through Node, which sets no quarantine flag, but a copied or re-downloaded cache can carry
      // one; Ember is ad-hoc signed, so Gatekeeper would refuse it with the flag on. Through run(), not spawnSync, so
      // a stop meanwhile is heard (install-docs-v4-2); a failure is ignored, as it always was.
      await run("xattr", ["-dr", "com.apple.quarantine", p.join(stage, target.app)], stop.signal).catch(() => {});
    }
    fs.writeFileSync(p.join(stage, MARKER), `${target.asset} ${got}\n`);
    // A stop is heard only when the event loop turns, and nothing from here on lets it until the signal handlers are
    // gone: one turn first, so a stop that landed during the steps above publishes and starts nothing (install-docs-v4-2).
    await new Promise(resolve => setImmediate(resolve));
    if (stop.signal.aborted) throw stop.signal.reason;

    // Keep the previous installation until publication succeeds. In particular, Windows open handles can make
    // either rename fail. The version lock prevents another installer from publishing into the rollback gap.
    const previous = p.join(work, "previous");
    const hadPrevious = fs.existsSync(dir);
    if (hadPrevious) fs.renameSync(dir, previous);
    try {
      fs.renameSync(stage, dir);
    } catch (err) {
      if (hadPrevious) {
        try {
          // Never remove an unexpected destination (for example one created by an older, unlocked launcher).
          if (fs.existsSync(dir)) throw new Error("the cache destination is occupied", { cause: err });
          fs.renameSync(previous, dir);
        } catch (rollbackError) {
          preserveWork = true;
          throw new AggregateError([err, rollbackError], `installation failed and the previous installation could not be restored; it is saved at ${previous}, and the checked replacement at ${stage}`, { cause: rollbackError });
        }
      }
      throw err;
    }
    say(`installed Ember ${o.version} in ${dir}`);
    return { dir, exe: at(target.exe), app: at(target.app), fresh: true };
  } catch (err) {
    // A full disk or quota, wherever it struck (the download, the work folder, the unpacking, the marker).
    installError = roomy(err);
    throw installError;
  } finally {
    // Cleanup must not hide the original failure, especially the saved-copy paths after a failed rollback.
    const cleanupErrors = [];
    try {
      if (work && !preserveWork) fs.rmSync(work, { recursive: true, force: true });
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      // The lock holds its owner file (takeLock), and may hold a taken-<pid> folder.
      fs.rmSync(lock, { recursive: true, force: true });
    } catch (err) {
      cleanupErrors.push(err);
    }
    unhook();
    if (cleanupErrors.length) {
      const outcome = installError ? installError.message : `installation completed in ${dir}`;
      // eslint-disable-next-line no-unsafe-finally -- Intentionally report cleanup failure while retaining the primary error and recovery paths.
      throw new AggregateError(installError ? [installError, ...cleanupErrors] : cleanupErrors,
        `${outcome}; cleanup failed (work: ${work ?? "not created"}, lock: ${lock}); remove leftovers only when no installer is running`,
        { cause: installError ?? cleanupErrors[0] });
    }
  }
}

/** Node's codes for a disk with no room left: full, or the person's quota used up. */
const ROOM = new Set(["ENOSPC", "EDQUOT"]);

/**
 * The ROOM code an unpacker's words name, or undefined: unzip's "write error (disk full?)", ditto's and tar.exe's "No
 * space left on device" (macOS's "Disc quota exceeded" for a quota), Expand-Archive's "There is not enough space on
 * the disk".
 * @param {unknown} said what the unpacker printed
 */
function roomSaid(said) {
  const text = String(said ?? "");
  if (/\b(?:disc|disk) quota\b|\bquota (?:exceeded|violation)|\bEDQUOT\b/i.test(text)) return "EDQUOT";
  if (/no space left on device|\bdisk (?:is )?full\b|not enough space on the disk|\bENOSPC\b/i.test(text)) return "ENOSPC";
  return undefined;
}

/**
 * What the launcher says when the cache's disk has no room for Ember, in place of Node's "ENOSPC": where, how big the
 * download is (when known), and what to do, which is this computer's to fix: running again or another download
 * wouldn't help. After a reinstall, that the copy it started from is kept, and how to start it (install-docs-c4-1).
 * @param {any} err a ROOM error, with `bytes` when the download's size is known
 * @param {{ folder: string; version: string; name: string; kept?: boolean }} o kept: a reinstall's copy is still there
 */
function noRoom(err, o) {
  const why = err.code === "EDQUOT" ? "your disk quota is used up" : "the disk is full";
  const size = err.bytes ? ` (${Math.max(1, Math.round(err.bytes / 1048576))} MB)` : "";
  if (o.kept) return `There isn't room in ${o.folder} for Ember ${o.version}${size}: ${why} (${err.code}), and the copy you had is kept. Run '${o.name}' to start it, or free some space, then run '${o.name} --npm-reinstall' again.`;
  return `There isn't room in ${o.folder} for Ember ${o.version}${size}: ${why} (${err.code}). Free some space, or set EMBER_NPM_CACHE to a folder with room, then run '${o.name}' again.`;
}

/** Node's codes for a folder this user can't write in: another user's, or on a read-only disk. */
const LOCKED = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * What the launcher says when it can't write in the cache folder, in place of Node's "EACCES: permission denied,
 * mkdir …": where, why, and what to do (a run with sudo can leave the folder another user's). After a reinstall, that
 * the copy it started from is kept, and how to start it (install-docs-c4-1).
 * @param {any} err a LOCKED error
 * @param {{ folder: string; version: string; name: string; kept?: boolean }} o
 */
function cantWrite(err, o) {
  const readOnly = err.code === "EROFS";
  const why = readOnly ? "its disk is read-only" : "it, or a folder above it, belongs to another user or is read-only";
  const own = `EMBER_NPM_CACHE to a folder of your own${readOnly ? "" : ", or make this one yours again"}`;
  if (o.kept) return `Ember can't write to ${o.folder}: ${why} (${err.code}), and the copy you had is kept. Run '${o.name}' to start it, or set ${own}, then run '${o.name} --npm-reinstall' again.`;
  return `Ember can't write to ${o.folder}: ${why} (${err.code}). Set ${own}, then run '${o.name}' again.`;
}

/**
 * A full disk or quota (noRoom), or, where the cache folder or a file in it is made (`making`), a folder this user
 * can't write in (cantWrite), as one sentence that names the cache folder; any other error as it is.
 * @param {any} err
 * @param {{ folder: string; version: string; name: string; kept?: boolean; making?: boolean }} o
 */
function onDisk(err, o) {
  if (ROOM.has(err?.code)) return new Error(noRoom(err, o), { cause: err });
  if (o.making && LOCKED.has(err?.code)) return new Error(cantWrite(err, o), { cause: err });
  return err;
}

/**
 * Starting a program's own refusal (EPERM, which Node throws, or EACCES, which it reports and startWatched wraps), not
 * a file's: the error, or the one it wraps; else undefined.
 * @param {any} err
 */
function refusedStart(err) {
  return [err, err?.cause].find(e => /^spawn\b/.test(String(e?.syscall ?? "")) && (e.code === "EPERM" || e.code === "EACCES"));
}

/**
 * What the launcher says when this computer won't run Ember's own program, in place of Node's "spawn EPERM": a
 * security policy (fapolicyd, which RHEL 8's STIG requires, refuses an untrusted program with EPERM), antivirus (whose
 * refusal on Windows reads as EPERM too) or, on Linux, a disk that runs no programs (noexec: EACCES), and what to do.
 * Not cantWrite's sentence: the folder is likely this user's own (install-docs-v5-1).
 * @param {any} err a refusedStart error
 * @param {{ exe: string; name: string; platform: string }} o
 */
function cantRun(err, o) {
  const what = o.platform === "linux" ? "a security policy such as fapolicyd, antivirus, or a disk that doesn't let programs run" : "a security policy or antivirus";
  return `This computer didn't let Ember start (${err.code}): ${what} may be blocking ${o.exe}. Ask whoever manages this computer to allow it, or set EMBER_NPM_CACHE to a folder where programs may run, then run '${o.name}' again.`;
}

/**
 * Takes the version's install lock: a folder beside the version's, with an `owner` file naming this process and
 * computer. A lock left by an installer that has stopped (killed, crashed) is taken over, and the half-made work
 * folders it left are removed; one whose owner may still be at work (running, on another computer, or not named yet)
 * is never taken, and is reported in one sentence that says what to do.
 * @param {{ lock: string; parent: string; version: string; name: string; p: typeof pathPosix }} o
 */
function takeLock(o) {
  const owner = o.p.join(o.lock, "owner");
  try {
    fs.mkdirSync(o.lock);
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== "EEXIST") throw err;
    const stopped = stoppedOwner(owner);
    let took = false;
    if (stopped !== null) {
      // Only one launcher can make taken-<pid> for a stopped owner, and the owner file must still name it after.
      const claim = o.p.join(o.lock, `taken-${stopped}`);
      try {
        fs.mkdirSync(claim);
        took = stoppedOwner(owner) === stopped;
        if (!took) fs.rmSync(claim, { recursive: true, force: true });
      } catch (claimErr) {
        if (/** @type {any} */ (claimErr)?.code !== "EEXIST") throw claimErr;
      }
    }
    if (!took) {
      throw new Error(`Another '${o.name}' is already downloading Ember ${o.version}. Wait for it to finish, then run '${o.name}' again; if none is running, delete ${o.lock} and run '${o.name}' again.`, { cause: err });
    }
    // What the stopped installer was making: its work folders, but never one holding a saved previous copy.
    const work = new RegExp(`^\\.${o.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[A-Za-z0-9]{6}$`);
    for (const entry of fs.readdirSync(o.parent)) {
      const at = o.p.join(o.parent, entry);
      if (work.test(entry) && !fs.existsSync(o.p.join(at, "previous"))) fs.rmSync(at, { recursive: true, force: true });
    }
  }
  try {
    fs.writeFileSync(owner, `${process.pid} ${os.hostname()}\n`);
  } catch (err) {
    fs.rmSync(o.lock, { recursive: true, force: true }); // A lock nobody is named in could never be taken over.
    throw err;
  }
}

/**
 * The pid in a lock's owner file when that installer has stopped: it was on this computer and no process has its
 * pid now. Null when it may still be at work, or the file can't be read.
 * @param {string} file
 * @returns {number | null}
 */
function stoppedOwner(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null; // Not written yet (its installer has only just made the lock), or not ours to read: can't tell.
  }
  const m = /^(\d+) (\S+)\s*$/.exec(String(text));
  if (!m || m[2] !== os.hostname()) return null;
  const pid = Number(m[1]);
  try {
    process.kill(pid, 0);
    return null; // Still running.
  } catch (err) {
    // EPERM: another account's process has that pid now, so it can't be told from the installer: keep the lock.
    return /** @type {any} */ (err)?.code === "ESRCH" ? pid : null;
  }
}

/**
 * How to start the installed app with `args`: open(1) on macOS (so Ember.app, not the terminal, is the app macOS asks
 * for permissions for), the program itself elsewhere.
 * @param {string} platform
 * @param {{ exe: string; app: string }} installed
 * @param {string[]} args
 * @returns {{ file: string; args: string[] }}
 */
export function launchCommand(platform, installed, args) {
  if (platform === "darwin") return { file: "open", args: ["-n", installed.app, ...(args.length ? ["--args", ...args] : [])] };
  return { file: installed.exe, args };
}

/**
 * The command lines of the programs running now (`ps`; on Windows nothing, where a running Ember's folder can't be
 * renamed anyway). Throws when they can't be read, so nothing is removed then.
 * @returns {string}
 */
function runningCommands() {
  if (process.platform === "win32") return "";
  const r = spawnSync("ps", ["-axo", "command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error("ps failed");
  return r.stdout;
}

/**
 * Removes the cache's other versions once `keep` is installed, so each update doesn't leave the last one (200–600 MB)
 * behind. Only a complete install (its marker in place) is removed, never one whose installer holds its lock or whose
 * folder a running program's command line names, nor anything that isn't a version folder. Each goes by renaming it
 * aside first, which fails on Windows while Ember runs from it, and is skipped quietly on any failure; one left half
 * removed is retried next time. Its start log goes with it.
 * @param {{ parent: string; keep: string; platform?: string; running?: () => string }} o
 * @returns {string[]} the versions removed
 */
export function pruneVersions(o) {
  const p = (o.platform ?? process.platform) === "win32" ? pathWin32 : pathPosix;
  let names, running;
  try {
    names = fs.readdirSync(o.parent);
    running = (o.running ?? runningCommands)();
  } catch {
    return []; // Can't tell what is there or what runs: keep everything.
  }
  const removed = [];
  for (const name of names) {
    const leftover = /^\.trash-/.test(name);
    if (!leftover && (name === o.keep || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(name))) continue;
    const dir = p.join(o.parent, name);
    try {
      if (!leftover) {
        if (!fs.existsSync(p.join(dir, MARKER)) || fs.existsSync(p.join(o.parent, `.${name}-install-lock`)) || running.includes(dir)) continue;
        const aside = p.join(o.parent, `.trash-${name}-${process.pid}`);
        fs.renameSync(dir, aside);
        removed.push(name);
        fs.rmSync(p.join(o.parent, `.${name}-start.log`), { force: true });
        fs.rmSync(aside, { recursive: true, force: true });
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // In use, or not ours to remove: left for the next update.
    }
  }
  return removed;
}

/**
 * How the launcher runs Ember for `args`: the setup check (`doctor` or `--doctor`, passed on as `--doctor`, which the
 * AppImage's AppRun and Ember.exe both take) attached, so its report and exit code reach the terminal; anything else
 * detached, since Ember keeps running.
 * @param {string[]} args
 * @returns {{ attached: boolean; args: string[] }}
 */
export function runMode(args) {
  const doctor = args[0] === "doctor" || args.includes("--doctor");
  if (!doctor) return { attached: false, args };
  return { attached: true, args: ["--doctor", ...args.filter((a, i) => a !== "--doctor" && !(i === 0 && a === "doctor"))] };
}

/** How long a detached Ember is watched for: one that stops within this has failed to start (no display, a crash). */
const EARLY_MS = 3000;

/**
 * Starts `cmd`. Attached, it waits and passes on its output and exit code. Detached, its stderr goes to `log` (or
 * nowhere, where the log can't be made in a folder this user can't write in) and it is watched for `earlyMs`: if it stops in that time with an error, what it said is printed and its exit code
 * returned; otherwise it is left running and 0 returned. (A pipe would break once the launcher exits, and Ember's
 * writes to a closed pipe would fail.)
 * @param {{ file: string; args: string[] }} cmd
 * @param {{ attached: boolean; log: string; earlyMs?: number; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream }} o
 * @returns {Promise<number>}
 */
export async function start(cmd, o) {
  return (await startWatched(cmd, o)).code;
}

/**
 * As start(), and whether a detached start was still running when its watch ended (`stayed`): one that ended at once
 * with 0 has handed its request to an Ember already running, as a second Ember does. (open(1) on a Mac always ends at
 * once, so there only what runs can tell.)
 * @param {{ file: string; args: string[] }} cmd
 * @param {{ attached: boolean; log: string; earlyMs?: number; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream }} o
 * @returns {Promise<{ code: number; stayed: boolean }>}
 */
export async function startWatched(cmd, o) {
  const stdout = o.stdout ?? process.stdout;
  const stderr = o.stderr ?? process.stderr;
  if (o.attached) {
    return await new Promise((resolve, reject) => {
      const child = spawn(cmd.file, cmd.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
      child.stdout.pipe(stdout, { end: false });
      child.stderr.pipe(stderr, { end: false });
      child.once("error", err => reject(new Error(`starting ${cmd.file} failed: ${err.message}`, { cause: err })));
      child.once("close", (code, signal) => resolve({ code: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1), stayed: false }));
    });
  }
  let fd = null;
  try {
    fd = fs.openSync(o.log, "w", 0o600);
  } catch (err) {
    // A folder this user can't write in (another user's, as a run with sudo or an administrator's shared cache leaves
    // it, or a read-only disk): the copy there still starts, only without a log of what it says, so a reinstall's
    // "the copy you had is kept. Run 'ember' to start it" holds (install-docs-v5-2). A full disk is said (install-docs-r4-2).
    if (!LOCKED.has(/** @type {any} */ (err)?.code)) throw err;
  }
  let child;
  try {
    child = await new Promise((resolve, reject) => {
      const c = spawn(cmd.file, cmd.args, { detached: true, stdio: ["ignore", "ignore", fd ?? "ignore"], windowsHide: false });
      c.once("error", err => reject(new Error(`starting ${cmd.file} failed: ${err.message}`, { cause: err })));
      c.once("spawn", () => resolve(c));
    });
    try {
      if (fd !== null) fs.writeSync(fd, `pid ${child.pid}\n`);
    } catch {
      // No room for it (a disk that filled since Ember was installed): Ember has started all the same, and is watched
      // and let go as ever, so the start isn't said as a failure, nor the terminal held until Ember quits (install-docs-r4-2).
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  const ended = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), o.earlyMs ?? EARLY_MS);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  child.unref();
  if (!ended || ended.code === 0) return { code: 0, stayed: !ended };
  const said = fd === null ? "" : fs.readFileSync(o.log, "utf8").replace(/^pid \d+\n/m, "").trim();
  stderr.write(`ember-copilot: Ember stopped as it started (${ended.code === null ? `signal ${ended.signal}` : `exit ${ended.code}`})${said ? `:\n${said.slice(-4000)}` : "."}\n`);
  return { code: ended.code ?? 1, stayed: false };
}

/**
 * What the launcher says when the Ember it started handed its request to one already running instead of starting:
 * `older` is that one's version when the cache's folders tell it, else null.
 * @param {string} version
 * @param {string | null} older
 * @param {string} name what the person runs it as (invokedAs)
 */
export function handedOver(version, older, name) {
  return older
    ? `Ember ${older} is already running, so it took this instead of starting ${version}. To start ${version}, quit Ember, then run '${name}' again.`
    : `Ember was already running, so it took this. If it is older than ${version}, quit Ember, then run '${name}' again to start ${version}.`;
}

/**
 * What the launcher says when the Ember it started ended at once with 0 and isn't what runs: it handed what was asked
 * to an Ember already running (or, on a Mac, open(1) ended, as it always does).
 * @param {{ version: string; platform: string; name: string; running: string | null; others: { version: string; dir: string }[] }} o
 *   running: the running programs' command lines (ps), or null where they can't be read (Windows); others: the
 *   cache's other complete versions
 */
export function afterHandover(o) {
  const sep = o.platform === "win32" ? "\\" : "/";
  const running = o.running;
  const older = running === null ? null : o.others.find(c => running.includes(`${c.dir}${sep}`))?.version ?? null;
  if (older !== null) return handedOver(o.version, older, o.name);
  // A Mac's open(1) tells nothing, and a new Ember.app may still be starting (Gatekeeper's first check).
  if (o.platform === "darwin") return `started Ember ${o.version}`;
  // Where what runs isn't read (Windows) and the cache holds only this version, the Ember running is this one, or one
  // unzipped from the Releases page, which shares its single-instance lock: running `ember` again for its settings, as
  // the help says, isn't told its own may be out of date, and the zip's older one is still named (install-docs-r3-3).
  if (running === null && !o.others.length && o.platform === "win32") {
    return `Ember was already running, so it took this. If that is an older Ember you installed from the zip, quit it, then run '${o.name}' again to start ${o.version}.`;
  }
  return handedOver(o.version, null, o.name);
}

/**
 * The command the person ran, to name it in what the launcher says: `npx ember-copilot` under npx (which npm runs
 * with npm_command "exec"), otherwise `ember-copilot` or `ember` as its bin was called (npm's Windows shims run the
 * script itself, which reads as `ember`).
 * @param {string | undefined} script process.argv[1]
 * @param {Record<string, string | undefined>} env
 */
export function invokedAs(script, env) {
  if (env.npm_command === "exec") return "npx ember-copilot";
  return pathPosix.basename(String(script ?? "").replace(/\\/g, "/")) === "ember-copilot" ? "ember-copilot" : "ember";
}

/**
 * The launcher's help (`--help`, `-h`, `--npm-help`): Ember's own commands as it passes them on, then its options. It
 * answers for Ember, whose AppImage, Ember.exe and Ember.app would start rather than print usage.
 * @param {string} name what the person runs it as (invokedAs)
 */
export function usage(name) {
  const rows = [
    [name, "start Ember (it stays beside your cursor; run it again for its settings)"],
    [`${name} doctor`, "check this computer and explain anything that needs fixing"],
    [`${name} --show-settings`, "start Ember and open its settings"],
    [`${name} --ask`, "open the ask box (starting Ember if it isn't running)"],
  ];
  const width = Math.max(...rows.map(r => r[0].length)) + 2;
  return `ember-copilot starts Ember (https://github.com/${REPO}), downloading it on first run.

usage: ${name} [doctor | --show-settings | --ask]
${rows.map(([c, d]) => `  ${c.padEnd(width)}${d}`).join("\n")}
Other arguments are passed on to Ember.

Launcher options (not passed to Ember):
  --npm-install-only   download and check Ember if needed, print where it is, and exit
  --npm-reinstall      download it again even if it is already in the cache
  --npm-where          print the cache folder for this version and exit
  --npm-help           this text (also --help and -h)

Environment: EMBER_NPM_CACHE (cache folder), EMBER_NPM_DOWNLOAD_BASE (mirror of the releases' download URL),
EMBER_NPM_QUIET=1 (no progress messages). Downloads go through npm's https-proxy or proxy setting, else HTTPS_PROXY
(HTTP_PROXY for an http mirror), except to the hosts in NO_PROXY.`;
}

/**
 * What to say instead of starting Ember on Linux without a display (an ssh session without -X, a text console), or
 * null. Ember would only stop as it starts, and the AppImage's own words name its file in the cache, which isn't on
 * the person's PATH; this names the command they ran.
 * @param {string} platform
 * @param {Record<string, string | undefined>} env
 * @param {string} name what the person runs it as (invokedAs)
 */
export function noDisplay(platform, env, name) {
  if (platform !== "linux" || env.DISPLAY) return null;
  return `Ember needs your desktop session (no display here). Run '${name}' from a terminal inside GNOME, or run '${name} doctor' to check this computer.`;
}

/**
 * The `ember` command.
 * @param {string[]} argv the arguments after the script
 * @param {{ platform?: string; arch?: string; env?: Record<string, string | undefined>; earlyMs?: number }} [o] this computer's, unless a test says otherwise
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, o = {}) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const own = new Set(["--npm-install-only", "--npm-reinstall", "--npm-where", "--npm-help"]);
  const flags = new Set(argv.filter(a => own.has(a)));
  const args = argv.filter(a => !own.has(a));
  const version = packageVersion();
  const name = invokedAs(process.argv[1], env);
  if (flags.has("--npm-help") || args.includes("--help") || args.includes("-h")) { process.stdout.write(`${usage(name)}\n`); return 0; }
  if (flags.has("--npm-where")) {
    process.stdout.write(`${cacheDir({ platform, env, home: os.homedir(), version })}\n`);
    return 0;
  }
  const mode = runMode(args);
  // Said before any download: the setup check and an install-only run need no display, and go ahead.
  const blocked = mode.attached || flags.has("--npm-install-only") ? null : noDisplay(platform, env, name);
  if (blocked) { process.stderr.write(`ember-copilot: ${blocked}\n`); return 1; }
  const installed = await ensureInstalled({ version, platform, arch: o.arch, env, force: flags.has("--npm-reinstall"), name });
  if (flags.has("--npm-install-only")) { process.stdout.write(`${installed.exe}\n`); return 0; }
  const p = platform === "win32" ? pathWin32 : pathPosix;
  const log = p.join(p.dirname(installed.dir), `.${version}-start.log`);
  if (mode.attached && platform === "darwin") return await doctorMac(installed, mode.args, log);
  const cmd = launchCommand(platform, installed, mode.args);
  const { code, stayed } = await startWatched(cmd, { attached: mode.attached, log, earlyMs: o.earlyMs }).catch(err => {
    // This computer refusing to run Ember's program (a security policy such as fapolicyd, antivirus), said as such,
    // not as a folder this user can't write in, which doesn't stop a start (install-docs-v5-1); a disk too full to make
    // the start log in the cache folder, said as this computer's (install-docs-r4-2).
    const refused = cmd.file === installed.exe ? refusedStart(err) : undefined;
    if (refused) throw new Error(cantRun(refused, { exe: installed.exe, name, platform }), { cause: err });
    throw onDisk(err, { folder: p.dirname(installed.dir), version, name });
  });
  if (!mode.attached && code === 0) {
    // Is this version what runs now? Still running after the watch, or its folder in a running command line (a Mac's
    // open(1) ends at once). Otherwise it handed over to an Ember already running (install-docs-c2-3).
    const parent = p.dirname(installed.dir);
    let ps = null;
    try {
      if (platform !== "win32") ps = runningCommands();
    } catch {
      // ps couldn't run: judged by the watch alone.
    }
    const shows = (/** @type {string} */ dir) => ps !== null && ps.includes(`${dir}${p.sep}`);
    if (stayed || shows(installed.dir)) {
      // Only once this version has started: Ember then points Start Ember when I log in (and Windows' Start menu
      // shortcut) at itself, which the setup check and an install-only run don't, so until then the older one stays.
      const removed = pruneVersions({ parent, keep: version, platform });
      if (removed.length) say(`removed the older ${removed.length === 1 ? "version" : "versions"} ${removed.join(", ")} from the cache`);
      say(`started Ember ${version}`);
    } else {
      // Nothing is removed: Start at login still points at the one running.
      let names = [];
      try { names = fs.readdirSync(parent); } catch { /* No cache folder to read: the older one can't be named. */ }
      const others = names.filter(v => v !== version && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v) && fs.existsSync(p.join(parent, v, MARKER)));
      say(afterHandover({ version, platform, name, running: ps, others: others.map(v => ({ version: v, dir: p.join(parent, v) })) }));
    }
  }
  return code;
}

/**
 * The setup check on a Mac: through open(1), so macOS judges Ember's own permissions (run directly, it would report
 * the terminal's), with its report sent to a file and printed once it finishes (README.md, Install on macOS).
 * @param {{ exe: string; app: string }} installed
 * @param {string[]} args
 * @param {string} log
 */
async function doctorMac(installed, args, log) {
  const report = `${log}.doctor`;
  fs.writeFileSync(report, "", { mode: 0o600 });
  fs.writeFileSync(log, "", { mode: 0o600 });
  const code = await start({ file: "open", args: ["-n", "-W", "--stdout", report, "--stderr", log, installed.app, "--args", ...args] }, { attached: true, log });
  process.stdout.write(fs.readFileSync(report, "utf8"));
  process.stderr.write(fs.readFileSync(log, "utf8"));
  return code;
}
