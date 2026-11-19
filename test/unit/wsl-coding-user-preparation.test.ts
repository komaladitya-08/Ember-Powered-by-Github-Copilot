/** Actual Main preparation closure plus canonical policy/consent checks; no Electron import or OS process. */
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { parseAdminPolicy } from "../../app/main/admin";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { wslCodingUserPreparationAllowed } from "../../app/main/agent/wsl-coding-user-preparation";
const source = fs.readFileSync("app/main/main.ts", "utf8"), marker = "    prepareDefaultUser: ", begin = source.indexOf(marker), end = source.indexOf("\n    policy:", begin);
if (begin < 0 || end <= begin) throw new Error("The fixed Main user preparation closure is missing.");
const code = transformSync("module.exports = (" + source.slice(begin + marker.length, end).trim().replace(/,$/, "") + ");", { loader: "ts", format: "cjs", target: "node22" }).code;
function setup() {
  const prefs = structuredClone(DEFAULT_SETTINGS), at = "2026-11-17T00:00:00.000Z";
  prefs.targets.wsl = { on: true, consent: { version: FEATURE_CONSENT_VERSION.wsl, at } };
  prefs.commands["wsl:Ubuntu"] = { on: true, askEvery: true, consent: { version: FEATURE_CONSENT_VERSION.commands, at } };
  let admin = parseAdminPolicy('{"commands":{"wsl":"on"}}', "fixed-policy"), current = true;
  let resolve!: (uid: number | null) => void; const held = new Promise<number | null>(done => { resolve = done; });
  const defaultUid = vi.fn(() => held), initial = { wsl: { defaultUid } }; let targets = initial;
  let facts = { wslExe: "fixed-wsl.exe" };
  const module = { exports: undefined as unknown as (input: { distro: { name: string }; wslExe: string; current(): boolean }) => Promise<void> };
  runInNewContext(code, { module, get targets() { return targets; }, get admin() { return admin; }, get codingWslFacts() { return facts; }, settings: { get: () => prefs }, wslCodingUserPreparationAllowed });
  return { prefs, defaultUid, resolve, run: () => module.exports({ distro: { name: "Ubuntu" }, wslExe: "fixed-wsl.exe", current: () => current }),
    current: (value: boolean) => { current = value; }, policy: (text: string) => { admin = parseAdminPolicy(text, "fixed-policy"); },
    replaceRuntime: () => { targets = { wsl: { defaultUid } }; }, replaceExe: () => { facts = { wslExe: "other-wsl.exe" }; } };
}
it("uses only the existing public already-running user API after current explicit consent, without trusting its returned UID", async () => {
  const f = setup(), work = f.run(); expect(f.defaultUid).toHaveBeenCalledExactlyOnceWith("Ubuntu"); f.resolve(0); await expect(work).resolves.toBeUndefined();
});
it.each(["caller", "wsl-policy", "command-policy", "wsl-off", "wsl-consent", "command-off", "command-consent", "exe"] as const)("never starts the user probe for closed %s context", async kind => {
  const f = setup();
  if (kind === "caller") f.current(false);
  if (kind === "wsl-policy") f.policy('{"features":{"wsl":false},"commands":{"wsl":"on"}}');
  if (kind === "command-policy") f.policy('{"commands":{"wsl":"off"}}');
  if (kind === "wsl-off") f.prefs.targets.wsl.on = false;
  if (kind === "wsl-consent") f.prefs.targets.wsl.consent = { version: 0, at: "2026-11-17T00:00:00.000Z" };
  if (kind === "command-off") f.prefs.commands["wsl:Ubuntu"]!.on = false;
  if (kind === "command-consent") f.prefs.commands["wsl:Ubuntu"]!.consent = { version: 0, at: "2026-11-17T00:00:00.000Z" };
  if (kind === "exe") f.replaceExe();
  await f.run(); expect(f.defaultUid).not.toHaveBeenCalled();
});
it.each(["caller", "runtime", "policy", "consent", "exe"] as const)("rejects a held observed-user reply after %s changes", async kind => {
  const f = setup(), work = f.run(); const rejected = expect(work).rejects.toThrow("project or WSL settings changed");
  if (kind === "caller") f.current(false);
  if (kind === "runtime") f.replaceRuntime();
  if (kind === "policy") f.policy('{"commands":{"wsl":"off"}}');
  if (kind === "consent") f.prefs.commands["wsl:Ubuntu"]!.consent = { version: 0, at: "2026-11-17T00:00:00.000Z" };
  if (kind === "exe") f.replaceExe();
  f.resolve(1000); await rejected; expect(f.defaultUid).toHaveBeenCalledOnce();
});
it("canonical preparation permission accepts only an exact WSL target and accepted current cards", () => {
  const f = setup(), admin = parseAdminPolicy('{"commands":{"wsl":"on"}}', "fixed-policy");
  for (const target of ["local", "ssh:Ubuntu", "wsl:Missing", "wsl:Ubuntu\n"]) expect(wslCodingUserPreparationAllowed(admin, f.prefs, target)).toBe(false);
  expect(wslCodingUserPreparationAllowed(admin, f.prefs, "wsl:Ubuntu")).toBe(true);
});
