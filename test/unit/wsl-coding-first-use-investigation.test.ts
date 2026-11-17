/** Portable composition counterexample only. Every OS/process reply is fixed memory data; no Windows capability is issued. */
import { expect, it, vi } from "vitest";
import { createWslWith } from "../../app/main/wsl/service";
import { LXSS_KEY } from "../../app/main/wsl/lxss";
import { FACTS_SCRIPT } from "../../app/main/wsl/runner";
import { ProjectCodingExecution } from "../../app/main/agent/project-coding-execution";
import type { WslFacts } from "../../app/main/wsl/types";
import type { CommandService } from "../../app/main/commands/types";
import { answerScript, answerWith, fakeLog, FakeRegistry, fakeSpawn, utf16 } from "./wsl-wa-fakes";
const PROJECT = "11111111-1111-4111-8111-111111111111";
function fixture(uid = 1000, consent = true, prepare = false) {
  const registry = new FakeRegistry().key(LXSS_KEY, { DefaultDistribution: "{u}" }).key(`${LXSS_KEY}\\{u}`, { DistributionName: "Ubuntu", Version: 2, Flags: 15, DefaultUid: 0, State: 1 });
  let running = true;
  const fake = fakeSpawn(call => {
    const a = call.wsl;
    if (a[0] === "--list" && a[1] === "--running") return answerWith(call, { stdout: utf16(running ? "Ubuntu\r\n" : "\r\n"), code: 0 });
    if (a[0] === "--version") return answerWith(call, { stdout: Buffer.from("WSL version: 2.3.26.0\nWSLg version: 1.0.65\n"), code: 0 });
    if (a[0] === "-d") call.child.onScript = script => {
      expect(script).toContain(FACTS_SCRIPT.split("\n")[0]);
      answerScript(call, { stdout: `uid=${uid}\nuser=ember\nhome=/home/ember\nshell=/bin/bash\nshell=/bin/sh\nscript=/usr/bin/script\ninterop=1\nmountc=/mnt/c/\npython3=1\nbase64=1\n` });
    };
  });
  const wsl = createWslWith({ log: fakeLog(), env: { SystemRoot: "C:\\Windows" }, os: "win32", ember: { winPaths: [] }, jobHost: { execPath: "C:\\Ember.exe", script: "C:\\job.cjs" } },
    { spawn: fake.spawn, exists: () => true, readFile: () => null, registry: () => registry, processImages: async () => [], now: () => 1_000_000 })!;
  const forbidden = () => { throw new Error("The composition must not execute or approve a command."); };
  const service: CommandService = { binding: { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", shellOs: "linux", screenOs: "win32", desktop: "none" },
    capability: () => ({ state: consent ? "on" : "needs-consent", why: "Accept command consent", askEvery: null }), shells: () => ["bash"], runner: wsl.runner("Ubuntu"),
    window: { showCard: forbidden, hideCard: forbidden, cardReady: forbidden, announce: forbidden, cancelAnnounce: forbidden, attach: forbidden }, consented: forbidden, userAskEvery: () => true, mode: () => "on" };
  let facts: WslFacts | null = null;
  const commands = vi.fn(() => service), open = vi.fn(async () => { throw new Error("No native helper may open in this portable composition."); });
  const execution = new ProjectCodingExecution({ owner: () => "owner", projectExists: id => id === PROJECT, facts: () => facts, commands, policy: () => ({ consent }), open, ...(prepare ? { userPreparationAllowed: () => consent, prepareDefaultUser: async ({ distro, current }: { distro: { name: string }; current(): boolean }) => { if (consent && current()) await wsl.defaultUid(distro.name); } } : {}) });
  wsl.onChange(next => { facts = next; execution.refresh(); });
  return { wsl, execution, commands, open, stop: () => { running = false; }, inDistro: () => fake.calls.filter(c => c.wsl[0] === "-d") };
}
it("reproduces fresh Home selection remaining blocked across listing refresh without entering the only commands warm route", async () => {
  const f = fixture();
  await f.wsl.facts(); f.execution.choose(PROJECT, "wsl:Ubuntu");
  for (let i = 0; i < 3; i++) {
    await f.wsl.facts({ refresh: true });
    expect(f.execution.state(PROJECT).choices[1]).toMatchObject({ selectable: true, ready: false, message: expect.stringContaining("verify its non-root user") });
    expect(f.execution.capture(PROJECT)).toBeNull();
  }
  expect(f.commands).not.toHaveBeenCalled(); expect(f.inDistro()).toHaveLength(0); expect(f.open).not.toHaveBeenCalled();
  expect(await f.wsl.defaultUid("Ubuntu")).toBe(1000);
  expect(f.execution.state(PROJECT).choices[1].ready).toBe(true); expect(f.inDistro()).toHaveLength(1); expect(f.open).not.toHaveBeenCalled();
  f.wsl.dispose();
});
it.each([{ uid: 0, consent: true }, { uid: 1000, consent: false }])("observing uid=$uid cannot bypass root or command consent refusal (consent=$consent)", async ({ uid, consent }) => {
  const f = fixture(uid, consent); await f.wsl.facts(); f.execution.choose(PROJECT, "wsl:Ubuntu");
  expect(await f.wsl.defaultUid("Ubuntu")).toBe(uid); expect(f.execution.state(PROJECT).choices[1].ready).toBe(false); expect(f.execution.capture(PROJECT)).toBeNull(); expect(f.open).not.toHaveBeenCalled(); f.wsl.dispose();
});

it("makes an explicit fresh Home selection ready by observing the existing service user, with no command or helper launch", async () => {
  const f = fixture(1000, true, true); await f.wsl.facts(); f.execution.choose(PROJECT, "wsl:Ubuntu");
  expect(f.execution.state(PROJECT).choices[1].ready).toBe(false);
  await f.execution.prepareSelected(PROJECT, "wsl:Ubuntu", () => true);
  expect(f.execution.state(PROJECT).choices[1].ready).toBe(true); expect(f.inDistro()).toHaveLength(1); expect(f.open).not.toHaveBeenCalled(); f.wsl.dispose();
});

it("does not start a distro which stopped after the discovery snapshot, and cannot turn an observed root user into readiness", async () => {
  const stopped = fixture(1000, true, true); await stopped.wsl.facts(); stopped.execution.choose(PROJECT, "wsl:Ubuntu"); stopped.stop();
  await expect(stopped.execution.prepareSelected(PROJECT, "wsl:Ubuntu", () => true)).rejects.toThrow();
  expect(stopped.inDistro()).toHaveLength(0); expect(stopped.execution.state(PROJECT).choices[1].ready).toBe(false); expect(stopped.open).not.toHaveBeenCalled(); stopped.wsl.dispose();
  const root = fixture(0, true, true); await root.wsl.facts(); root.execution.choose(PROJECT, "wsl:Ubuntu"); await root.execution.prepareSelected(PROJECT, "wsl:Ubuntu", () => true);
  expect(root.inDistro()).toHaveLength(1); expect(root.execution.state(PROJECT).choices[1].ready).toBe(false); expect(root.execution.capture(PROJECT)).toBeNull(); expect(root.open).not.toHaveBeenCalled(); root.wsl.dispose();
});
