// BE audit #1 (P2): what the REAL logger writes (its file and its stdout), not a helper's return value, never holds a
// token, whichever field, key, error property, scope or embedded form it came in by. Dummy markers only.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, type Logger } from "../../app/main/logger";
import { redactingLogger } from "../../app/main/provider";
import { redactSecretText } from "../../app/main/secret-text";

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

  it("redacts today's common API keys and the commands redactor's other token shapes, keeping the line JSON (safety-privacy-2)", () => {
    const h = harness();
    const keys = [
      "sk-proj-TESTMARKER0123456789abcdefghijklmnopqrstuv", "sk-ant-api03-TESTMARKER0123456789abcdefghijklmnop",
      "sk_live_TESTMARKER0123456789ab", "hf_TESTMARKER0123456789abcdefghijklmn", "glpat-TESTMARKER0123456789ab",
      "AKIAABCDEFGHIJKLMNOP", "xoxb-1234567890-TESTMARKER",
    ];
    h.log.info(`keys ${keys[0]}`, { a: keys.join(" "), b: JSON.stringify({ openai_key: keys[0], k: keys[3] }), c: `"${keys[4]}"\\` });
    const text = h.emitted();
    for (const k of keys) expect(text, k).not.toContain(k);
    expect(h.lines()[0]).toBeTruthy();
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

  it("keeps every line valid JSON, in the file and on stdout, whatever a credential-named field holds", () => {
    const h = harness([PLAIN]);
    const fields: Record<string, unknown> = {
      secret: true, token: 12345678, password: null, api_key: "plain-value-0123", access_token: [GH, 1, false],
      authorization: { scheme: "Bearer", nested: { v: PLAIN } }, passwd: false, client_secret: 0,
      count: 3, ok: true, none: null, tokens: 12, label: "ghost_writer", note: "github_pattern",
      resembles: "the token count is high", words: ["secret agent", "password manager"], obj: { a: 1, b: [true, null] },
    };
    h.log.info("probe", fields);
    h.real.warn("probe two", { secret: true, token: null, deep: { password: [1, { x: GH }] } });
    const outLines = h.emitted().split("\n").filter(Boolean);
    expect(outLines.length).toBe(4); // two in the file, two on stdout
    for (const l of outLines) {
      const parsed = JSON.parse(l) as Record<string, unknown>; // (a) parses
      for (const m of [GH, PLAIN]) expect(l).not.toContain(m); // (b) no secret
      expect(parsed.secret).toBe("[token]");
    }
    expect(h.lines()[0]).toMatchObject({ // (c) the rest exactly as given
      count: 3, ok: true, none: null, tokens: 12, label: "ghost_writer", note: "github_pattern",
      resembles: "the token count is high", words: ["secret agent", "password manager"], obj: { a: 1, b: [true, null] },
    });
  });
});

describe("redactSecretText on a provider's or the runtime's error text", () => {
  it.each([["Authorization: Token abcd1234efgh5678", "abcd1234efgh5678"], ["authorization: Digest username=ana, response=6629fae49393a053", "6629fae49393a053"],
    ["client_secret=s3cr3tValue0001", "s3cr3tValue0001"], ["aws_secret_access_key = wJalrXUtnFEMIK7MDENG", "wJalrXUtnFEMIK7MDENG"], ["pwd=hunter2hunter2", "hunter2hunter2"],
    ["refresh_token: opaque0123456789", "opaque0123456789"], ["private_key=abcd0123456789", "abcd0123456789"]])(
    "hides the secret of “%s”, not only the word in front of it (safety-privacy-r9-4)", (text, secret) => {
      expect(redactSecretText(text)).not.toContain(secret);
    });

  it("keeps the scheme's word and ordinary words as they were (safety-privacy-r9-4)", () => {
    expect(redactSecretText("Authorization: Token abcd1234efgh5678")).toBe("Authorization: Token [token]");
    expect(redactSecretText("Authorization: Bearer abcd1234efgh5678")).toBe("Authorization: Bearer [token]");
    expect(redactSecretText("ghost_writer asked about a token count, sort by key")).toBe("ghost_writer asked about a token count, sort by key");
  });
});

describe("redactSecretText after a word it doesn't know as a scheme", () => {
  it("hides that word and the long value after it (safety-privacy-r9-4)", () => {
    expect(redactSecretText("Authorization: Custom abcd1234efgh5678")).not.toContain("abcd1234efgh5678");
  });
});
