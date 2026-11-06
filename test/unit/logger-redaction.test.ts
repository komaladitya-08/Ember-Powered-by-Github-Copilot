// BE audit #1 (P2): what the REAL logger writes (its file and its stdout), not a helper's return value, never holds a
// token, whichever field, key, error property, scope or embedded form it came in by. Dummy markers only.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, type Logger } from "../../app/main/logger";
import { redactingLogger } from "../../app/main/provider";

const GH = "ghu_TESTMARKER_LOGGER_0123456789abcdef";
const PAT = "github_pat_TESTMARKER_LOGGER_0123456789";
const OAUTH = "gho_TESTMARKER_LOGGER_0123456789abcd";
const KEY = "sk-TESTMARKER-provider-key-0123456789";
const PLAIN = "plainsecret-TESTMARKER-9876543210"; // no GitHub shape: only an exact provider-key match can find it

afterEach(() => vi.restoreAllMocks());

function harness(secrets: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-logred-"));
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
  const real = createLogger({ dir, level: "debug", stdout: true });
  const log: Logger = redactingLogger(real, () => secrets);
  return {
    real, log,
    emitted: () => fs.readFileSync(real.file, "utf8") + out.join(""),
    lines: () => fs.readFileSync(real.file, "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("the logger's emitted lines hold no token (BE audit #1)", () => {
  it("redacts Error name, code, message, stack and cause", () => {
    const h = harness();
    const err = Object.assign(new Error(`failed with ${GH}`, { cause: Object.assign(new Error(PAT), { code: OAUTH }) }), { code: `E_${GH}` });
    err.name = `Err_${OAUTH}`;
    h.log.error("boom", { err });
    const text = h.emitted();
    for (const m of [GH, PAT, OAUTH]) expect(text).not.toContain(m);
    expect(h.lines()[0]).toMatchObject({ msg: "boom", err: { message: expect.stringContaining("failed with") } });
  });

  it("redacts the same through the bare logger, with no wrapper", () => {
    const h = harness();
    const err = Object.assign(new Error(GH), { code: PAT });
    err.name = OAUTH;
    h.real.error(`m ${GH}`, { err, [`k_${GH}`]: 1 });
    for (const m of [GH, PAT, OAUTH]) expect(h.emitted()).not.toContain(m);
  });

  it("redacts nesting deeper than any limit, and keeps a cycle finite", () => {
    const h = harness([PLAIN]);
    let deep: Record<string, unknown> = { leaf: `${GH} ${PLAIN}` };
    for (let i = 0; i < 40; i++) deep = { d: deep };
    const loop: Record<string, unknown> = { token: GH };
    loop.me = loop;
    h.log.info("deep", { deep, loop });
    const text = h.emitted();
    expect(text).not.toContain(GH);
    expect(text).not.toContain(PLAIN);
    expect(text).toContain("[circular]");
  });

  it("redacts a token or key used as an object KEY", () => {
    const h = harness([PLAIN]);
    h.log.info("keys", { [GH]: 1, nested: { [PLAIN]: "x", [PAT]: ["y"] } });
    const text = h.emitted();
    for (const m of [GH, PAT, PLAIN]) expect(text).not.toContain(m);
  });

  it("redacts child scopes and context bound through child()", () => {
    const h = harness([PLAIN]);
    h.log.child(`task-${GH}`).child(`sub-${PLAIN}`).warn("scoped", {});
    h.real.child(`bare-${PAT}`).warn("scoped bare");
    const text = h.emitted();
    for (const m of [GH, PAT, PLAIN]) expect(text).not.toContain(m);
    expect(h.lines()[0]!.scope).toMatch(/^task-.*\.sub-/);
  });

  it("redacts embedded forms: Bearer, token=, URL userinfo, JSON-escaped text, prefixes inside larger strings", () => {
    const h = harness();
    h.log.info(`Authorization: Bearer ${GH}`, {
      a: `token=${GH}`, b: `https://octo:${GH}@github.com/x`, c: JSON.stringify({ token: GH, nested: JSON.stringify({ t: PAT }) }),
      d: `xx${OAUTH}yy`, e: `https://user:notAGithubShapedPassword@host/p`, f: "Bearer abcdef0123456789opaque", g: "access_token=opaque0123456789",
    });
    const text = h.emitted();
    for (const m of [GH, PAT, OAUTH, "notAGithubShapedPassword", "abcdef0123456789opaque", "opaque0123456789"]) expect(text, m).not.toContain(m);
    expect(h.lines()[0]).toBeTruthy(); // still valid JSON, one line
  });

  it("leaves ordinary words alone", () => {
    const h = harness();
    h.log.info("ghost_writer asked about a token count", { note: "github_pattern", n: 3, tokens: 12 });
    expect(h.lines()[0]).toMatchObject({ msg: "ghost_writer asked about a token count", note: "github_pattern", n: 3, tokens: 12 });
  });

  it("writes a provider key only as [key], wherever it appears", () => {
    const h = harness([KEY]);
    h.log.info(`k ${KEY}`, { [KEY]: KEY, err: Object.assign(new Error(KEY), { code: KEY }) });
    expect(h.emitted()).not.toContain(KEY);
  });
});
