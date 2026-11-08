/**
 * The npm launcher (packages/npm, published as ember-copilot): which release file each platform downloads and where
 * the program is inside it, reading SHA256SUMS, the cache folders, how Ember is started, and that the package's version
 * is the app's, which the publish workflow (.github/workflows/npm.yml) relies on.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { assetFor, cacheDir, downloadUrl, ensureInstalled, handedOver, invokedAs, launchCommand, main, noDisplay, notReleased, npmrcProxy, packageVersion, parseSha256Sums, proxyFor, pruneVersions, releaseSource, REPO, runMode, start, usage } from "../../packages/npm/lib/launcher.mjs";
import { releaseFiles } from "../../scripts/package/release.mjs";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8");
const root = JSON.parse(read("package.json"));
const launcher = JSON.parse(read("packages/npm/package.json"));

describe("assetFor", () => {
  it("picks the release file and program for each supported platform", () => {
    expect(assetFor("win32", "x64", "1.2.3")).toEqual({ asset: "Ember-1.2.3-win-x64.zip", kind: "zip", exe: "Ember/Ember.exe", app: "Ember" });
    expect(assetFor("darwin", "arm64", "1.2.3")).toEqual({ asset: "Ember-1.2.3-mac-arm64.zip", kind: "zip", exe: "Ember.app/Contents/MacOS/Ember", app: "Ember.app" });
    expect(assetFor("darwin", "x64", "1.2.3").asset).toBe("Ember-1.2.3-mac-x64.zip");
    expect(assetFor("linux", "x64", "1.2.3")).toEqual({ asset: "Ember-1.2.3-x86_64.AppImage", kind: "appimage", exe: "Ember-1.2.3-x86_64.AppImage", app: "Ember-1.2.3-x86_64.AppImage" });
  });
  it("refuses platforms with no release", () => {
    for (const [p, a] of [["linux", "arm64"], ["win32", "arm64"], ["freebsd", "x64"], ["darwin", "ia32"]]) {
      expect(() => assetFor(p, a, "1.2.3"), `${p}-${a}`).toThrow(/has no release for/);
    }
  });
  it("only downloads files every release has", () => {
    const files = releaseFiles("1.2.3");
    for (const [p, a] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) expect(files).toContain(assetFor(p, a, "1.2.3").asset);
  });
});

describe("parseSha256Sums", () => {
  const h = (c: string) => c.repeat(64);
  it("reads sha256sum's text and binary lines, skipping blanks and comments", () => {
    const sums = parseSha256Sums(`# sums\n${h("A")}  Ember-1.2.3-win-x64.zip\r\n\n${h("b")} *Ember-1.2.3-x86_64.AppImage\n`);
    expect([...sums]).toEqual([["Ember-1.2.3-win-x64.zip", h("a")], ["Ember-1.2.3-x86_64.AppImage", h("b")]]);
  });
  it("throws on a line that isn't a SHA-256 line", () => {
    expect(() => parseSha256Sums(`${h("a")}  ok.zip\nnot a hash  bad.zip\n`)).toThrow(/line 2/);
    expect(() => parseSha256Sums(`${"a".repeat(40)}  sha1.zip\n`)).toThrow(/line 1/);
  });
  it("reads the release's own SHA256SUMS format (docs/DEVELOPING.md §15: hash, two spaces, name)", () => {
    const line = `${h("c")}  ${releaseFiles("0.1.0")[0]}`;
    expect(parseSha256Sums(line).get(releaseFiles("0.1.0")[0])).toBe(h("c"));
  });
});

describe("cacheDir", () => {
  it("uses each platform's per-user cache folder", () => {
    expect(cacheDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\k\\AppData\\Local" }, home: "C:\\Users\\k", version: "1.2.3" })).toBe("C:\\Users\\k\\AppData\\Local\\ember-npm\\1.2.3");
    expect(cacheDir({ platform: "win32", env: {}, home: "C:\\Users\\k", version: "1.2.3" })).toBe("C:\\Users\\k\\AppData\\Local\\ember-npm\\1.2.3");
    expect(cacheDir({ platform: "darwin", env: {}, home: "/Users/k", version: "1.2.3" })).toBe("/Users/k/Library/Caches/ember-npm/1.2.3");
    expect(cacheDir({ platform: "linux", env: {}, home: "/home/k", version: "1.2.3" })).toBe("/home/k/.cache/ember-npm/1.2.3");
    expect(cacheDir({ platform: "linux", env: { XDG_CACHE_HOME: "/var/c" }, home: "/home/k", version: "1.2.3" })).toBe("/var/c/ember-npm/1.2.3");
    expect(cacheDir({ platform: "linux", env: { XDG_CACHE_HOME: "relative" }, home: "/home/k", version: "1.2.3" })).toBe("/home/k/.cache/ember-npm/1.2.3");
    expect(cacheDir({ platform: "linux", env: { EMBER_NPM_CACHE: "/tmp/e" }, home: "/home/k", version: "1.2.3" })).toBe("/tmp/e/1.2.3");
  });
});

describe("downloads and starting", () => {
  it("downloads from the version's GitHub release, or a mirror", () => {
    expect(REPO).toBe("komaladitya-08/Ember-Powered-by-Github-Copilot");
    expect(downloadUrl("1.2.3", "SHA256SUMS")).toBe(`https://github.com/${REPO}/releases/download/v1.2.3/SHA256SUMS`);
    expect(downloadUrl("1.2.3", "a b.zip", { EMBER_NPM_DOWNLOAD_BASE: "http://127.0.0.1:9/m/" })).toBe("http://127.0.0.1:9/m/v1.2.3/a%20b.zip");
  });
  it("starts Ember.app with open(1) on macOS, passing the arguments, and the program itself elsewhere", () => {
    const i = { exe: "/c/Ember.app/Contents/MacOS/Ember", app: "/c/Ember.app" };
    expect(launchCommand("darwin", i, [])).toEqual({ file: "open", args: ["-n", "/c/Ember.app"] });
    expect(launchCommand("darwin", i, ["--doctor"])).toEqual({ file: "open", args: ["-n", "/c/Ember.app", "--args", "--doctor"] });
    expect(launchCommand("linux", { exe: "/c/E.AppImage", app: "/c/E.AppImage" }, ["a", "b c"])).toEqual({ file: "/c/E.AppImage", args: ["a", "b c"] });
  });
});

/** A local server for a release's files (`files`: path under the download base → content); anything else is a 404. */
async function serve(files: Record<string, string | Buffer> = {}) {
  const server = http.createServer((req, res) => {
    const body = files[decodeURIComponent(req.url ?? "")];
    if (body === undefined) { res.statusCode = 404; res.end("Not Found"); return; }
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const scratch: string[] = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-npm-test-")); scratch.push(d); return d; };
afterEach(() => { vi.unstubAllEnvs(); for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("a version whose release isn't published", () => {
  it("says the version isn't on GitHub Releases yet, instead of an HTTP error, and leaves nothing behind (install-docs-2)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    const server = await serve();
    const cache = tempDir();
    try {
      const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: cache };
      const err = await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env }).then(() => null, (e: Error) => e);
      expect(err?.message).toBe(notReleased("9.9.9", env));
      expect(err?.message).not.toMatch(/HTTP|404|downloading/);
      // No lock or half-made folder stays in the cache.
      expect(fs.readdirSync(cache)).toEqual([]);
    } finally {
      await server.close();
    }
    expect(notReleased("9.9.9", {})).toBe(`Ember 9.9.9 isn't on GitHub Releases yet, so there is nothing to start. Install a published version from https://github.com/${REPO}/releases instead.`);
    expect(notReleased("9.9.9", { EMBER_NPM_DOWNLOAD_BASE: "http://mirror.example/r" })).toContain("isn't on the mirror at http://mirror.example/r yet");
  });
});

describe("where the launcher gets Ember from", () => {
  it("names the mirror it downloads from, not GitHub Releases, when one is set (install-docs-2)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "");
    const server = await serve();
    const said: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { said.push(String(chunk)); return true; }) as never);
    try {
      const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: tempDir() };
      await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env }).catch(() => null);
    } finally {
      spy.mockRestore();
      await server.close();
    }
    expect(said.join("")).toContain(`ember-copilot: getting Ember 9.9.9 for linux-x64 (Ember-9.9.9-x86_64.AppImage) from the mirror at ${server.base}\n`);
    expect(said.join("")).not.toContain("GitHub Releases");
    expect(releaseSource({})).toBe("GitHub Releases");
    expect(releaseSource({ EMBER_NPM_DOWNLOAD_BASE: "http://mirror.example/r" })).toBe("the mirror at http://mirror.example/r");
  });
});

/** A port on this computer that nothing listens on. */
async function closedPort() {
  const s = net.createServer();
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}
/** No .npmrc settings from the computer running the tests. */
const noNpmrc = { npm_config_userconfig: path.join(os.tmpdir(), "ember-no-such-npmrc"), npm_config_globalconfig: path.join(os.tmpdir(), "ember-no-such-npmrc") };
/** A release's files for `version`: a stand-in AppImage of `size` bytes and its SHA256SUMS. */
function release(version: string, size = 64) {
  const asset = `Ember-${version}-x86_64.AppImage`, body = Buffer.alloc(size, 7);
  return { asset, body, files: { [`/v${version}/${asset}`]: body, [`/v${version}/SHA256SUMS`]: `${createHash("sha256").update(body).digest("hex")}  ${asset}\n` } as Record<string, string | Buffer> };
}
/** A proxy on this computer that records what it is asked, and answers with `answer` (or tunnels where it says). */
async function proxyServer(o: { files?: Record<string, string | Buffer>; connect?: (target: string) => number | "407" | "403" }) {
  const asked: { line: string; auth?: string }[] = [];
  const server = http.createServer((req, res) => {
    asked.push({ line: `${req.method} ${req.url}`, auth: req.headers["proxy-authorization"] });
    const body = o.files?.[String(req.url)];
    if (body === undefined) { res.statusCode = 404; res.end("Not Found"); return; }
    res.end(body);
  });
  server.on("connect", (req: http.IncomingMessage, socket: net.Socket) => {
    asked.push({ line: `CONNECT ${req.url}`, auth: req.headers["proxy-authorization"] });
    const to = o.connect?.(String(req.url)) ?? "403";
    if (to === "407") { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n"); return; }
    if (to === "403") { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const up = net.connect(to, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection established\r\n\r\n"); up.pipe(socket); socket.pipe(up); });
    sockets.add(up);
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  // Tunnels aren't the server's connections any more, so closing it waits for them: end them all.
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => sockets.add(socket));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, asked, close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }) };
}
/** A self-signed certificate for a mirror's name, from openssl if there is one (nothing is committed). */
const mirrorCert = (() => {
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-npm-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(d, "key.pem"), "-out", path.join(d, "cert.pem"), "-days", "2", "-subj", "/CN=ember-mirror.test", "-addext", "subjectAltName=DNS:ember-mirror.test"], {
      stdio: "ignore",
      // Git for Windows' openssl would otherwise rewrite "/CN=..." as a Windows path.
      env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    });
    return { dir: d, key: fs.readFileSync(path.join(d, "key.pem")), cert: fs.readFileSync(path.join(d, "cert.pem")), certFile: path.join(d, "cert.pem") };
  } catch {
    return null; // No openssl (or one without -addext): the tunnel's own steps are still covered below.
  }
})();
/** Runs the launcher's command as a person would, with only `env` (and PATH) in its environment. */
function runLauncher(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [path.resolve("packages/npm/bin/ember.mjs"), ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", d => { out += String(d); });
  child.stderr.on("data", d => { err += String(d); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  return { child, ended, out: () => out, err: () => err };
}

describe("when the launcher can't reach the download (install-docs-r2-1)", () => {
  it("says in one plain sentence why and what to do next, never \"fetch failed\" (install-docs-r2-1)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    const port = await closedPort();
    const cache = tempDir();
    const env = { EMBER_NPM_DOWNLOAD_BASE: `http://127.0.0.1:${port}`, EMBER_NPM_CACHE: cache, ...noNpmrc };
    const err = await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env, name: "npx ember-copilot" }).then(() => null, (e: Error) => e);
    expect(err?.message).toBe(`Ember couldn't reach the mirror at http://127.0.0.1:${port}: the connection was refused (ECONNREFUSED). If this computer reaches the internet through a proxy, set HTTP_PROXY (or npm's proxy setting) to it. Then run 'npx ember-copilot' again, or download Ember-9.9.9-x86_64.AppImage from https://github.com/${REPO}/releases/tag/v9.9.9 in your browser.`);
    expect(err?.message).not.toContain("fetch failed");
    expect(fs.readdirSync(cache)).toEqual([]);
  });

  it("goes to GitHub through the proxy HTTPS_PROXY names, as npm did, and says what the proxy answered without its password (install-docs-r2-1)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    const proxy = await proxyServer({ connect: () => "407" });
    const cache = tempDir();
    try {
      const env = { HTTPS_PROXY: `http://kim:s3cret@127.0.0.1:${proxy.port}`, EMBER_NPM_CACHE: cache, ...noNpmrc };
      const err = await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env }).then(() => null, (e: Error) => e);
      // It asked the proxy for a tunnel to github.com, with the proxy's sign-in, and never went straight there.
      expect(proxy.asked).toEqual([{ line: "CONNECT github.com:443", auth: `Basic ${Buffer.from("kim:s3cret").toString("base64")}` }]);
      expect(err?.message).toBe(`Ember couldn't reach GitHub Releases through the proxy at 127.0.0.1:${proxy.port}: the proxy asked for a user name and password (407). Put your user name and password in HTTPS_PROXY (http://name:password@127.0.0.1:${proxy.port}). Then run 'ember' again, or download Ember-9.9.9-x86_64.AppImage from https://github.com/${REPO}/releases/tag/v9.9.9 in your browser, or set EMBER_NPM_DOWNLOAD_BASE to your organisation's mirror.`);
      expect(err?.message).not.toContain("s3cret");
      expect(fs.readdirSync(cache)).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("downloads a mirror through HTTP_PROXY when only the proxy can reach it (install-docs-r2-1)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    const r = release("9.9.9");
    // The proxy alone knows mirror.invalid: going straight there would fail to resolve.
    const proxy = await proxyServer({ files: Object.fromEntries(Object.entries(r.files).map(([k, v]) => [`http://mirror.invalid${k}`, v])) });
    const cache = tempDir();
    try {
      const env = { http_proxy: `127.0.0.1:${proxy.port}`, EMBER_NPM_DOWNLOAD_BASE: "http://mirror.invalid", EMBER_NPM_CACHE: cache, ...noNpmrc };
      const installed = await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env });
      expect(fs.readFileSync(installed.exe)).toEqual(r.body);
      expect(proxy.asked.map(a => a.line)).toEqual([`GET http://mirror.invalid/v9.9.9/SHA256SUMS`, `GET http://mirror.invalid/v9.9.9/${r.asset}`]);
    } finally {
      await proxy.close();
    }
  });

  it.skipIf(!mirrorCert || process.platform !== "linux" || process.arch !== "x64")("downloads an https mirror through a CONNECT tunnel, checking the mirror's own certificate (install-docs-r2-1)", async () => {
    const v = packageVersion();
    const r = release(v, 300_000);
    const mirror = https.createServer({ key: mirrorCert!.key, cert: mirrorCert!.cert }, (req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      const body = r.files[url.replace(/^\/store/, "")];
      if (body === undefined) { res.statusCode = 404; res.end(); return; }
      // As GitHub serves a release file: a redirect to where it is stored.
      if (url.endsWith(".AppImage") && !url.startsWith("/store/")) { res.statusCode = 302; res.setHeader("location", `/store${req.url}`); res.end(); return; }
      res.end(body);
    });
    await new Promise<void>(resolve => mirror.listen(0, "127.0.0.1", resolve));
    const mirrorPort = (mirror.address() as AddressInfo).port;
    const proxy = await proxyServer({ connect: target => target === "ember-mirror.test:443" ? mirrorPort : "403" });
    const cache = tempDir();
    try {
      const run = runLauncher(["--npm-install-only"], { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NODE_EXTRA_CA_CERTS: mirrorCert!.certFile, EMBER_NPM_DOWNLOAD_BASE: "https://ember-mirror.test", EMBER_NPM_CACHE: cache, ...noNpmrc });
      const ended = await run.ended;
      expect(run.err()).not.toContain("couldn't reach");
      expect(ended.code).toBe(0);
      expect(fs.readFileSync(run.out().trim()).equals(r.body)).toBe(true);
      expect(proxy.asked.map(a => a.line)).toEqual(["CONNECT ember-mirror.test:443", "CONNECT ember-mirror.test:443", "CONNECT ember-mirror.test:443"]);
    } finally {
      await proxy.close();
      mirror.closeAllConnections();
      await new Promise<void>(resolve => mirror.close(() => resolve()));
      fs.rmSync(mirrorCert!.dir, { recursive: true, force: true });
    }
  });

  it("says what answered, through which proxy, and what to do when a proxy or server answers with an error, never a bare HTTP status (install-docs-r2-1)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    const tail = `Then run 'ember' again, or download Ember-9.9.9-x86_64.AppImage from https://github.com/${REPO}/releases/tag/v9.9.9 in your browser.`;
    // A proxy that can't get to the mirror, answering 502 as a corporate proxy does for a host it can't reach.
    const proxy = http.createServer((_req, res) => { res.writeHead(502, "Bad Gateway", { "content-type": "text/html" }); res.end("<html>Bad gateway</html>"); });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as AddressInfo).port;
    // A mirror whose release file is stored elsewhere (as GitHub redirects to its storage host), which is down.
    const r = release("9.9.9");
    const store = http.createServer((_req, res) => { res.writeHead(503, "Service Unavailable"); res.end(); });
    await new Promise<void>(resolve => store.listen(0, "127.0.0.1", resolve));
    const storePort = (store.address() as AddressInfo).port;
    const mirror = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      if (url.endsWith(".AppImage")) { res.writeHead(302, { location: `http://127.0.0.1:${storePort}/store${url}` }); res.end(); return; }
      const body = r.files[url];
      if (body === undefined) { res.statusCode = 404; res.end(); return; }
      res.end(body);
    });
    await new Promise<void>(resolve => mirror.listen(0, "127.0.0.1", resolve));
    const mirrorBase = `http://127.0.0.1:${(mirror.address() as AddressInfo).port}`;
    try {
      const cache = tempDir();
      const viaProxy = await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env: { http_proxy: `127.0.0.1:${proxyPort}`, EMBER_NPM_DOWNLOAD_BASE: "http://mirror.invalid", EMBER_NPM_CACHE: cache, ...noNpmrc } }).then(() => null, (e: Error) => e);
      expect(viaProxy?.message).toBe(`The download of Ember 9.9.9 from the mirror at http://mirror.invalid through the proxy at 127.0.0.1:${proxyPort} failed: the proxy couldn't get an answer from mirror.invalid (502 Bad Gateway). Check http_proxy, which names that proxy, or ask whoever runs it to let this computer reach mirror.invalid. ${tail}`);
      const redirected = await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env: { EMBER_NPM_DOWNLOAD_BASE: mirrorBase, EMBER_NPM_CACHE: cache, ...noNpmrc } }).then(() => null, (e: Error) => e);
      // It names the host that answered, which an allow-list may be missing, not the address it started from.
      expect(redirected?.message).toBe(`The download of Ember 9.9.9 from the mirror at ${mirrorBase} failed: 127.0.0.1:${storePort} answered 503 Service Unavailable. ${tail.replace("Then run", "Run")}`);
      for (const err of [viaProxy, redirected]) expect(err?.message).not.toMatch(/downloading|HTTP/);
      expect(fs.readdirSync(cache)).toEqual([]);
    } finally {
      for (const s of [proxy, store, mirror]) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
    }
  });

  it("starts with what to do when the download is cut off part way, not with a \"Then\" after no step (install-docs-r3-2)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    const r = release("9.9.9", 4 * 1024 * 1024);
    // A quarter of the release file, then the connection drops (a mirror restarting, a network blip).
    const server = http.createServer((req, res) => {
      const body = r.files[decodeURIComponent(req.url ?? "")];
      if (body === undefined) { res.statusCode = 404; res.end(); return; }
      const buf = Buffer.from(body);
      res.setHeader("content-length", buf.length);
      if (!String(req.url).endsWith(".AppImage")) { res.end(buf); return; }
      res.write(buf.subarray(0, buf.length / 4), () => res.socket?.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cache = tempDir();
    try {
      const err = await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env: { EMBER_NPM_DOWNLOAD_BASE: base, EMBER_NPM_CACHE: cache, ...noNpmrc } }).then(() => null, (e: Error) => e);
      expect(err?.message).toBe(`The download of ${r.asset} from the mirror at ${base} stopped: the connection was cut off (ECONNRESET). Run 'ember' again, or download ${r.asset} from https://github.com/${REPO}/releases/tag/v9.9.9 in your browser.`);
      expect(fs.readdirSync(cache)).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("says there isn't room, and where, when the disk or quota fills during the download, instead of blaming the download (install-docs-c3-1)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    const r = release("9.9.9", 3 * 1024 * 1024);
    const server = await serve(r.files);
    const real = fs.createWriteStream.bind(fs);
    try {
      for (const [code, why] of [["ENOSPC", "the disk is full"], ["EDQUOT", "your disk quota is used up"]]) {
        const cache = tempDir();
        // As a full disk answers: the write fails with no file named (Node's write streams name none). Linux's
        // /dev/full is a real one; elsewhere, and for a quota, a stand-in fails the same way.
        const spy = vi.spyOn(fs, "createWriteStream").mockImplementation(((file: string) => code === "ENOSPC" && fs.existsSync("/dev/full") && String(file).includes(cache) ? real("/dev/full")
          : new Writable({ write(_chunk, _enc, done) { done(Object.assign(new Error(`${code}: write failed`), { code, syscall: "write" })); } })) as never);
        try {
          const err = await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env: { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: cache, ...noNpmrc } }).then(() => null, (e: Error) => e);
          expect(err?.message, code).toBe(`There isn't room in ${cache} for Ember 9.9.9 (3 MB): ${why} (${code}). Free some space, or set EMBER_NPM_CACHE to a folder with room, then run 'ember' again.`);
        } finally {
          spy.mockRestore();
        }
        expect(fs.readdirSync(cache), code).toEqual([]);
      }
    } finally {
      await server.close();
    }
  });

  it("picks the proxy as npm does, and leaves out the hosts NO_PROXY names and this computer (install-docs-r2-1)", () => {
    const gh = "https://github.com/x/releases/download/v1/SHA256SUMS";
    const host = (url: string, env: Record<string, string>, npmrc = {}) => proxyFor(url, env, npmrc)?.url.host ?? null;
    expect(proxyFor(gh, {})).toBeNull();
    expect(proxyFor(gh, { HTTPS_PROXY: "http://p:8080" })).toMatchObject({ setting: "HTTPS_PROXY" });
    expect(host(gh, { https_proxy: "p:3128" })).toBe("p:3128");
    // An http mirror takes HTTP_PROXY, not HTTPS_PROXY (as curl does).
    expect(host("http://mirror.corp/v1/x", { HTTPS_PROXY: "http://p:8080" })).toBeNull();
    expect(host("http://mirror.corp/v1/x", { HTTP_PROXY: "http://p:8080" })).toBe("p:8080");
    // npm's own setting wins, from its environment first, then its .npmrc; "false" means none.
    expect(proxyFor(gh, { HTTPS_PROXY: "http://env:1", NPM_CONFIG_HTTPS_PROXY: "http://npm:2" })).toMatchObject({ setting: "npm's https-proxy setting" });
    expect(host(gh, { HTTPS_PROXY: "http://env:1" }, { proxy: "http://rc:3" })).toBe("rc:3");
    expect(host(gh, { npm_config_proxy: "http://npm:2" }, { "https-proxy": "http://rc:3" })).toBe("npm:2");
    expect(host(gh, { HTTPS_PROXY: "http://env:1" }, { "https-proxy": "false" })).toBe("env:1");
    for (const no of ["github.com", ".github.com", "*.github.com", "*", "example.org, github.com", "github.com:443"]) expect(host(gh, { HTTPS_PROXY: "http://p:1", NO_PROXY: no }), no).toBeNull();
    for (const no of ["hub.com", "github.com:8443", "gitlab.com"]) expect(host(gh, { HTTPS_PROXY: "http://p:1", no_proxy: no }), no).toBe("p:1");
    expect(host("https://objects.github.com/x", { HTTPS_PROXY: "http://p:1", NO_PROXY: "github.com" })).toBeNull();
    expect(host("http://10.1.2.3/x", { HTTP_PROXY: "http://p:1", NO_PROXY: "10.0.0.0/8" })).toBeNull();
    expect(host("http://11.1.2.3/x", { HTTP_PROXY: "http://p:1", NO_PROXY: "10.0.0.0/8" })).toBe("p:1");
    expect(host(gh, { HTTPS_PROXY: "http://p:1", npm_config_noproxy: "github.com" })).toBeNull();
    for (const url of ["http://127.0.0.1:9/x", "http://localhost/x", "http://[::1]:9/x"]) expect(host(url, { HTTP_PROXY: "http://p:1" }), url).toBeNull();
    expect(() => proxyFor(gh, { HTTPS_PROXY: "socks5://p:1080" })).toThrow("HTTPS_PROXY names a socks5 proxy; the launcher can use an http:// or https:// one");
  });

  it("reads only the proxy settings from npm's .npmrc files, which a global command doesn't get from npm (install-docs-r2-1)", () => {
    const d = tempDir();
    const user = path.join(d, "user-npmrc"), global = path.join(d, "global-npmrc");
    fs.writeFileSync(user, "; corp settings\nhttps-proxy = \"http://corp:3128\"\n//registry.npmjs.org/:_authToken=npm_s3cret\nnoproxy=${CORP_INTERNAL}\n");
    fs.writeFileSync(global, "proxy=http://global:8080\nhttps-proxy=http://ignored:1\n");
    expect(npmrcProxy({ npm_config_userconfig: user, npm_config_globalconfig: global, CORP_INTERNAL: ".corp" })).toEqual({ "https-proxy": "http://corp:3128", noproxy: ".corp", proxy: "http://global:8080" });
    expect(npmrcProxy({ ...noNpmrc })).toEqual({});
    // The user's .npmrc in their home folder, and npm's global npmrc beside Node, when nothing names them.
    fs.writeFileSync(path.join(d, ".npmrc"), "proxy=http://home:1\n");
    expect(npmrcProxy({}, { home: d, platform: "linux", execPath: path.join(d, "node", "bin", "node") })).toEqual({ proxy: "http://home:1" });
  });
});

describe("what the launcher's pages say about proxies and interrupted downloads", () => {
  it("say which proxy it uses and what to do when the download can't be reached (install-docs-r2-1)", () => {
    const own = read("packages/npm/README.md").replace(/\s+/g, " ");
    const proxies = own.split("## Proxies and offline computers")[1]?.split("## ")[0] ?? "";
    for (const w of ["npm's `https-proxy` or `proxy` setting", "`HTTPS_PROXY`", "`NO_PROXY`", "`NODE_EXTRA_CA_CERTS`", "`EMBER_NPM_DOWNLOAD_BASE`", "in your browser", "a proxy or server answers with an error", "set `EMBER_NPM_CACHE` to a folder with room"]) expect(proxies, w).toContain(w);
    expect(read("README.md").replace(/\s+/g, " ")).toContain("Behind a proxy it uses npm's proxy setting or `HTTPS_PROXY`, as npm does.");
    expect(usage("ember")).toContain("Downloads go through npm's https-proxy or proxy setting, else HTTPS_PROXY");
  });

  it("say an interrupted download cleans up after itself, and when a lock is left to the person (install-docs-c2-1)", () => {
    const own = read("packages/npm/README.md").replace(/\s+/g, " ");
    expect(own).not.toContain("Crash recovery is not automatic");
    expect(own).toContain("Ctrl+C, closing the terminal or stopping the launcher while it downloads ends the download and removes what it had made");
    expect(own).toContain("takes the lock over and removes the half-made download");
    expect(own).toContain("A stopped `--npm-reinstall` keeps the copy you had, which `ember` starts.");
  });
});

describe("an interrupted first download (install-docs-c2-1)", () => {
  /** A release served slowly enough to stop part way: 4 MB, 64 KB every 40 ms. */
  async function slowRelease(version: string) {
    const r = release(version, 4 * 1024 * 1024);
    let slow = true;
    const server = http.createServer((req, res) => {
      const body = r.files[decodeURIComponent(req.url ?? "")];
      if (body === undefined) { res.statusCode = 404; res.end(); return; }
      const buf = Buffer.from(body);
      res.setHeader("content-length", buf.length);
      if (!slow) { res.end(buf); return; }
      let at = 0;
      const tick = setInterval(() => {
        if (at >= buf.length) { clearInterval(tick); res.end(); return; }
        res.write(buf.subarray(at, at += 65_536));
      }, 40);
      res.on("close", () => clearInterval(tick));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return { ...r, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, fast: () => { slow = false; }, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
  }
  /** Waits until the launcher's half-made download has some bytes in it. */
  async function partWay(cache: string, asset: string) {
    for (let i = 0; i < 200; i++) {
      for (const entry of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
        const f = path.join(cache, entry, asset);
        if (fs.existsSync(f) && fs.statSync(f).size > 0) return f;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("the download never started");
  }

  // Signals are POSIX's: Windows ends a child at once whatever it is sent.
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("leaves no lock or half-made download when Ctrl+C stops it, so the next run downloads again (install-docs-c2-1)", async () => {
    const v = packageVersion();
    const server = await slowRelease(v);
    const cache = tempDir();
    try {
      const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: cache, EMBER_NPM_QUIET: "1", ...noNpmrc };
      const run = runLauncher(["--npm-install-only"], env);
      await partWay(cache, server.asset);
      run.child.kill("SIGINT");
      const ended = await run.ended;
      expect(ended).toEqual({ code: 130, signal: null });
      expect(run.err()).toBe(`ember-copilot: Stopped before Ember ${v} was installed, and nothing was kept. Run 'ember' again to download it.\n`);
      expect(fs.readdirSync(cache)).toEqual([]);
      server.fast();
      const again = runLauncher(["--npm-install-only"], env);
      expect((await again.ended).code).toBe(0);
      // (Compared as bytes: a deep comparison of 4 MB takes vitest many seconds.)
      expect(fs.readFileSync(again.out().trim()).equals(server.body)).toBe(true);
    } finally {
      await server.close();
    }
  }, 30_000);

  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("takes over the lock of a download that was killed outright, instead of refusing every later run (install-docs-c2-1)", async () => {
    const v = packageVersion();
    const server = await slowRelease(v);
    const cache = tempDir();
    try {
      const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: cache, EMBER_NPM_QUIET: "1", ...noNpmrc };
      const run = runLauncher(["--npm-install-only"], env);
      await partWay(cache, server.asset);
      // A kill nothing can catch (the computer's own out-of-memory killer, a crash): the lock stays, naming it.
      run.child.kill("SIGKILL");
      await run.ended;
      expect(fs.readFileSync(path.join(cache, `.${v}-install-lock`, "owner"), "utf8")).toBe(`${run.child.pid} ${os.hostname()}\n`);
      server.fast();
      const again = runLauncher(["--npm-install-only"], env);
      const ended = await again.ended;
      expect(again.err()).not.toContain("already downloading");
      expect(ended.code).toBe(0);
      expect(fs.readdirSync(cache)).toEqual([v]);
    } finally {
      await server.close();
    }
  }, 30_000);
});

/** What the launcher writes to stdout and stderr while `fn` runs. */
async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  let out = "", err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as never);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { err += String(chunk); return true; }) as never);
  try {
    return { result: await fn(), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

/** A stand-in Ember: a Node script run with this Node, so the cases run on every OS. */
function fakeEmber(body: string) {
  const file = path.join(tempDir(), "ember.cjs");
  fs.writeFileSync(file, body);
  return { file: process.execPath, args: [file] };
}
/** A stream that keeps what is written to it. */
function sink() {
  let text = "";
  const stream = new Writable({ write(chunk, _enc, done) { text += String(chunk); done(); } });
  return { stream, text: () => text };
}

describe("starting Ember from the launcher", () => {
  it("runs the setup check attached, so its report and exit code reach the person (install-docs-3)", async () => {
    // `ember --doctor` and `ember doctor` both mean the check-up, passed on as --doctor (AppRun and Ember.exe take it).
    expect(runMode(["--doctor"])).toEqual({ attached: true, args: ["--doctor"] });
    expect(runMode(["doctor"])).toEqual({ attached: true, args: ["--doctor"] });
    expect(runMode(["doctor", "--verbose"])).toEqual({ attached: true, args: ["--doctor", "--verbose"] });
    expect(runMode([])).toEqual({ attached: false, args: [] });
    expect(runMode(["--ask"])).toEqual({ attached: false, args: ["--ask"] });
    const out = sink(), err = sink();
    const cmd = fakeEmber('process.stdout.write("Ember 9.9.9 setup check\\n  Display  fails\\n"); process.stderr.write("a warning\\n"); process.exit(3);');
    const code = await start(cmd, { attached: true, stdout: out.stream, stderr: err.stream, log: path.join(tempDir(), "start.log") });
    expect(code).toBe(3);
    expect(out.text()).toBe("Ember 9.9.9 setup check\n  Display  fails\n");
    expect(err.text()).toBe("a warning\n");
  });

  it("says why when Ember stops as it starts, with its exit code, instead of saying it started (install-docs-3)", async () => {
    const out = sink(), err = sink();
    const cmd = fakeEmber('process.stderr.write("Ember needs your desktop session (no display here).\\n"); process.exit(1);');
    const code = await start(cmd, { attached: false, stdout: out.stream, stderr: err.stream, log: path.join(tempDir(), "start.log"), earlyMs: 10_000 });
    expect(code).toBe(1);
    expect(err.text()).toContain("Ember needs your desktop session (no display here).");
    expect(err.text()).not.toContain("started Ember");
  });

  it("leaves a running Ember to itself after a moment and returns 0 (install-docs-3)", async () => {
    const out = sink(), err = sink();
    const log = path.join(tempDir(), "start.log");
    const cmd = fakeEmber('process.stderr.write("still starting\\n"); setTimeout(() => {}, 30_000);');
    const at = Date.now();
    const code = await start(cmd, { attached: false, stdout: out.stream, stderr: err.stream, log, earlyMs: 1500 });
    expect(code).toBe(0);
    expect(Date.now() - at).toBeGreaterThanOrEqual(1400);
    // What it said went to the start log, not the terminal; the pid there is the running stand-in, stopped here.
    expect(err.text()).toBe("");
    const pid = Number(/^pid (\d+)$/m.exec(fs.readFileSync(log, "utf8"))?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    process.kill(pid);
    expect(fs.readFileSync(log, "utf8")).toContain("still starting");
  });
});

describe("the launcher's own answers", () => {
  it("prints its usage for --help or -h, in the name it was run by, and downloads or starts nothing (install-docs-3)", async () => {
    // Through npm the AppImage, Ember.exe and Ember.app have no --help of their own: Ember would start instead.
    const text = usage("ember");
    expect(text).toMatch(/^ember-copilot starts Ember/);
    expect(text).toContain("usage: ember [doctor | --show-settings | --ask]");
    for (const w of ["  ember doctor", "  ember --show-settings", "  ember --ask", "--npm-install-only", "--npm-where", "EMBER_NPM_DOWNLOAD_BASE"]) expect(text, w).toContain(w);
    // No shortcut: another app may hold Ctrl+Alt+E, and then Ember holds its fallback (install-docs-r2-3).
    expect(text).toContain("start Ember (it stays beside your cursor; run it again for its settings)");
    expect(text).not.toMatch(/Ctrl\+|Alt\+/);
    expect(invokedAs("/usr/local/bin/ember", {})).toBe("ember");
    expect(invokedAs("/usr/local/bin/ember-copilot", {})).toBe("ember-copilot");
    expect(invokedAs("C:\\Users\\k\\AppData\\Roaming\\npm\\node_modules\\ember-copilot\\bin\\ember.mjs", {})).toBe("ember");
    expect(invokedAs("/home/k/.npm/_npx/1a/node_modules/.bin/ember-copilot", { npm_command: "exec" })).toBe("npx ember-copilot");
    const cache = tempDir();
    for (const flag of ["--help", "-h", "--npm-help"]) {
      const r = await captured(() => main([flag], { env: { EMBER_NPM_CACHE: cache, EMBER_NPM_DOWNLOAD_BASE: "http://127.0.0.1:9" } }));
      expect(r.result, flag).toBe(0);
      expect(r.out, flag).toContain("usage: ");
    }
    expect(fs.readdirSync(cache)).toEqual([]);
  });

  it("says to start it inside the desktop, or to run its setup check, when Linux has no display, before downloading (install-docs-3)", async () => {
    // The AppImage's own words name its file in the cache, which an npm user can't run by that name.
    const said = "Ember needs your desktop session (no display here). Run 'ember' from a terminal inside GNOME, or run 'ember doctor' to check this computer.";
    expect(noDisplay("linux", {}, "ember")).toBe(said);
    expect(noDisplay("linux", {}, "npx ember-copilot")).toContain("or run 'npx ember-copilot doctor'");
    expect(noDisplay("linux", { DISPLAY: ":0" }, "ember")).toBeNull();
    for (const os of ["win32", "darwin"]) expect(noDisplay(os, {}, "ember"), os).toBeNull();
    const cache = tempDir();
    for (const args of [[], ["--ask"]]) {
      const r = await captured(() => main(args, { platform: "linux", env: { EMBER_NPM_CACHE: cache, EMBER_NPM_DOWNLOAD_BASE: "http://127.0.0.1:9" } }));
      expect(r.result).toBe(1);
      expect(r.err).toBe(`ember-copilot: ${said}\n`);
    }
    expect(fs.readdirSync(cache)).toEqual([]);
  });
});

describe("updating through npm", () => {
  it("keeps only the newest version in the cache once it is installed, leaving what it can't be sure of (install-docs-10)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    // Two releases on a local server, each a stand-in AppImage with its SHA256SUMS.
    const files: Record<string, string> = {};
    for (const v of ["0.1.1", "0.1.2"]) {
      const asset = `Ember-${v}-x86_64.AppImage`, body = `#!/bin/sh\necho ${v}\n`;
      files[`/v${v}/${asset}`] = body;
      files[`/v${v}/SHA256SUMS`] = `${createHash("sha256").update(body).digest("hex")}  ${asset}\n`;
    }
    const server = await serve(files);
    const cache = tempDir();
    try {
      const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: cache };
      for (const v of ["0.1.1", "0.1.2"]) await ensureInstalled({ version: v, platform: "linux", arch: "x64", env });
    } finally {
      await server.close();
    }
    fs.writeFileSync(path.join(cache, ".0.1.1-start.log"), "pid 1\n");
    // Not Ember's to remove: a folder that isn't a complete install, another version's installer at work, a version
    // still running (its folder is in a running program's command line), and anything that isn't a version.
    fs.mkdirSync(path.join(cache, "0.0.9"));
    for (const v of ["0.0.7", "0.0.8"]) { fs.mkdirSync(path.join(cache, v)); fs.writeFileSync(path.join(cache, v, ".ember-npm-complete"), "x\n"); }
    fs.mkdirSync(path.join(cache, ".0.0.7-install-lock"));
    fs.mkdirSync(path.join(cache, "notes"));
    const removed = pruneVersions({ parent: cache, keep: "0.1.2", running: () => `/bin/sh ${path.join(cache, "0.0.8", "Ember-0.0.8-x86_64.AppImage")}\n` });
    expect(removed).toEqual(["0.1.1"]);
    expect(fs.readdirSync(cache).sort()).toEqual([".0.0.7-install-lock", "0.0.7", "0.0.8", "0.0.9", "0.1.2", "notes"]);
    // The kept version is untouched, and a failure to look at what runs keeps everything.
    expect(fs.existsSync(path.join(cache, "0.1.2", "Ember-0.1.2-x86_64.AppImage"))).toBe(true);
    expect(pruneVersions({ parent: cache, keep: "0.1.2", running: () => { throw new Error("no ps"); } })).toEqual([]);
    expect(fs.existsSync(path.join(cache, "0.0.8"))).toBe(true);
  });

  // The stand-in AppImage is a shell script, which this needs to run as the launcher runs the real one.
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("removes an older version only once the new one has started, never for the setup check, so Start at login keeps working (install-docs-10)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    const v = packageVersion(), old = "0.0.1";
    const files: Record<string, string> = {};
    for (const ver of [old, v]) {
      const asset = `Ember-${ver}-x86_64.AppImage`;
      const body = `#!/bin/sh\nif [ "$1" = --doctor ]; then echo "setup check ${ver}"; exit 0; fi\nexec sleep 30\n`;
      files[`/v${ver}/${asset}`] = body;
      files[`/v${ver}/SHA256SUMS`] = `${createHash("sha256").update(body).digest("hex")}  ${asset}\n`;
    }
    const server = await serve(files);
    const cache = tempDir();
    const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: cache, DISPLAY: ":99" };
    try {
      await ensureInstalled({ version: old, platform: "linux", arch: "x64", env });
      // The first command after `npm i -g ember-copilot@latest` is the setup check: it installs the new version, and
      // the login entry, which only a running Ember moves, still points at the old one, so that one stays.
      const doctor = await captured(() => main(["doctor"], { platform: "linux", env }));
      expect(doctor.result).toBe(0);
      expect(doctor.out).toContain(`setup check ${v}`);
      expect(fs.existsSync(path.join(cache, v, ".ember-npm-complete"))).toBe(true);
      expect(fs.existsSync(path.join(cache, old))).toBe(true);
      expect((await captured(() => main(["--npm-install-only"], { platform: "linux", env }))).result).toBe(0);
      expect(fs.existsSync(path.join(cache, old))).toBe(true);
      // The new version started and kept running: now the old one goes.
      expect((await captured(() => main([], { platform: "linux", env, earlyMs: 300 }))).result).toBe(0);
      expect(fs.existsSync(path.join(cache, old))).toBe(false);
      expect(fs.existsSync(path.join(cache, v, `Ember-${v}-x86_64.AppImage`))).toBe(true);
    } finally {
      const log = path.join(cache, `.${v}-start.log`);
      const pid = fs.existsSync(log) ? Number(/^pid (\d+)$/m.exec(fs.readFileSync(log, "utf8"))?.[1]) : 0;
      if (pid > 0) try { process.kill(pid); } catch { /* already gone */ }
      await server.close();
    }
  });

  // The stand-in AppImages are shell scripts, which this needs to run as the launcher runs the real ones.
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("says an older Ember still running took the start, and removes nothing, instead of saying the new one started (install-docs-c2-3)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "");
    const v = packageVersion(), old = "0.0.1", other = "0.0.2";
    const files: Record<string, string> = {};
    // The older one keeps running; the new one finds it running and hands over, exiting 0 at once, as Ember does.
    const bodies: Record<string, string> = { [old]: "#!/bin/sh\nwhile :; do sleep 1; done\n", [other]: "#!/bin/sh\nexit 0\n", [v]: "#!/bin/sh\nexit 0\n" };
    for (const [ver, body] of Object.entries(bodies)) {
      const asset = `Ember-${ver}-x86_64.AppImage`;
      files[`/v${ver}/${asset}`] = body;
      files[`/v${ver}/SHA256SUMS`] = `${createHash("sha256").update(body).digest("hex")}  ${asset}\n`;
    }
    const server = await serve(files);
    const cache = tempDir();
    const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: cache, DISPLAY: ":99", EMBER_NPM_QUIET: "1", ...noNpmrc };
    let running: ReturnType<typeof spawn> | null = null;
    try {
      for (const ver of [old, other]) await ensureInstalled({ version: ver, platform: "linux", arch: "x64", env });
      running = spawn(path.join(cache, old, `Ember-${old}-x86_64.AppImage`), [], { stdio: "ignore" });
      await new Promise(resolve => setTimeout(resolve, 200));
      const r = await captured(() => main([], { platform: "linux", env: { ...env, EMBER_NPM_QUIET: "" }, earlyMs: 1500 }));
      expect(r.result).toBe(0);
      expect(r.err).toContain(`ember-copilot: Ember ${old} is already running, so it took this instead of starting ${v}. To start ${v}, quit Ember, then run 'ember' again.\n`);
      expect(r.err).not.toContain("started Ember");
      // Start at login still points at the one running: nothing is removed until the new one has started.
      expect(fs.existsSync(path.join(cache, other, ".ember-npm-complete"))).toBe(true);
      expect(fs.existsSync(path.join(cache, old, ".ember-npm-complete"))).toBe(true);
    } finally {
      running?.kill();
      await server.close();
    }
    // Where the running one can't be named (Windows has no ps here; an Ember from outside the cache), it says so too.
    expect(handedOver("0.1.2", null, "npx ember-copilot")).toBe("Ember was already running, so it took this. If it is older than 0.1.2, quit Ember, then run 'npx ember-copilot' again to start 0.1.2.");
    const own = read("packages/npm/README.md").replace(/\s+/g, " ");
    expect(own).toContain("If an older Ember is still running, the new one hands what you asked over to it instead of starting");
  });

  it("gives update steps, and uninstall steps in an order that works (install-docs-10)", () => {
    const own = read("packages/npm/README.md").replace(/\s+/g, " ");
    const update = own.split("## Update")[1]?.split("## ")[0] ?? "";
    expect(update).toContain("`npm i -g ember-copilot@latest`");
    expect(update).toMatch(/[Qq]uit Ember/);
    // Older versions go only once the new one has started (it then moves the login entry): not for the setup check.
    expect(update).toContain("once the new version has started");
    expect(update).toContain("`ember doctor` and `--npm-install-only` remove nothing");
    const uninstall = own.split("## Uninstall")[1]?.split("## ")[0] ?? "";
    // The cache folder before `npm rm -g`, which takes `ember --npm-where` with it.
    const where = uninstall.indexOf("ember --npm-where"), rm = uninstall.indexOf("npm rm -g ember-copilot");
    expect(where).toBeGreaterThan(-1);
    expect(rm).toBeGreaterThan(where);
    for (const dir of ["%LOCALAPPDATA%\\ember-npm", "~/Library/Caches/ember-npm", "~/.cache/ember-npm"]) expect(uninstall, dir).toContain(dir);
    expect(uninstall).toContain("**Start Ember when I log in**");
    for (const dir of ["~/.config/ember", "%LOCALAPPDATA%\\ember", "~/Library/Application Support/ember"]) expect(uninstall, dir).toContain(dir);
    // What a packaged Ember leaves outside both folders, as README's own uninstall steps name it: Windows' Start menu
    // shortcut (written by every packaged Ember, the npm cache's included), a Mac's permission lists, the desk's folder.
    expect(read("app/main/platform/win32/system/lifecycle.ts")).toContain('const file = path.win32.join(dir, "Ember.lnk");');
    for (const w of ["`Ember.lnk` in `%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs`", "**System Settings › Privacy & Security** list it is on", "`~/Ember`"]) expect(uninstall, w).toContain(w);
    // A Mac's setup check warns about any copy outside Applications, the cache's included (environment.ts).
    expect(read("app/main/environment.ts")).toContain("Ember isn't in the Applications folder, so its permissions and login item may not stick.");
    expect(own).toMatch(/setup check warns that Ember isn't in the Applications folder/);
  });
});

describe("packages/npm/package.json", () => {
  it("has the app's version, so it downloads the release it was published with", () => {
    expect(launcher.version).toBe(root.version);
    expect(packageVersion()).toBe(root.version);
  });
  it("is the ember-copilot package with both commands, no dependencies, and the repository provenance needs", () => {
    expect(launcher.name).toBe("ember-copilot");
    expect(launcher.bin).toEqual({ ember: "bin/ember.mjs", "ember-copilot": "bin/ember.mjs" });
    expect(launcher.dependencies).toBeUndefined();
    expect(launcher.private).toBeUndefined();
    expect(launcher.repository.url).toBe(`git+https://github.com/${REPO}.git`);
    expect(launcher.repository.directory).toBe("packages/npm");
    expect(read("packages/npm/bin/ember.mjs")).toMatch(/^#!\/usr\/bin\/env node\n/);
    // The app itself is never published to npm.
    expect(root.private).toBe(true);
  });
  it("imports only Node built-ins", () => {
    const src = read("packages/npm/lib/launcher.mjs") + read("packages/npm/bin/ember.mjs");
    const specs = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s, s).toMatch(/^(node:|\.\.\/lib\/)/);
  });
});

describe(".github/workflows/npm.yml", () => {
  const wf = read(".github/workflows/npm.yml");
  it("runs after ci on a v* tag push that passed, or by hand for an existing release", () => {
    expect(wf).toMatch(/workflow_run:\n {4}workflows: \[ci\]\n {4}types: \[completed\]/);
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).toContain("github.event.workflow_run.event == 'push' && github.event.workflow_run.conclusion == 'success'");
    expect(wf).toContain("startsWith(github.event.workflow_run.head_branch, 'v')");
    expect(read(".github/workflows/ci.yml")).toMatch(/^name: ci$/m);
  });
  it("can't write to the repository, and may mint an OIDC token for trusted publishing and provenance", () => {
    expect(wf).not.toMatch(/contents: write/);
    expect(wf).toMatch(/permissions:\n {6}contents: read\n {6}id-token: write/);
    expect(wf).toMatch(/npm install -g npm@(\d+)\.(\d+)/);
    const [, major, minor] = /npm install -g npm@(\d+)\.(\d+)/.exec(wf)!.map(Number);
    expect(major * 100 + minor).toBeGreaterThanOrEqual(1105);
  });
  it("checks the version against the tag and the release's files before publishing, and skips without credentials", () => {
    const at = (s: string) => { const i = wf.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    expect(at("isn't the tag's") < at("gh release view") && at("gh release view") < at("npm publish --access public --provenance")).toBe(true);
    expect(wf).toContain("secrets.NPM_TOKEN");
    expect(wf).toMatch(/if \[ -z "\$NPM_TOKEN" \]; then\n\s+echo "::warning::[^\n]*"\n\s+exit 0/);
  });
});
