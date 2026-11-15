/**
 * The vault's leak test, with fakes (owner decision of 2026-11-12; PLAN.md §2 "Approvals", "The vault"; the slice's
 * decision 7): every kind of entry is filled through the worker's real path, by accessibility and as keys, on each
 * OS's keys and words, into a pretend app that repeats everything it is given (test/fixtures/vault/). Then the canary
 * values are looked for, and must not be found, in everything a model is handed (the tools' results as the runtime
 * gets them, the system message, the prompts), the audit log, the logs at debug level, settings.json, every other
 * file in the data folder, every answer to Home, the announcements, the task's card and the clipboard; and every
 * filled field's rectangle must be black in every picture. test/integration/vault-leak.test.ts does the same on the
 * real runtime, and against a real window through the real helper.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { hardenedSessionConfig } from "../../app/main/agent/session-config";
import { workerSystemMessage } from "../../app/main/agent/worker-persona";
import { VAULT_REDACTED } from "../../app/main/vault/redact";
import type { OS } from "../../app/shared/shortcuts";
import { leakyEmber } from "../fixtures/vault/ember";
import { ACCOUNT, CANARY, FIELDS, REFRESH, TYPED_FIELD, canariesIn, fieldBounds, filesUnder } from "../fixtures/vault/leaky";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

type Result = { textResultForLlm: string; resultType: string; binaryResultsForLlm?: { data: string }[] };

/** A runtime client that only records what it is handed: the session's config, and every prompt. */
function recordingClient() {
  const configs: Record<string, unknown>[] = [];
  const prompts: unknown[] = [];
  const session = { send: async (o: unknown) => { prompts.push(o); return "m"; }, sendAndWait: async (o: unknown) => { prompts.push(o); return null; } };
  return { configs, prompts, client: { createSession: async (config: Record<string, unknown>) => { configs.push(config); return session; } } };
}

async function black(data: Buffer, x: number, y: number): Promise<boolean> {
  const { data: raw, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  return raw[(y * info.width + x) * info.channels] < 40;
}

describe("the canary test: nothing Ember writes or sends after a fill holds a value from the vault (vault-3)", () => {
  it("has canaries the search finds, in every form an app could hand them back", () => {
    for (const text of [CANARY.login.password, "4111 1111-1111 1111", `code ${CANARY.card.securityCode}.`, "valid 12/27", "1 canary wharf row, london e14 9zz",
      encodeURIComponent(CANARY.login.user), JSON.stringify(CANARY.login.password), CANARY.contact.phone, CANARY.card.cardName.toLowerCase()]) expect(canariesIn(text), text).not.toEqual([]);
    for (const text of ["2026-11-13T10:12:27.864Z", "port 58642", "ending 1111", VAULT_REDACTED, "Filling a saved password in Firefox"]) expect(canariesIn(text), text).toEqual([]);
  });

  it.each(["linux", "win32", "darwin"] as OS[])("on %s: every kind of entry, by accessibility and as keys", async platform => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-vault-leak-"));
    dirs.push(dir);
    const rec = recordingClient();
    const e = await leakyEmber({ dir, client: rec.client, os: platform });
    // The session as the worker makes it, through the client AgentHost would hand it: the tools' handlers the runtime
    // is given are the ones whose answers a model is sent.
    const wrapped = (e.worker as unknown as { d: { client: { createSession(c: unknown): Promise<{ send(o: unknown): Promise<unknown> }> } } }).d.client;
    const session = await wrapped.createSession(hardenedSessionConfig({ tools: e.worker.tools(), systemMessage: workerSystemMessage({ vault: true }), workingDirectory: dir, onPermissionRequest: () => ({ kind: "approved" }) as never }));
    const tools = rec.configs[0].tools as { name: string; handler(args: unknown, inv: unknown): Promise<Result> }[];
    const modelSaw: unknown[] = [rec.configs[0].systemMessage, tools.map(t => ({ ...t, handler: undefined }))];
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await tools.find(t => t.name === name)!.handler(args, {});
      modelSaw.push(typeof r === "string" ? r : { ...r, binaryResultsForLlm: r.binaryResultsForLlm?.map(b => ({ ...b, data: "(pixels)" })) });
      return r;
    };

    expect((await call("perceive_window", { image: true })).binaryResultsForLlm).toHaveLength(1);
    for (const f of FIELDS) {
      const r = await call("fill_from_vault", { id: f.id, what: f.what });
      expect(r.resultType, `${f.what}: ${r.textResultForLlm}`).toBe("success");
    }
    // Everything was really filled: the app holds every value, one of them typed as keys.
    expect(Object.fromEntries(e.app.held)).toEqual(Object.fromEntries(FIELDS.map(f => [f.id, f.value])));
    expect([...e.app.how].filter(([, how]) => how === "keys").map(([id]) => id)).toEqual([TYPED_FIELD]);
    expect(e.forms).toEqual([{ kind: "login", where: "shop.example" }]);

    // A look with a picture: the app shows every value again, in the fields, in a line and in a link's name.
    const looked = await call("perceive_window", { image: true });
    expect(looked.binaryResultsForLlm, looked.textResultForLlm).toHaveLength(1);
    const picture = e.pictures.at(-1)!.capture!;
    for (const b of [...FIELDS.map(f => fieldBounds(f.id)), { x: 450, y: 100, width: 300, height: 60 }, { x: 450, y: 260, width: 300, height: 30 }]) {
      const x = Math.round((b.x + b.width / 2 - picture.rect.x) * picture.scale), y = Math.round((b.y + b.height / 2 - picture.rect.y) * picture.scale);
      expect(await black(picture.data, x, y), JSON.stringify(b)).toBe(true);
    }
    expect(await black(picture.data, Math.round(700 * picture.scale), Math.round(500 * picture.scale))).toBe(false);
    // The model can't type over or read what was filled, nor press what is named after it.
    expect((await call("type_text", { id: 8, text: "x", mode: "append" })).resultType).toBe("denied");
    await call("click", { id: ACCOUNT });
    // A click the app answers with an error that repeats everything, and a window title that now says the email.
    await call("click", { id: REFRESH });
    expect(e.app.state.title).toContain(CANARY.contact.email);
    await call("list_windows", {});
    const after = await call("perceive_window", { image: true });
    expect(after.binaryResultsForLlm).toBeUndefined();
    expect(after.textResultForLlm).toContain("(No screenshot: the window's title shows something Ember filled from its vault.)");
    await call("report_progress", { text: "Filled the checkout." });
    await call("finish_task", { success: true, summary: "Signed in and filled in the checkout." });
    await session.send({ prompt: `<task_result untrusted="true">The page now says: You entered ${Object.values(CANARY.contact).join(", ")}</task_result>` });
    modelSaw.push(rec.prompts);

    // Nothing a model was handed.
    for (const seen of modelSaw) expect(canariesIn(JSON.stringify(seen)), JSON.stringify(seen).slice(0, 600)).toEqual([]);
    expect(JSON.stringify(modelSaw)).toContain(VAULT_REDACTED); // the app's words did come back, with the values taken out
    // Nothing on disk: the audit log, the logs at debug level, settings.json, the vault's own file (sealed), anything else.
    const files = filesUnder(dir);
    expect(files.map(f => f.file.split(path.sep)[0]).sort()).toEqual(expect.arrayContaining(["audit", "logs", "vault.json"]));
    for (const f of files) expect(canariesIn(f.text), f.file).toEqual([]);
    const audited = files.filter(f => f.file.startsWith("audit")).flatMap(f => f.text.split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>));
    expect(audited.filter(a => a.event === "action" && a.kind === "vault_fill" && a.ok === true)).toHaveLength(FIELDS.length);
    expect(audited.filter(a => a.kind === "screenshot")).toHaveLength(2);
    expect(files.find(f => f.file.startsWith("logs"))!.text.split("\n").length).toBeGreaterThan(10);
    // Nothing Home is answered, announced, shown on the task's card or put on the clipboard.
    expect(canariesIn(JSON.stringify([e.home(), e.said, e.activity, e.progress]))).toEqual([]);
    expect(e.said).toContain("Filling a saved password in Firefox, from the vault: Autopilot is on.");
    expect(e.app.state.clipboard).toBe(0);
  }, 30_000);
});
