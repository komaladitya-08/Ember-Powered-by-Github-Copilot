/**
 * The vault's leak test on the real things (owner decision of 2026-11-12; PLAN.md §2 "Approvals", "The vault"; the
 * slice's decision 7). Two journeys, each filling canary values and then looking for them everywhere:
 *
 * 1. On the real Copilot runtime, with the scripted model and the pretend app that repeats everything it is given
 *    (test/fixtures/vault/): a worker's whole task fills every kind of entry, by accessibility and as keys. The
 *    canaries must be in nothing the model was sent (its own record of every request: system message, prompts, tool
 *    results), the task's result, the audit log, the logs at debug level, settings.json, the runtime's own session
 *    files, every other file in the data folder, Home's answers, the announcements and the clipboard, and every
 *    filled field must be black in every picture. Runs anywhere (no desktop needed).
 * 2. Against real windows, through the real accessibility helper and X11. An Electron page with a sign-in form,
 *    served over http so it has a site: its site is read from the document itself, and the helper's own fill is
 *    refused in fixed words, since Chromium's fields take no text by accessibility on Linux (the worker types keys
 *    under the borrow there), and nothing reaches the page. A GTK sign-in window (test/fixtures/gtk3_signin.py),
 *    whose fields do: the helper's own fill, then a real read and a real screenshot, the helper's command line and
 *    environment, its log lines and the clipboard. Needs an X11 display with an accessibility bus and a Python with
 *    pyatspi and GTK 3; skipped otherwise (EMBER_ATSPI_TEST=1, CI's `el8` job, requires them).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { AtspiSidecar, VAULT_FILL_UNAVAILABLE, pickPython } from "../../app/main/perception/sidecar";
import { Perception } from "../../app/main/perception";
import { openX11, type X11 } from "../../app/main/x11";
import { createLogger } from "../../app/main/logger";
import { redactingClient } from "../../app/main/agent/redacting-client";
import { VAULT_REDACTED, VaultRedactor } from "../../app/main/vault/redact";
import { VaultService } from "../../app/main/vault/service";
import { VAULT_FILE, VaultStore } from "../../app/main/vault/store";
import type { OS } from "../../app/shared/shortcuts";
import { leakyEmber } from "../fixtures/vault/ember";
import { CANARY, FIELDS, REFRESH, TYPED_FIELD, box, canariesIn, fieldBounds, filesUnder } from "../fixtures/vault/leaky";

type Msg = { role: string; content: unknown };
type Reply = { text?: string; tool?: { name: string; args: Record<string, unknown> } };
const steps = (messages: Msg[]) => messages.filter(m => m.role === "tool").length;
/** A request's messages as text, without any picture's bytes (pixels are checked as pixels). */
const withoutPixels = (v: unknown) => JSON.stringify(v).replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, "(pixels)");

describe("the canary test on the real runtime (vault-3)", () => {
  const { id: runtimeId, exe } = runtimeFor(process.platform as OS, process.arch);
  let mock: { baseUrl: string; requests: { messages: Msg[]; descriptions: Record<string, string> }[]; close(): Promise<void> };
  let client: CopilotClient;
  let dir: string;

  /** What the scripted model does, step by step: it only ever names fields and what they need. */
  const SCRIPT: Reply["tool"][] = [
    { name: "perceive_window", args: { image: true } },
    ...FIELDS.map(f => ({ name: "fill_from_vault", args: { id: f.id, what: f.what } })),
    { name: "perceive_window", args: { image: true } },
    { name: "click", args: { id: REFRESH } },
    { name: "list_windows", args: {} },
    { name: "perceive_window", args: { image: true } },
    { name: "report_progress", args: { text: "Filled the checkout." } },
    { name: "finish_task", args: { success: true, summary: "Signed in and filled in the checkout." } },
  ];

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 2, respond: (messages: Msg[]): Reply => { const tool = SCRIPT[steps(messages)]; return tool ? { tool } : { text: "Done." }; } });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-vault-leak-"));
    client = new CopilotClient({
      mode: "empty", baseDirectory: path.join(dir, "copilot"), useLoggedInUser: false,
      connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId, exe }).path }),
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    });
    await client.start();
  }, 60_000);

  afterAll(async () => {
    await client?.stop();
    await mock?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the runtime client's own calls as they are behind the redactor (as AgentHost uses it)", async () => {
    const wrapped = redactingClient(client, new VaultRedactor());
    expect((await wrapped.ping("ember")).message).toContain("ember");
    expect(Array.isArray(await wrapped.listSessions())).toBe(true);
  });

  it("fills every kind of entry in a whole task, and no canary is in anything the model was sent or Ember wrote", async () => {
    const e = await leakyEmber({ dir, client, deps: { provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" } } as never });
    const result = await e.worker.run(new AbortController().signal);
    // The runtime's own files for the session, while it still has them.
    const during = filesUnder(dir);
    await e.worker.dispose();
    expect(result).toMatchObject({ success: true, summary: "Signed in and filled in the checkout." });

    // Everything was really filled: the app holds every value, one of them typed as keys; the form was asked once.
    expect(Object.fromEntries(e.app.held)).toEqual(Object.fromEntries(FIELDS.map(f => [f.id, f.value])));
    expect([...e.app.how].filter(([, how]) => how === "keys").map(([id]) => id)).toEqual([TYPED_FIELD]);
    expect(e.forms).toEqual([{ kind: "login", where: "shop.example" }]);
    expect(e.app.state.title).toContain(CANARY.contact.email);

    // The model's own record of everything it was sent.
    expect(mock.requests.length).toBeGreaterThanOrEqual(SCRIPT.length);
    const sent = withoutPixels(mock.requests.map(r => [r.messages, r.descriptions]));
    expect(canariesIn(sent)).toEqual([]);
    for (const r of mock.requests) for (const m of r.messages) expect(canariesIn(withoutPixels(m)), withoutPixels(m).slice(0, 400)).toEqual([]);
    // The app's words did reach it, with the values taken out, and it was told of each fill only that it happened.
    expect(sent).toContain(VAULT_REDACTED);
    expect(sent.match(/Filled from the vault\./g)?.length).toBeGreaterThanOrEqual(FIELDS.length);
    // What the task hands back for the conductor, the announcements and the card.
    expect(canariesIn(JSON.stringify([result, e.said, e.activity, e.progress, e.home()]))).toEqual([]);
    expect(e.said).toContain("Filling a saved card number in Firefox, from the vault: Autopilot is on.");

    // Pictures: two were taken (before the fills, and after them); the window whose title says the email got none.
    expect(e.pictures.map(p => !!p.capture)).toEqual([true, true, false]);
    const picture = e.pictures[1].capture!;
    const { data, info } = await sharp(picture.data).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(Math.round((y - picture.rect.y) * picture.scale) * info.width + Math.round((x - picture.rect.x) * picture.scale)) * info.channels];
    for (const f of FIELDS) { const b = fieldBounds(f.id); expect(at(b.x + b.width / 2, b.y + b.height / 2), f.what).toBeLessThan(40); }
    expect(at(600, 130)).toBeLessThan(40); // the line that repeats everything
    expect(at(600, 275)).toBeLessThan(40); // the link named after the email
    expect(at(700, 500)).toBeGreaterThan(150);

    // Everything on disk: the audit log, the logs at debug level, settings.json, the vault's file, the runtime's own files.
    const files = [...during, ...filesUnder(dir)];
    const tops = new Set(files.map(f => f.file.split(path.sep)[0]));
    expect(during.some(f => f.file.startsWith("copilot"))).toBe(true);
    for (const top of ["audit", "logs", "vault.json"]) expect(tops, top).toContain(top);
    for (const f of files) expect(canariesIn(f.text), f.file).toEqual([]);
    const audited = files.filter(f => f.file.startsWith("audit")).flatMap(f => f.text.split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>));
    expect(audited.filter(a => a.event === "action" && a.kind === "vault_fill" && a.ok === true).length).toBeGreaterThanOrEqual(FIELDS.length);
    expect(e.app.state.clipboard).toBe(0);
  }, 120_000);
});

const python = pickPython();

// What a failed page_address needs next time (CI's el8 job alone has the real thing): the chain from the first entry
// up to its application by role, and each web document's states, its Document interface's attributes (by both
// calls) and its object attributes. Values only for the names an address, a type or a title go by; a length for any
// other value, which could hold something secret.
const DOCUMENTS = String.raw`
import sys, pyatspi
SAFE = ("DocURL", "URI", "MimeType", "DocType", "W3C-doctype", "Title", "tag", "xml-roles", "display")
def pairs(items):
    out = []
    for item in items or []:
        k, _, v = str(item).partition(":")
        out.append(k + "=" + (repr(v) if k in SAFE else "<%d chars>" % len(v)))
    return out
def walk(acc, depth, found):
    if acc is None or depth > 60 or len(found["docs"]) > 5:
        return
    role = acc.getRoleName()
    if role == "entry" and found["entry"] is None:
        found["entry"] = acc
    if role in ("document web", "document frame"):
        found["docs"].append(acc)
    for i in range(min(acc.childCount, 200)):
        try:
            walk(acc.getChildAtIndex(i), depth + 1, found)
        except Exception as err:
            found["errors"].append(type(err).__name__)
desk = pyatspi.Registry.getDesktop(0)
apps = [a for a in desk if a is not None and a.get_process_id() == int(sys.argv[1])]
print("apps with the pid: %d" % len(apps))
found = {"entry": None, "docs": [], "errors": []}
for a in apps:
    walk(a, 0, found)
chain, cur = [], found["entry"]
while cur is not None and len(chain) < 80:
    chain.append(cur.getRoleName())
    cur = cur.parent
print("entry up: " + " > ".join(chain))
for d in found["docs"]:
    print("document: role=%s states=%s" % (d.getRoleName(), sorted(pyatspi.stateToString(s) for s in d.getState().getStates())))
    try:
        doc = d.queryDocument()
        print("  getAttributeValue: " + ", ".join("%s=%r" % (k, doc.getAttributeValue(k)) for k in ("DocURL", "URI", "MimeType", "DocType")))
        print("  getAttributes: " + ", ".join(pairs(doc.getAttributes())))
    except Exception as err:
        print("  no Document interface: " + type(err).__name__)
    try:
        print("  object attributes: " + ", ".join(pairs(d.getAttributes())))
    except Exception as err:
        print("  object attributes: " + type(err).__name__)
print("walk errors: %s" % found["errors"][:5])
`;
function documentsOf(pid: number): string {
  const r = spawnSync(python, ["-c", DOCUMENTS, String(pid)], { encoding: "utf8", timeout: 15_000 });
  return `the documents around the entry, as pyatspi reads them:\n${r.stdout}${r.stderr ? `\n${r.stderr.slice(-2000)}` : ""}`;
}
const available = !!process.env.DISPLAY && spawnSync(python, ["-c", "import pyatspi, gi"], { stdio: "ignore" }).status === 0;
const required = process.env.EMBER_ATSPI_TEST === "1";

// The values show in green (in the field and in the line that repeats the user name): none of it may be left in a picture.
const SIGN_IN_PAGE = `<!doctype html><title>Ember test: Vault</title><body style="font:14px sans-serif">
<h1 style="font-size:16px">Sign in</h1>
<div><label>Username <input id=u style="font:16px monospace;width:320px;color:#00b000"></label></div>
<div><label>Password <input id=p type=password style="font:16px monospace;width:320px;color:#00b000"></label></div>
<p id=echo style="font:16px monospace;color:#00b000"></p>
<p id=out>nothing yet</p>
<script>setInterval(() => { echo.textContent = u.value ? "Hello " + u.value : ""; out.textContent = "got " + u.value.length + " and " + p.value.length + " characters"; }, 100);</script></body>`;
const MAIN = `
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("force-renderer-accessibility");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 560, height: 360, x: 40, y: 40, title: "Ember test: Vault" });
  w.loadURL(process.env.EMBER_TEST_URL);
  w.on("page-title-updated", e => e.preventDefault());
});
`;

describe.skipIf(!available && !required)("the canary test against a real window, through the real helper (vault-3)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-vault-window-"));
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const redactor = new VaultRedactor();
  const log = createLogger({ dir: path.join(dir, "logs"), level: "debug", redact: text => redactor.text(text) });
  let server: http.Server;
  let origin = "";
  let app: ChildProcess;
  let gtk: ChildProcess;
  let sidecar: AtspiSidecar;
  let x11: X11;
  let perception: Perception;
  let service: VaultService;
  let pid = 0;
  let gtkPid = 0;

  const windowPid = async (name: string): Promise<number> => {
    for (let i = 0; i < 100; i++) {
      const { windows } = await sidecar.listWindows().catch(() => ({ windows: [] }));
      const found = windows.find(w => w.name === name && w.pid != null)?.pid;
      if (found) return found;
      await new Promise(r => setTimeout(r, 200));
    }
    return 0;
  };
  // The window may still be handing itself over: read until both fields are there.
  const fieldsOf = async (target: number) => {
    let seen = await perception.read({ pid: target });
    for (let i = 0; i < 40 && seen.nodes.filter(n => n.role === "entry" || n.role === "password text").length < 2; i++) {
      await new Promise(r => setTimeout(r, 250));
      seen = await perception.read({ pid: target });
    }
    const user = seen.nodes.find(n => n.role === "entry")!;
    const password = seen.nodes.find(n => n.role === "password text")!;
    expect(user, JSON.stringify(seen.nodes.map(n => [n.role, n.name]))).toBeDefined();
    expect(password).toBeDefined();
    return { user, password };
  };

  beforeAll(async () => {
    server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(SIGN_IN_PAGE); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fs.mkdirSync(path.join(dir, "app"));
    fs.writeFileSync(path.join(dir, "app", "package.json"), JSON.stringify({ name: "ember-vault-test", main: "main.js" }));
    fs.writeFileSync(path.join(dir, "app", "main.js"), MAIN);
    // Chromium joins the accessibility bus only when asked (as perception-electron.test.ts).
    app = spawn(electron, ["--no-sandbox", path.join(dir, "app")], { stdio: "ignore", env: { ...process.env, ACCESSIBILITY_ENABLED: "1", EMBER_TEST_URL: `${origin}/signin`, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" } });
    gtk = spawn(python, [path.resolve("test/fixtures/gtk3_signin.py")], { stdio: "ignore" });
    x11 = openX11()!;
    sidecar = new AtspiSidecar(path.resolve("sidecar/atspi/ember_atspi.py"), log.child("sidecar"), python);
    perception = new Perception({ sidecar, x11, log: log.child("perception"), neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 4000, height: 4000 }),
      holdsVaultValue: text => redactor.holds(text), vaultShown: () => redactor.shown });
    const store = new VaultStore(path.join(dir, VAULT_FILE), box);
    service = new VaultService({ store, allowed: () => true, consented: () => true, autopilot: () => true, appName: k => k, log: log.child("vault"),
      form: { ask: async () => "cancelled", stop: () => {} }, filling: (part, value) => redactor.note(part, value) });
    pid = await windowPid("Ember test: Vault");
    if (!pid) throw new Error("the Electron sign-in window never appeared on the accessibility bus");
    gtkPid = await windowPid("Ember test: Vault sign-in");
    if (!gtkPid) throw new Error("the GTK sign-in window never appeared on the accessibility bus");
  }, 60_000);

  afterAll(() => {
    sidecar?.stop();
    x11?.close();
    app?.kill();
    gtk?.kill();
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads a real Chromium page's site from the document itself, and its fields refuse the helper's fill, so nothing is written", async () => {
    const { user, password } = await fieldsOf(pid);
    // The site is read from the document itself, and the entry is bound to it.
    const pages = await sidecar.pageAddress(user.id);
    expect(pages[0], pages[0] === `${origin}/signin` ? "" : `${JSON.stringify(pages)}; ${documentsOf(pid)}`).toBe(`${origin}/signin`);
    const dest = { site: origin };
    expect((await service.keep("login", dest, CANARY.login)).ok).toBe(true);
    // Chromium's fields take no text by accessibility on Linux (no EditableText: ax_platform_node_auralinux.cc), so
    // the helper refuses in its fixed words, quoting nothing, and the worker would type keys under the borrow instead.
    for (const [part, node] of [["user", user], ["password", password]] as const) {
      const err = await service.use("login", part, dest, value => sidecar.vaultFill(node.id, value)).then(() => null, (e: unknown) => e);
      expect(err, part).toBeInstanceOf(Error);
      expect((err as Error).message, part).toBe(VAULT_FILL_UNAVAILABLE);
      expect(canariesIn(String((err as Error).stack))).toEqual([]);
    }
    // Nothing reached the page, and nothing Ember reads of it holds a canary.
    let p = await perception.perceive({ image: false, scope: "window", target: { pid } });
    for (let i = 0; i < 20 && !p.text.includes("got 0 and 0 characters"); i++) {
      await new Promise(r => setTimeout(r, 250));
      p = await perception.perceive({ image: false, scope: "window", target: { pid } });
    }
    expect(p.text).toContain("got 0 and 0 characters");
    expect(canariesIn(p.text), p.text).toEqual([]);
    expect(canariesIn(JSON.stringify(p.nodes))).toEqual([]);
    for (const f of filesUnder(dir)) expect(canariesIn(f.text), f.file).toEqual([]);
  }, 60_000);

  it("fills a real sign-in form by the helper's own fill, and no canary is in what Ember reads, captures, logs or hands the helper", async () => {
    const { user, password } = await fieldsOf(gtkPid);
    const dest = { app: "ember-vault-signin" };
    expect((await service.keep("login", dest, CANARY.login)).ok).toBe(true);
    const clip = (args: string[], input?: string) => spawnSync("xclip", ["-selection", "clipboard", ...args], { input, encoding: "utf8", timeout: 5000 });
    const hasClip = clip(["-i"], "ember-clipboard-sentinel").status === 0;

    for (const [part, node] of [["user", user], ["password", password]] as const) {
      const used = await service.use("login", part, dest, value => sidecar.vaultFill(node.id, value));
      expect(used, part).toMatchObject({ ok: true, result: { ok: true } });
      expect(canariesIn(JSON.stringify(used))).toEqual([]);
    }

    // A real read and a real picture afterwards: the window says both fields took every character, and shows the user
    // name again in a line of its own.
    let p = await perception.perceive({ image: true, scope: "window", target: { pid: gtkPid } });
    const took = `got ${CANARY.login.user.length} and ${CANARY.login.password.length} characters`;
    for (let i = 0; i < 20 && !p.text.includes(took); i++) {
      await new Promise(r => setTimeout(r, 250));
      p = await perception.perceive({ image: true, scope: "window", target: { pid: gtkPid } });
    }
    expect(p.text).toContain(took);
    expect(canariesIn(p.text), p.text).toEqual([]);
    expect(canariesIn(JSON.stringify(p.nodes))).toEqual([]);
    expect(p.nodes.filter(n => n.role === "entry" || n.role === "password text").every(n => n.secret)).toBe(true);
    expect(p.capture, p.text).not.toBeNull();
    const { data, info } = await sharp(p.capture!.data).raw().toBuffer({ resolveWithObject: true });
    let green = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i + 1] > 140 && data[i] < 90 && data[i + 2] < 90) green++;
    expect(green).toBeLessThan(5);
    // Ordinary typing into what was filled is refused by the helper itself.
    await expect(sidecar.setText(user.id, "x")).rejects.toThrow();

    // The helper was handed the values on its stdin only.
    const helpers = fs.readdirSync("/proc").filter(d => /^\d+$/.test(d)).flatMap(d => {
      try { const cmd = fs.readFileSync(`/proc/${d}/cmdline`, "latin1"); return cmd.includes("ember_atspi.py") ? [{ cmd, env: fs.readFileSync(`/proc/${d}/environ`, "latin1") }] : []; } catch { return []; }
    });
    expect(helpers.length).toBeGreaterThan(0);
    expect(canariesIn(JSON.stringify(helpers))).toEqual([]);
    // Ember's logs at debug level (the helper's own stderr among them) and every other file it wrote.
    for (const f of filesUnder(dir)) expect(canariesIn(f.text), f.file).toEqual([]);
    // The clipboard is as it was.
    if (hasClip) expect(clip(["-o"]).stdout).toBe("ember-clipboard-sentinel");
  }, 60_000);
});
