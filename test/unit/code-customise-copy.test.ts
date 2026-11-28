/**
 * Customise's words (app/renderer/code/copy-customise.ts) and its wiring: sentence case, curly quotes round names,
 * straight apostrophes, British spelling, a section for every label, every method a section calls on the window's
 * allow-list (or, until it is, said "not available" by the kit), and no call that sets a mode or touches the sandbox.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codeRpcAllowed } from "../../app/shared/code";
import * as copy from "../../app/renderer/code/copy-customise";
import { CUSTOMISE_SECTIONS } from "../../app/renderer/code/copy";

const dir = "app/renderer/code";
const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8");
const sections = fs.readdirSync(dir).filter(f => /^customise-[a-z]+\.ts$/.test(f) && !["customise-kit.ts", "customise-read.ts", "customise-forms.ts", "customise-sections.ts"].includes(f));

describe("Customise's words", () => {
  it("pins the lines people read most", () => {
    expect(copy.scopeSession("Fix the login redirect")).toBe("Applies to the session “Fix the login redirect”.");
    expect(copy.SCOPE_COMPUTER).toBe("Applies to this computer: every session here uses it.");
    expect(copy.NOT_AVAILABLE).toBe("This isn't available in the coding window yet.");
    expect(copy.RETRY).toBe("Try again");
    expect(copy.modelMeta({ id: "m", name: "M", vendor: "OpenAI", context: 400_000, vision: true, efforts: ["low", "xhigh"], multiplier: 1, notices: [] }))
      .toBe("OpenAI · 400K tokens of context · Reads images · Reasoning: Low, Extra high · 1× premium requests");
    expect(copy.multiplierCost(0)).toBe("Included in your plan");
    expect(copy.mcpStatusWords("needs-auth")).toBe("Needs you to sign in");
    expect(copy.mcpStatusWords("connected", true)).toBe("Connected, with a problem");
    expect(copy.removeQuestion("docs")).toBe("Remove “docs”?");
    expect(copy.loadedWith({ warnings: 2, errors: 1 })).toBe("Read again: 1 couldn't be read, 2 have warnings.");
    expect(copy.hookEvent("preToolUse")).toBe("Before a tool runs");
    expect(copy.hookEvent("someNewEvent")).toBe("Some new event");
    expect(copy.hookProblems({ warnings: 0, errors: 1 })).toBe("1 couldn't be read.");
    expect(copy.sandboxRow("no-network")).toBe("Its tools run in the sandbox, but without the network: this computer's sandbox can't give it one.");
    expect(copy.capabilityLine({ name: "network", supported: false })).toBe("Network inside the sandbox: no");
    expect(copy.scheduleWhen({ recurring: true, every: 1_800_000, selfPaced: false })).toBe("Every 30 minutes");
    expect(copy.quotaLine({ type: "x", unlimited: false, used: 87, entitled: 300, remaining: 71, overage: 0 })).toBe("87 of 300 used · 71% left");
    expect(copy.quotaName("premium_interactions")).toBe("Premium requests");
    expect(copy.planWords("pro_plus")).toBe("Plan: Copilot Pro+");
    expect(copy.contextLine({ total: 48_200, limit: 128_000 })).toBe("48.2K of 128K tokens");
    expect(copy.compactedWords({ ok: true, tokens: 28_000, messages: 12 })).toBe("Compacted: 28K tokens and 12 messages freed.");
    expect(copy.marketHeld("acme", ["a", "b"])).toBe("“acme” wasn't removed: “a”, “b” come from it. Uninstall them first.");
    expect(copy.pluginInstalledWords("x", 1, false)).toBe("“x” was installed, with 1 skill.");
    expect(copy.agentInUse(null)).toBe("The session uses Copilot's own agent.");
    expect(copy.modeOffByOrg("Approve all")).toBe("Approve all (turned off by your organisation)");
  });

  it("uses straight apostrophes, curly quotes, no tracked capitals and British spelling", () => {
    const src = read(`${dir}/copy-customise.ts`);
    expect(src).not.toMatch(/’/);
    expect(src).not.toMatch(/\b(organization|color|customize|behavior|favorite|catalog)\b/i);
    for (const [name, value] of Object.entries(copy)) {
      if (typeof value !== "string") continue;
      expect(value, name).not.toMatch(/"[^"]+"/);
      // Capitals only in an acronym people say that way, or a file named so (SKILL.md, AGENTS.md).
      expect(value.replace(/\b(HTTP|HTTPS)\b|\b[A-Z]+\.md\b/g, ""), name).not.toMatch(/\b[A-Z]{4,}\b/);
      expect(value[0], name).toBe(value[0].toUpperCase());
    }
  });
});

describe("Customise's sections", () => {
  it("gives every label of Customise a section of its own, all loaded by customise-sections.ts", () => {
    const index = read(`${dir}/customise-sections.ts`);
    const defined = sections.flatMap(f => [...read(`${dir}/${f}`).matchAll(/defineSection\("([^"]+)"/g)].map(m => m[1]));
    expect(defined.sort()).toEqual([...CUSTOMISE_SECTIONS].sort());
    for (const f of sections) expect(index, f).toContain(`import "./${f.replace(/\.ts$/, "")}";`);
    expect(read(`${dir}/main.ts`)).toContain('import "./customise-sections";');
    expect(read(`${dir}/index.html`)).toContain('<link rel="stylesheet" href="customise-sections.css">');
  });

  it("calls only methods on the window's allow-list, never one that sets a mode or touches the sandbox", () => {
    const calls = sections.flatMap(f => [...read(`${dir}/${f}`).matchAll(/ctx\.call\("(client|session)", (?:[a-z]+ \? )?"([\w.]+)"(?: : "([\w.]+)")?/g)].flatMap(m => [[m[1], m[2]], ...(m[3] ? [[m[1], m[3]]] : [])] as [string, string][]));
    expect(calls.length).toBeGreaterThan(50);
    const missing = calls.filter(([s, m]) => !codeRpcAllowed(s as "client" | "session", m)).map(([s, m]) => `${s}:${m}`);
    expect(missing).toEqual([]);
    for (const [, m] of calls) expect(m).not.toMatch(/^(permissions\.(setMode|setApproveAll|configure)|options\.|sandbox\.(?!get))/);
  });
});
