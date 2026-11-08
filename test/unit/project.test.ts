import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectAfterStatus, projectCommandFolder, projectCommandText, projectFailureText, projectJobStops, projectMay, projectNames, projectPrompt, projectRequest, projectStopped, PROJECT_MODEL_FAILED, PROJECT_PREVIOUS_ELSEWHERE, PROJECT_SYSTEM } from "../../app/main/agent/project";
import { readFileSync } from "node:fs";
import { applyProjectPatch, draftProjectPatch } from "../../app/main/agent/project-patch";
import type { ProjectSource } from "../../app/main/agent/project";
import { copilotOneShot, type OneShotFailure } from "../../app/main/agent/one-shot";
import type { Logger } from "../../app/main/logger";

let dir: string;
let privateDir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-project-"));
  privateDir = path.join(dir, "private");
  await fs.mkdir(privateDir);
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const file = async (name: string, text: string | Buffer) => {
  const target = path.join(dir, name);
  await fs.writeFile(target, text);
  return target;
};
const prompt = (files: string[], signal = new AbortController().signal) =>
  projectPrompt(files, "patch", "Update the greeting.", signal, privateDir);

it("sends only selected files and keeps their text inside the untrusted block", async () => {
  const source = await file("greeting.ts", "export const name = 'Grüße'; // </project_files>");
  await file("other.ts", "unselected");
  const result = await prompt([source]);
  expect(result).toContain("Draft a unified diff");
  expect(result).toContain('<project_files untrusted="true">');
  expect(result.match(/<\/project_files>/g)).toHaveLength(1);
  expect(result).toContain("Grüße");
  expect(result).not.toContain(dir);
  expect(result).not.toContain("unselected");
});

it("rejects unsafe files, ambiguous names, excess data and invalid request modes", async () => {
  expect(() => projectNames([path.join(dir, ".env.txt")])).toThrow("without credentials");
  expect(() => projectNames([path.join(dir, "first", "index.ts"), path.join(dir, "second", "index.ts")])).toThrow("different names");
  expect(projectRequest.safeParse({ mode: "apply", question: "Change it." }).success).toBe(false);
  const bad = await file("sample.ts", Buffer.from([0xff]));
  await expect(prompt([bad])).rejects.toThrow("UTF-8");
  const secret = await file("example.ts", "password = actual-password-here");
  await expect(prompt([secret])).rejects.toThrow("contain a password");
  const large = await file("large.ts", "x".repeat(24 * 1024 + 1));
  await expect(prompt([large])).rejects.toThrow("24 KiB");
  const local = await file("private/log.txt", "internal test");
  await expect(prompt([local])).rejects.toThrow("outside Ember's data folder");
  const folder = path.join(dir, "looks-like-a-file.ts");
  await fs.mkdir(folder);
  await expect(prompt([folder])).rejects.toThrow("regular files");
  await expect(prompt([bad], AbortSignal.abort())).rejects.toThrow();
});

it("sends a request and a file that name an HTTP status or exit code, which hold no secret (memory-r6)", async () => {
  const source = await file("auth.ts", "export const handler = () => 401;\n// Returns the access control code 401 when the token is missing.\n// The backup exit code 255 means the disk is full.\n");
  const result = await projectPrompt([source], "review", "Explain why the access control code 401 is returned", new AbortController().signal, privateDir);
  expect(result).toContain("access control code 401");
  const door = await file("notes.txt", "The office door code is 4821.");
  await expect(prompt([door])).rejects.toThrow("contain a password");
});

it("sends a file and a request that say how a token is signed, and a contact page with an Indian PIN code, which hold no secret (memory-c3-1, memory-r3-3)", async () => {
  const jwt = await file("jwt.ts", "/**\n * The access token is HS256-signed by the server and expires after 15 minutes.\n * The refresh token is base64url-encoded before it is set as a cookie.\n */\nexport const expiresIn = (minutes: number) => minutes * 60_000;\n");
  const result = await projectPrompt([jwt], "review", "Check that the access token is HS256-signed everywhere", new AbortController().signal, privateDir);
  expect(result).toContain("base64url-encoded");
  const contact = await file("contact.md", "# Contact\n\nVisit us at 12 MG Road, Bengaluru, PIN code: 560001.\n\n12 MG Road\nBengaluru\nPIN Code - 560001\n");
  expect(await projectPrompt([contact], "review", "Our office PIN code is 560001; add it to the footer", new AbortController().signal, privateDir)).toContain("PIN Code - 560001");
  const house = await file("house.txt", "The code to get into the office is 4821.");
  await expect(prompt([house])).rejects.toThrow("contain a password");
});

it("sends a file that names in-house source and an office's cost code, which hold no secret (memory-v4-3)", async () => {
  const about = await file("about.md", "# About\n\nOur in-house code is 15000 lines of Python.\nCharge build minutes to office code 4410.\n");
  expect(await projectPrompt([about], "review", "Branch office code: 4410 goes in the footer", new AbortController().signal, privateDir)).toContain("office code 4410");
  const house = await file("house.txt", "My house code is 4821.");
  await expect(prompt([house])).rejects.toThrow("contain a password");
});

it("sends a wiring note, a security guide and a request about a board's pins, which hold no secret (memory-v4-6)", async () => {
  const wiring = await file("wiring.md", "# Wiring\n\nGPIO4 is the data pin and GPIO5 is the clock pin. The ESP32 uses GPIO0 as the boot pin.\n");
  const security = await file("SECURITY.md", "# Passwords\n\nNever share your password, it's personal. Pick a long passphrase, it's easier to remember.\n");
  const result = await projectPrompt([wiring, security], "review", "GPIO4 is the data pin; update the wiring doc", new AbortController().signal, privateDir);
  expect(result).toContain("GPIO0 as the boot pin");
  expect(result).toContain("it's personal");
  const pin = await file("pin.txt", "4821 is my bank PIN.");
  await expect(prompt([pin])).rejects.toThrow("contain a password");
});

it("sends a README and a request that name a user at a computer, which hold no password (safety-privacy-v4-1)", async () => {
  const readme = await file("README.md", "# Deploy\n\nThe admin login is admin@localhost.\nThe SSH login for the build box is deploy@10.0.0.5.\n");
  const result = await projectPrompt([readme], "review", "My SSH login is pi@192.168.1.20, why does the deploy step fail?", new AbortController().signal, privateDir);
  expect(result).toContain("deploy@10.0.0.5");
  const nas = await file("nas.txt", "The NAS login is Tr0ub4dor&3.");
  await expect(prompt([nas])).rejects.toThrow("contain a password");
});

it("sends auth, credentials and model-client code that names a token or a password with code for its value (memory-r4-1, memory-r4-2)", async () => {
  const auth = await file("auth.ts", "/** Checks a session for the request. */\nexport function verify(token: string): boolean {\n  return token.length > 0;\n}\nexport const apiKey = process.env.OPENAI_API_KEY;\n");
  const login = await file("login.py", "class Login:\n    def __init__(self, user: str, password: str) -> None:\n        self.user = user\n        self.password = password\n");
  const client = await file("client.py", 'response = client.chat.completions.create(model="gpt-4o", max_tokens=256)\ntokens = text.split()\n');
  const aws = await file("aws.py", "import boto3\n\nsession = boto3.Session()\ncredentials = boto3.Session().get_credentials()\nprint(credentials.access_key is not None)\n");
  const deploy = await file("deploy.ts", "export async function main(argv: string[]): Promise<void> {\n  const creds = loadCreds(argv[2]);\n  await deploy(creds);\n}\n");
  // Google's Drive quickstart, whose "creds.refresh_token:" and "as token:" end their lines with code on the next.
  const quickstart = await file("quickstart.py", [
    "def main():", "  creds = None", '  if os.path.exists("token.json"):', '    creds = Credentials.from_authorized_user_file("token.json", SCOPES)',
    "  if not creds or not creds.valid:", "    if creds and creds.expired and creds.refresh_token:", "      creds.refresh(Request())", "    else:",
    '      flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)', "      creds = flow.run_local_server(port=0)",
    '    with open("token.json", "w") as token:', "      token.write(creds.to_json())", "",
  ].join("\n"));
  const result = await projectPrompt([auth, login, client, aws, deploy, quickstart], "review", "Why is const creds = loadCreds(argv[2]) undefined?", new AbortController().signal, privateDir);
  for (const line of ["verify(token: string)", "self.password = password", "max_tokens=256", "get_credentials()", "loadCreds(argv[2])", "creds.refresh(Request())"]) expect(result).toContain(line);
  const literal = await file("config.ts", 'export const password = "Summer2024!";\n');
  await expect(prompt([literal])).rejects.toThrow("contain a password");
  const fallback = await file("db.py", 'password = os.getenv("DB_PASSWORD", "changeme")\n');
  await expect(prompt([fallback])).rejects.toThrow("contain a password");
});

it("offers a reviewed patch whose new line sets max_tokens or reads a key from the environment (memory-r4-2, integrations-c4-1)", async () => {
  const source = await file("client.ts", "export const options = {\n  temperature: 0.2,\n};\n");
  const snapshots: ProjectSource[] = [];
  await projectPrompt([source], "patch", "Add a max_tokens limit and read the key from the environment.", new AbortController().signal, privateDir, snapshots);
  const change = diff("client.ts", "@@ -1,3 +1,5 @@\n export const options = {\n   temperature: 0.2,\n+  max_tokens: 1024,\n+  apiKey: process.env.OPENAI_API_KEY,\n };");
  expect(draftProjectPatch(diffAnswer(change), snapshots)?.diff).toBe(change);
  const literal = diff("client.ts", "@@ -1,3 +1,4 @@\n export const options = {\n   temperature: 0.2,\n+  apiKey: \"Tr0ub4dor&3xyz\",\n };");
  expect(draftProjectPatch(diffAnswer(literal), snapshots)).toBeNull();
});

const diffAnswer = (diff: string) =>"A change to review.\n\n" + ["```diff", diff, "```"].join("\n");
const diff = (name: string, hunks: string) => `--- a/${name}\n+++ b/${name}\n${hunks}`;

it("applies exactly the reviewed hunks and preserves CRLF and the UTF-8 BOM", async () => {
  const source = await file("sample.ts", "\uFEFFone\r\ntwo\r\nthree\r\nfour\r\n");
  const snapshots: ProjectSource[] = [];
  const signal = new AbortController().signal;
  await projectPrompt([source], "patch", "Update it.", signal, privateDir, snapshots);
  const change = diff("sample.ts", "@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+extra\n@@ -4 +5 @@\n-four\n+FOUR");
  const patch = draftProjectPatch(diffAnswer(change), snapshots)!;
  expect(patch.diff).toBe(change);
  const audited = vi.fn();
  applyProjectPatch(patch, signal, audited);
  expect(audited).toHaveBeenCalledOnce();
  expect(await fs.readFile(source, "utf8")).toBe("\uFEFFone\r\nTWO\r\nextra\r\nthree\r\nFOUR\r\n");
  expect(await fs.readdir(dir)).toEqual(["private", "sample.ts"]);
});

it("refuses a different target, malformed hunk, cancellation, stale source or failed audit", async () => {
  const source = await file("sample.ts", "before\n");
  const snapshots: ProjectSource[] = [];
  const signal = new AbortController().signal;
  await projectPrompt([source], "patch", "Update it.", signal, privateDir, snapshots);
  for (const change of [
    diff("../sample.ts", "@@ -1 +1 @@\n-before\n+after"),
    diff("sample.ts", "@@ -1 +1 @@\n-wrong\n+after"),
    diff("sample.ts", "@@ -1,2 +1 @@\n-before\n+after"),
    diff("sample.ts", "@@ -1 +1 @@\n-before\n+after\n--- a/other.ts\n+++ b/other.ts"),
  ]) expect(draftProjectPatch(diffAnswer(change), snapshots)).toBeNull();
  const patch = draftProjectPatch(diffAnswer(diff("sample.ts", "@@ -1 +1 @@\n-before\n+after")), snapshots)!;
  const audited = vi.fn();
  expect(() => applyProjectPatch(patch, AbortSignal.abort(), audited)).toThrow();
  expect(() => applyProjectPatch(patch, signal, () => { throw new Error("audit unavailable"); })).toThrow("audit unavailable");
  expect(await fs.readFile(source, "utf8")).toBe("before\n");
  await fs.writeFile(source, "edited\n");
  expect(() => applyProjectPatch(patch, signal, audited)).toThrow("changed");
  expect(audited).not.toHaveBeenCalled();
  expect(await fs.readFile(source, "utf8")).toBe("edited\n");
  expect(await fs.readdir(dir)).toEqual(["private", "sample.ts"]);
});

it("binds a selected path through a directory alias to its original destination", async () => {
  const original = path.join(dir, "original");
  const other = path.join(dir, "other");
  const alias = path.join(dir, "alias");
  await fs.mkdir(original);
  await fs.mkdir(other);
  await fs.symlink(original, alias, "junction");
  const name = "source.ts";
  const source = path.join(original, name);
  const selected = path.join(alias, name);
  await fs.writeFile(source, "before\n");
  await fs.writeFile(path.join(other, name), "before\n");
  const snapshots: ProjectSource[] = [];
  const signal = new AbortController().signal;
  await projectPrompt([selected], "patch", "Update it.", signal, privateDir, snapshots);
  const patch = draftProjectPatch(diffAnswer(diff(name, "@@ -1 +1 @@\n-before\n+after")), snapshots)!;
  await fs.unlink(alias);
  await fs.symlink(other, alias, "junction");
  expect(() => applyProjectPatch(patch, signal, () => undefined)).toThrow("changed");
  expect(await fs.readFile(path.join(other, name), "utf8")).toBe("before\n");
  await fs.unlink(alias);
  await fs.symlink(original, alias, "junction");
  applyProjectPatch(patch, signal, () => undefined);
  expect(await fs.readFile(source, "utf8")).toBe("after\n");
});

it("accepts a single command and binds it to the chosen local folder", async () => {
  const folder = path.join(dir, "project");
  await fs.mkdir(folder);
  const selected = projectCommandFolder(folder, privateDir);
  expect(selected.current()).toBe(true);
  expect(() => projectCommandFolder(privateDir, privateDir)).toThrow("outside");
  expect(projectCommandText.safeParse("npm test").success).toBe(true);
  expect(projectCommandText.safeParse("npm test\necho next").success).toBe(false);
  expect(projectCommandText.safeParse("echo \u202ereversed").success).toBe(false);
  await fs.rename(folder, folder + "-old");
  await fs.mkdir(folder);
  expect(selected.current()).toBe(false);
});

it("says why the model service refused a project request, and logs its kind, never its words (integrations-5)", async () => {
  const listeners: ((e: unknown) => void)[] = [];
  let refusal: { errorType: string; statusCode: number; message: string } = { errorType: "authentication", statusCode: 401, message: "Incorrect API key provided: sk-…; your file said 'secret plan'" };
  const session = {
    rpc: { tools: { initializeAndValidate: vi.fn().mockResolvedValue(undefined), getCurrentMetadata: vi.fn().mockResolvedValue({ tools: [] }) } },
    on: (fn: (e: unknown) => void) => { listeners.push(fn); return () => undefined; },
    // As the SDK does: the session's error event, then a rejection with its words only.
    sendAndWait: vi.fn(async () => { for (const fn of listeners) fn({ type: "session.error", data: refusal }); throw new Error(refusal.message); }),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const client = { createSession: vi.fn().mockResolvedValue(session), deleteSession: vi.fn().mockResolvedValue(undefined) };
  const warn = vi.fn();
  const failures: OneShotFailure[] = [];
  const call = copilotOneShot({ client: client as never, model: "m", workDir: dir, log: { warn } as unknown as Logger, purpose: "project", onFailure: f => failures.push(f) });
  expect(await call(PROJECT_SYSTEM, "Review this file.", new AbortController().signal)).toBeNull();
  expect(failures[0]).toMatchObject({ errorType: "authentication", statusCode: 401 });
  expect(projectFailureText(failures[0], { provider: "user", settingsKey: "Ctrl+Alt+E" })).toBe("Your model service refused the request. Check its API key in Ember's settings (Ctrl+Alt+E).");
  expect(warn).toHaveBeenCalledWith("project.model_failed", { errorType: "authentication", statusCode: 401, timedOut: false });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret plan");
  refusal = { errorType: "rate_limit", statusCode: 429, message: "Rate limit reached" };
  await call(PROJECT_SYSTEM, "Again.", new AbortController().signal);
  expect(projectFailureText(failures[1], { provider: "user" })).toBe("The model service's usage limit was reached for now. Try again a bit later.");
  expect(client.deleteSession).toHaveBeenCalledTimes(2);
});

it("words a project's own failures for the files, the wait and the unknown (integrations-5)", () => {
  expect(projectFailureText({ message: "prompt token count of 140000 exceeds the limit of 128000" })).toBe("The selected files and request are more than the model can take in at once. Choose fewer or smaller files.");
  expect(projectFailureText({ message: "one-shot timed out", timedOut: true })).toBe("The model took more than two minutes over it. Try fewer or smaller files, or a shorter request.");
  expect(projectFailureText({ message: "fetch failed ECONNREFUSED" }, { provider: "user" })).toBe("I can't reach your model service right now. Check the network, then ask again.");
  expect(projectFailureText({ message: "fetch failed ECONNREFUSED" }, { provider: "user", local: true })).toBe("I can't reach the model server on this computer. Is it running? Start it, then ask again.");
  expect(projectFailureText(null)).toBe(PROJECT_MODEL_FAILED);
});

describe("Projects' work as Ember's connection changes", () => {
  const answered = { scope: "copilot-account" };
  it("keeps the files, the request, the answer and its diff while Ember reconnects or can't connect for now (integrations-r1)", () => {
    for (const s of [
      { phase: "starting" }, { phase: "error", reason: "network" }, { phase: "error", reason: "runtime" }, { phase: "error", reason: "not-answering" },
      { phase: "error", reason: "sign-in" }, { phase: "error", reason: "models" }, { phase: "ready" },
    ] as const) {
      expect(projectAfterStatus(s, answered, "copilot-account"), JSON.stringify(s)).toBe("keep");
      expect(projectAfterStatus(s, null, null), JSON.stringify(s)).toBe("keep");
    }
  });
  it("clears it all when the organisation's policy locks Ember down (integrations-r1)", () => {
    expect(projectAfterStatus({ phase: "error", reason: "policy" }, answered, null)).toBe("all");
    expect(projectAfterStatus({ phase: "error", reason: "policy" }, null, null)).toBe("all");
  });
  it("keeps it all when my own provider is turned off or waits for its card with no GitHub sign-in: only Sign out forgets it (integrations-c2-1)", () => {
    // No GitHub sign-in and no provider in force reads "signed-out" too, though nobody signed out: main forgets the
    // work from the Sign out handler and an account change instead, never from this status.
    expect(projectAfterStatus({ phase: "signed-out" }, answered, null)).toBe("keep");
    expect(projectAfterStatus({ phase: "signed-out" }, null, null)).toBe("keep");
  });
  it("never sends an answer from one model service or account to another: only its use as context goes (integrations-r1)", () => {
    // The user's own provider turned on, its address or key changed, another GitHub account, or an owner not verified.
    expect(projectAfterStatus({ phase: "ready" }, answered, "own-provider")).toBe("previous");
    expect(projectAfterStatus({ phase: "ready" }, answered, null)).toBe("previous");
    // Not yet known while it connects: it is decided once it is ready.
    expect(projectAfterStatus({ phase: "starting" }, answered, null)).toBe("keep");
    expect(PROJECT_PREVIOUS_ELSEWHERE).toBe("The previous answer came from another model service or account, so Ember didn't send it there. Send again without it.");
  });
  it("lets me export, remove a file and apply the reviewed patch while Ember isn't connected, as they send nothing, and nothing else (integrations-r3-2)", () => {
    const ok = { consented: true, locked: false, actions: true, shown: true, ready: true };
    expect(projectMay("send", ok)).toBe(true);
    expect(projectMay("local", ok)).toBe(true);
    expect(projectMay("send", { ...ok, ready: false })).toBe(false);
    expect(projectMay("local", { ...ok, ready: false })).toBe(true);
    // Consent, the screen lock, actions (LOCKDOWN turns them off) and Home in view hold either way.
    for (const off of [{ consented: false }, { locked: true }, { actions: false }, { shown: false }]) {
      for (const kind of ["send", "local"] as const) expect(projectMay(kind, { ...ok, ...off, ready: false }), `${kind} ${JSON.stringify(off)}`).toBe(false);
      for (const kind of ["send", "local"] as const) expect(projectMay(kind, { ...ok, ...off }), `${kind} ${JSON.stringify(off)}`).toBe(false);
    }
    // Main's export, Remove and Apply patch handlers ask the local gate, before and after their dialogs.
    const main = readFileSync("app/main/main.ts", "utf8");
    for (const channel of ["projectExport", "projectRemove", "projectApply"]) {
      const start = main.indexOf(`ipcMain.handle(IPC.${channel},`);
      const body = main.slice(start, main.indexOf("ipcMain.handle(IPC.", start + 10));
      expect(body, channel).toContain("projectLocal()");
      expect(body, channel).not.toContain("projectAvailable()");
    }
  });
  it("leaves Apply patch's confirmation up while Ember reconnects, and stops only work that sends when the connection changes (integrations-v4-2)", () => {
    // Copilot's reconnect tries post "starting" (15 s, 30 s, then every minute) while offline.
    for (const phase of ["starting", "error", "signed-out"]) {
      expect(projectJobStops("local", phase), phase).toBe(false);
      expect(projectJobStops("send", phase), phase).toBe(true);
    }
    for (const kind of ["send", "local"] as const) expect(projectJobStops(kind, "ready"), kind).toBe(false);
    // Main marks Apply patch's job as local, and a status asks projectJobStops before it stops the job under way; Stop
    // everything, the screen lock, Sign out and the lockdown still stop it.
    const main = readFileSync("app/main/main.ts", "utf8");
    const apply = main.slice(main.indexOf("ipcMain.handle(IPC.projectApply,"), main.indexOf("ipcMain.handle(IPC.projectChooseFolder,"));
    expect(apply).toContain("projectLocalJobs.add(run);");
    const onStatus = main.slice(main.indexOf("      onStatus: status => {"), main.indexOf("broadcast(IPC.agentStatusChanged, status);"));
    expect(onStatus).toContain("projectJobStops(projectLocalJobs.has(projectJob) ? \"local\" : \"send\", status.phase)");
    expect(onStatus).not.toContain("if (status.phase !== \"ready\") projectJob?.abort();");
    expect(main).toContain("{ name: \"project\", stop: () => projectJob?.abort() }");
    expect(main).toContain("setLocked: locked => { if (locked) projectJob?.abort();");
  });
  it("says a request stopped because the connection dropped, not that it was cancelled (integrations-r1)", () => {
    expect(projectStopped(false)).toBe("Project request cancelled.");
    expect(projectStopped(true)).toBe("Ember lost its connection, so the request stopped. Send it again once Ember is connected.");
  });
});

it("verifies the temporary Copilot session before sending and deletes it after an answer", async () => {
  const session = {
    rpc: { tools: { initializeAndValidate: vi.fn().mockResolvedValue(undefined), getCurrentMetadata: vi.fn().mockResolvedValue({ tools: [] }) } },
    sendAndWait: vi.fn().mockResolvedValue({ data: { content: "A proposed patch." } }),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const client = { createSession: vi.fn().mockResolvedValue(session), deleteSession: vi.fn().mockResolvedValue(undefined) };
  const call = copilotOneShot({ client: client as never, model: "mock-model", workDir: dir, log: { warn: vi.fn() } as unknown as Logger, purpose: "project" });
  const signal = new AbortController().signal;
  expect(await call(PROJECT_SYSTEM, "Review this file.", signal)).toBe("A proposed patch.");
  const config = client.createSession.mock.calls[0][0];
  expect(config).toMatchObject({ sessionId: expect.stringMatching(/^ember-project-/), availableTools: [], tools: [], enableConfigDiscovery: false, enableSessionTelemetry: false });
  expect(config.infiniteSessions).toEqual({ enabled: false });
  expect(client.deleteSession).toHaveBeenCalledWith(config.sessionId);
  session.rpc.tools.getCurrentMetadata.mockResolvedValueOnce({ tools: [{ name: "shell" }] });
  expect(await call(PROJECT_SYSTEM, "Never send this.", signal)).toBeNull();
  expect(session.sendAndWait).toHaveBeenCalledOnce();
  const cancel = new AbortController();
  session.sendAndWait.mockImplementationOnce(async () => {
    cancel.abort();
    return { data: { content: "A late result." } };
  });
  expect(await call(PROJECT_SYSTEM, "Cancel this request.", cancel.signal)).toBeNull();
  expect(session.abort).toHaveBeenCalledOnce();
});
