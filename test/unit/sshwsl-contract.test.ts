/**
 * The SSH/WSL contract (Step 0a, design §10.1 S0a row): the new settings and their repair, the admin policy's commands
 * modes, lockdown, summaries and their combination (property-tested never to loosen either machine's rules), allowed
 * hosts, every protocol schema against a valid example and against an extra key, a too-long string and a non-finite
 * number, the fixed launcher texts, and the stubs keeping today's behaviour. OS-neutral: no process, file or
 * environment of the machine running it is touched.
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ADMIN_POLICY_PATHS, AdminPolicySchema, adminSummary, combineAdmin, commandMode, hostAllowed, lockedDown, parseAdminPolicy,
  type AdminSummary, type LoadedAdminPolicy,
} from "../../app/main/admin";
import { DEFAULT_SETTINGS, HostRecordSchema, SettingsSchema, repairSettings } from "../../app/main/settings";
import { CONSENT_VERSION, FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { DISTRO_NAME, HOST_ID, LOCAL_TARGET, parseTargetId, targetIdOf, type TargetKind } from "../../app/shared/targets";
import { journalLine } from "../../app/main/policy/audit";
import { NO_RC, POSIX_PRELUDE, PS_INNER, WSL_EVAL, posixBody, posixInner } from "../../app/main/commands/run/shells";
import {
  CAPS, EV_SCHEMAS, OP_SCHEMAS, emberNamesRegExp,
  type DesktopState, type EvMap, type EvName, type Hello, type Op, type OpArgs, type OpResult, type Welcome,
} from "../../app/main/remote/protocol";
import { ConnectError, type HostRecord } from "../../app/main/remote/types";
import type { CommandMode, RunSpec, RunnerFacts } from "../../app/main/commands/types";
import type { ActStamp, PerceptionPort, SidecarPort } from "../../app/main/perception/ports";
import type { Seen } from "../../app/main/perception";
import type { Hands } from "../../app/main/agent/host";
import type { TargetsDeps } from "../../app/main/targets/types";
import type { SystemPlatform } from "../../app/main/platform/types";
import type { ActionRequest } from "../../app/main/policy/policy";
import type { AtspiSidecar } from "../../app/main/perception/sidecar";
import { createTargets, targetDoctorRows } from "../../app/main/targets/runtime";
import { createWsl } from "../../app/main/wsl/service";
import { wrapForWsl, type WrapForWslOptions } from "../../app/main/wsl/routed-sidecar";
import { wrapWindowsForWsl } from "../../app/main/wsl/routed-windows";
import { wslAwarePrivacy, wslAwareSystem } from "../../app/main/wsl/privacy";
import { targetRules } from "../../app/main/policy/target-rules";
import { createLocalRunner } from "../../app/main/commands/run/local";
import { createCommandWindowPort } from "../../app/main/commands/window";
import { runCommandTool, type CommandFlowContext } from "../../app/main/commands/flow";
import { carriedText } from "../../app/main/commands/carried";
import { createConnections } from "../../app/main/remote/connections";
import { createPromptWindow } from "../../app/main/remote/prompt-window";
import { createMux } from "../../app/main/remote/mux";
import { remoteTargetParts } from "../../app/main/remote/target";
import { captureRect } from "../../app/remote/capture-stub";

// ─────────────── Target ids ───────────────

describe("target ids", () => {
  it("parses local, a distro and a host, and refuses anything else", () => {
    expect(parseTargetId("local")).toEqual({ kind: "local", name: "" });
    expect(parseTargetId("wsl:Ubuntu-22.04")).toEqual({ kind: "wsl", name: "Ubuntu-22.04" });
    expect(parseTargetId("ssh:build-01")).toEqual({ kind: "ssh", name: "build-01" });
    for (const bad of ["", "Local", "wsl:", "ssh:", "ssh:Build-01", "wsl:-x", "wsl:a b", "ssh:a/b", "ftp:x", "ssh:x\n", `wsl:${"a".repeat(65)}`]) {
      expect(parseTargetId(bad), bad).toBeNull();
    }
  });

  it("builds ids only from valid names", () => {
    expect(targetIdOf("wsl", "Ubuntu")).toBe("wsl:Ubuntu");
    expect(targetIdOf("ssh", "build-01")).toBe("ssh:build-01");
    expect(() => targetIdOf("ssh", "Build-01")).toThrow();
    expect(() => targetIdOf("wsl", "-rf")).toThrow();
    expect(LOCAL_TARGET).toBe("local");
    expect(DISTRO_NAME.test("docker-desktop-data")).toBe(true);
    expect(HOST_ID.test("build.example.com")).toBe(true);
  });
});

// ─────────────── Settings ───────────────

const host = (over: Record<string, unknown> = {}) => ({
  id: "build-01", dest: "deploy@build-01", resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: [] },
  consent: { version: 1, at: "2026-10-22T12:00:00.000Z" }, ...over,
});

describe("settings for targets and commands", () => {
  it("defaults to this computer only, nothing added, commands off everywhere", () => {
    expect(DEFAULT_SETTINGS.targets).toEqual({
      active: "local", offerSsh: true, dismissedOffers: [], hosts: [], wsl: { on: false, consent: { version: 0, at: null } }, pcId: "",
    });
    expect(DEFAULT_SETTINGS.commands).toEqual({});
    // A file from before these settings existed reads as the defaults.
    expect(SettingsSchema.parse({ character: "wisp" }).targets).toEqual(DEFAULT_SETTINGS.targets);
  });

  it("checks host records as §5.1.2 says (no option injection, no % in hops, carried options from the allow-list)", () => {
    expect(HostRecordSchema.safeParse(host()).success).toBe(true);
    expect(HostRecordSchema.safeParse(host({ port: 2222, via: "wsl:Ubuntu", extra: { jump: ["bastion"], identityFiles: ["~/.ssh/work_ed25519"], options: { HostKeyAlias: "build" } } })).success).toBe(true);
    for (const bad of [
      host({ id: "Build" }), host({ dest: "-oProxyCommand=evil" }), host({ dest: "a b" }), host({ port: 0 }),
      host({ extra: { jump: ["%h"] } }), host({ extra: { options: { ProxyCommand: "sh" } } }), host({ extra: { identityFiles: ["key"] } }),
      host({ via: "wsl:bad name" }), host({ resolved: { user: "deploy\n", hostname: "h", port: 22, jump: [] } }), host({ machineIdHash: "xyz" }),
    ]) expect(HostRecordSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("keeps valid host records one by one, and drops a broken or repeated one alone", () => {
    const kept = repairSettings({
      targets: {
        active: "ssh:build-01", offerSsh: false, dismissedOffers: ["web-02", 7], pcId: "0123456789abcdef0123456789abcdef",
        hosts: [host(), host({ id: "Bad id" }), host({ id: "web-02", dest: "web-02" }), host({ dest: "other" })],
      },
    });
    expect(kept.targets.hosts.map(h => h.id)).toEqual(["build-01", "web-02"]);
    expect(kept.targets.active).toBe("ssh:build-01");
    expect(kept.targets.offerSsh).toBe(false);
    expect(kept.targets.dismissedOffers).toEqual(["web-02"]);
    expect(kept.targets.pcId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("resets an invalid active target or install id, and keeps each valid commands entry", () => {
    const s = repairSettings({
      targets: { active: "ssh:Not valid", pcId: "short" },
      commands: { local: { on: true, askEvery: true, consent: { version: 1, at: "x" } }, "wsl:bad name": { on: true }, "ssh:web": { on: "yes" } },
    });
    expect(s.targets.active).toBe("local");
    expect(s.targets.pcId).toBe("");
    expect(s.commands).toEqual({ local: { on: true, askEvery: true, consent: { version: 1, at: "x" } } });
  });

  it("types a parsed host record as remote/types.ts's HostRecord", () => {
    const asRecord = (h: z.infer<typeof HostRecordSchema>): HostRecord => h;
    expect(asRecord(HostRecordSchema.parse(host())).id).toBe("build-01");
  });

  it("keeps the global consent at 1 and versions the three cards apart", () => {
    expect(CONSENT_VERSION).toBe(1);
    expect(FEATURE_CONSENT_VERSION).toEqual({ wsl: 1, ssh: 1, commands: 1 });
  });
});

// ─────────────── Admin policy ───────────────

const loaded = (raw: object | null): LoadedAdminPolicy => raw === null
  ? { policy: AdminPolicySchema.parse({}), source: null }
  : parseAdminPolicy(JSON.stringify(raw), "/etc/ember/policy.json");
const KINDS: TargetKind[] = ["local", "wsl", "ssh"];

describe("the administrator's commands modes (R5, §9.3)", () => {
  it("is on for every kind without a policy (each target still needs its card)", () => {
    for (const k of KINDS) expect(commandMode(loaded(null), k)).toBe("on");
  });
  it("is off for every kind in a policy without the commands key", () => {
    for (const k of KINDS) expect(commandMode(loaded({ features: { voice: false } }), k)).toBe("off");
  });
  it("is the policy's value per kind, off where a kind is missing", () => {
    const l = loaded({ commands: { local: "off", ssh: "ask" } });
    expect(commandMode(l, "local")).toBe("off");
    expect(commandMode(l, "ssh")).toBe("ask");
    expect(commandMode(l, "wsl")).toBe("off");
    expect(commandMode(loaded({ commands: { wsl: "on" } }), "wsl")).toBe("on");
  });
  it("is off for WSL or SSH when the policy turns that feature off, whatever its commands key says", () => {
    const l = loaded({ features: { wsl: false, ssh: false }, commands: { local: "on", wsl: "on", ssh: "on" } });
    expect(commandMode(l, "wsl")).toBe("off");
    expect(commandMode(l, "ssh")).toBe("off");
    expect(commandMode(l, "local")).toBe("on");
    expect(adminSummary(l).commands).toEqual({ local: "on", wsl: "off", ssh: "off" });
    expect(commandMode(loaded({ features: { ssh: true }, commands: { ssh: "ask" } }), "ssh")).toBe("ask");
  });
  it("is off everywhere for a policy that can't be used", () => {
    for (const k of KINDS) expect(commandMode(lockedDown("/etc/ember/policy.json", "broken"), k)).toBe("off");
    for (const k of KINDS) expect(commandMode(loaded({ commands: { local: "always" } }), k)).toBe("off");
  });
});

describe("the policy's new keys", () => {
  it("parses the design's fleet example, which an older Ember locks down on", () => {
    const l = loaded({ features: { ssh: true, wsl: false }, commands: { local: "off", ssh: "ask" }, ssh: { allowedHosts: ["*.build.example.com"], desktop: false } });
    expect(l.error).toBeUndefined();
    expect(l.policy.ssh).toEqual({ allowedHosts: ["*.build.example.com"], desktop: false });
  });
  it("refuses unknown or out-of-range values (fail closed)", () => {
    for (const raw of [
      { commands: { local: "on", printer: "on" } }, { ssh: { commandGraceSeconds: 2 } }, { ssh: { commandGraceSeconds: 121 } },
      { ssh: { runtimeMirror: "http://mirror.example.com" } }, { ssh: { tunnel: true } }, { features: { telnet: true } },
    ]) expect(loaded(raw).error, JSON.stringify(raw)).toBeDefined();
    expect(loaded({ ssh: { runtimeMirror: "https://mirror.example.com/node", commandGraceSeconds: 3 } }).error).toBeUndefined();
  });
  it("turns WSL, SSH and every kind of command off in lockdown", () => {
    const p = lockedDown("/etc/ember/policy.json", "broken").policy;
    expect(p.features).toMatchObject({ wsl: false, ssh: false, actions: false, voice: false });
    expect(p.commands).toEqual({ local: "off", wsl: "off", ssh: "off" });
  });
  it("names the POSIX policy files as data", () => {
    expect(ADMIN_POLICY_PATHS).toEqual({ linux: "/etc/ember/policy.json", darwin: "/Library/Application Support/Ember/policy.json" });
  });
});

describe("adminSummary", () => {
  it("says what the policy says, its commands modes resolved, and only whether there is a provider", () => {
    const l = loaded({
      features: { screenImages: false, ssh: true }, neverLook: ["KeePassXC"], confirmEveryAction: true, maxActionsPerMinute: 10,
      commands: { ssh: "ask" }, ssh: { desktop: false, commandGraceSeconds: 30 }, models: { allowed: ["gpt-x"] },
      provider: { type: "openai", baseUrl: "https://llm.example.com/v1", apiKeyFile: "/etc/ember/key" },
    });
    expect(adminSummary(l)).toEqual({
      source: "/etc/ember/policy.json", features: { screenImages: false, ssh: true }, neverLook: ["KeePassXC"],
      confirmEveryAction: true, allowGrants: true, maxActionsPerMinute: 10, commands: { local: "off", wsl: "off", ssh: "ask" },
      ssh: { desktop: false, commandGraceSeconds: 30 }, models: { allowed: ["gpt-x"] }, provider: true,
    });
  });
  it("is everything on for no policy, and carries a broken one's error", () => {
    expect(adminSummary(loaded(null))).toEqual({
      source: null, features: {}, neverLook: [], confirmEveryAction: false, allowGrants: true,
      commands: { local: "on", wsl: "on", ssh: "on" }, ssh: {}, models: {}, provider: false,
    });
    const broken = adminSummary(lockedDown("/etc/ember/policy.json", "not JSON"));
    expect(broken.error).toBe("not JSON");
    expect(broken.commands).toEqual({ local: "off", wsl: "off", ssh: "off" });
  });
});

/** A small deterministic random source (mulberry32), so the property test is the same on every run and OS. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FEATURES = ["actions", "cursor", "desk", "screenImages", "wsl", "ssh", "voice", "speak"] as const;
const MODES: CommandMode[] = ["off", "ask", "on"];
const rank = (m: CommandMode) => MODES.indexOf(m);

function randomSummary(r: () => number): AdminSummary {
  const maybe = <T>(v: () => T): T | undefined => (r() < 0.5 ? v() : undefined);
  const subset = <T>(xs: T[]) => xs.filter(() => r() < 0.5);
  const features: AdminSummary["features"] = {};
  for (const k of FEATURES) { const v = maybe(() => r() < 0.5); if (v !== undefined) features[k] = v; }
  const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return strip({
    source: r() < 0.5 ? "/etc/ember/policy.json" : null,
    error: maybe(() => "broken"),
    features,
    neverLook: subset(["KeePassXC", "keepassxc", "Bitwarden", "Signal", "1Password"]),
    confirmEveryAction: r() < 0.5,
    allowGrants: r() < 0.5,
    maxActionsPerMinute: maybe(() => 1 + Math.floor(r() * 40)),
    commands: { local: MODES[Math.floor(r() * 3)], wsl: MODES[Math.floor(r() * 3)], ssh: MODES[Math.floor(r() * 3)] },
    ssh: strip({
      desktop: maybe(() => r() < 0.5),
      requireConsoleConsent: maybe(() => r() < 0.5),
      allowedHosts: maybe(() => subset(["*.build.example.com", "web-0?", "deploy@db:22", "*"])),
      commandGraceSeconds: maybe(() => 3 + Math.floor(r() * 118)),
    }),
    models: strip({ allowed: maybe(() => subset(["gpt-a", "gpt-b", "claude-c"])) }),
    provider: r() < 0.3,
  });
}

describe("combineAdmin", () => {
  it("is never looser than either machine's rules, and its grace is the smaller (random pairs)", () => {
    const r = random(20261022);
    for (let i = 0; i < 1000; i++) {
      const a = randomSummary(r), b = randomSummary(r);
      const c = combineAdmin(a, b);
      const why = JSON.stringify({ a, b, c });
      for (const s of [a, b]) {
        for (const k of FEATURES) expect((c.features[k] ?? true) <= (s.features[k] ?? true), `${k} ${why}`).toBe(true);
        for (const n of s.neverLook) expect(c.neverLook.map(x => x.toLowerCase()), why).toContain(n.toLowerCase());
        expect(c.confirmEveryAction >= s.confirmEveryAction, why).toBe(true);
        expect(c.allowGrants <= s.allowGrants, why).toBe(true);
        expect((c.maxActionsPerMinute ?? Infinity) <= (s.maxActionsPerMinute ?? Infinity), why).toBe(true);
        for (const k of KINDS) expect(rank(c.commands[k]) <= rank(s.commands[k]), `${k} ${why}`).toBe(true);
        expect((c.ssh.desktop ?? true) <= (s.ssh.desktop ?? true), why).toBe(true);
        expect((c.ssh.requireConsoleConsent ?? false) >= (s.ssh.requireConsoleConsent ?? false), why).toBe(true);
        if (s.ssh.allowedHosts) for (const h of c.ssh.allowedHosts ?? ["(missing)"]) expect(s.ssh.allowedHosts, why).toContain(h);
        if (s.models.allowed) for (const m of c.models.allowed ?? ["(missing)"]) expect(s.models.allowed, why).toContain(m);
        expect(c.provider >= s.provider, why).toBe(true);
        if (s.error) expect(c.error, why).toContain(s.error);
      }
      expect(c.ssh.commandGraceSeconds ?? 20, why).toBe(Math.min(a.ssh.commandGraceSeconds ?? 20, b.ssh.commandGraceSeconds ?? 20));
      // What crosses the link checks out as the protocol's AdminSummary.
      expect(EV_SCHEMAS["policy.changed"].safeParse(c).success, why).toBe(true);
    }
  });

  it("takes the stricter of each value in a worked example", () => {
    const pc = adminSummary(loaded({ commands: { ssh: "on" }, ssh: { commandGraceSeconds: 60, allowedHosts: ["*.example.com", "web-01"] }, neverLook: ["Signal"] }));
    const remote = adminSummary(loaded({ commands: { ssh: "ask" }, features: { screenImages: false }, ssh: { requireConsoleConsent: true, allowedHosts: ["web-01"] }, neverLook: ["signal", "KeePassXC"] }));
    const c = combineAdmin(pc, remote);
    expect(c.commands.ssh).toBe("ask");
    expect(c.features.screenImages).toBe(false);
    expect(c.ssh).toEqual({ requireConsoleConsent: true, allowedHosts: ["web-01"], commandGraceSeconds: 20 });
    expect(c.neverLook).toEqual(["Signal", "KeePassXC"]);
    expect(c.source).toBe("/etc/ember/policy.json; /etc/ember/policy.json");
  });

  it("leaves no model in common when the two allow-lists share none (the caller refuses to connect)", () => {
    const c = combineAdmin(adminSummary(loaded({ models: { allowed: ["a"] } })), adminSummary(loaded({ models: { allowed: ["b"] } })));
    expect(c.models.allowed).toEqual([]);
  });
});

describe("hostAllowed", () => {
  const d = { user: "deploy", hostname: "Build-01.Build.Example.com", port: 22 };
  const policy = (raw: object) => AdminPolicySchema.parse(raw);
  it("allows any host without a list, and none with SSH off", () => {
    expect(hostAllowed(policy({}), d)).toBe(true);
    expect(hostAllowed(policy({ features: { ssh: false } }), d)).toBe(false);
    expect(hostAllowed(policy({ ssh: { allowedHosts: [] } }), d)).toBe(false);
  });
  it("matches user@host:port, host:port and host, host names without regard to case", () => {
    expect(hostAllowed(policy({ ssh: { allowedHosts: ["*.build.example.com"] } }), d)).toBe(true);
    expect(hostAllowed(policy({ ssh: { allowedHosts: ["build-01.build.example.com:22"] } }), d)).toBe(true);
    expect(hostAllowed(policy({ ssh: { allowedHosts: ["deploy@*:22"] } }), d)).toBe(true);
    expect(hostAllowed(policy({ ssh: { allowedHosts: ["root@*"] } }), d)).toBe(false);
    expect(hostAllowed(policy({ ssh: { allowedHosts: ["*.build.example.com:2222"] } }), d)).toBe(false);
    expect(hostAllowed(policy({ ssh: { allowedHosts: ["build-0?.build.example.com"] } }), d)).toBe(true);
    expect(hostAllowed(policy({ ssh: { allowedHosts: ["build-01"] } }), d)).toBe(false);
  });
  it("reads a pattern's other characters literally", () => {
    expect(hostAllowed(policy({ ssh: { allowedHosts: ["build.01"] } }), { user: "u", hostname: "buildx01", port: 22 })).toBe(false);
    expect(hostAllowed(policy({ ssh: { allowedHosts: ["a+b"] } }), { user: "u", hostname: "aab", port: 22 })).toBe(false);
  });
});

describe("the audit journal", () => {
  it("keeps a command's size and its folder's, never their text", () => {
    const out = JSON.parse(journalLine(JSON.stringify({ event: "command", phase: "decided", command: "rm -rf ~/secret", commandChars: 4000, cwd: "/home/ana/clients/acme" })));
    expect(out).toEqual({ event: "command", phase: "decided", commandChars: 4000, cwdChars: 22 });
    expect(JSON.parse(journalLine(JSON.stringify({ event: "command", command: "ls" })))).toEqual({ event: "command", commandChars: 2 });
  });
});

// ─────────────── The protocol ───────────────

const bounds = { x: 10, y: 20, width: 300, height: 200 };
const admin = adminSummary(loaded({ features: { ssh: true }, commands: { ssh: "ask" }, ssh: { allowedHosts: ["*.build.example.com"], commandGraceSeconds: 30 }, models: { allowed: ["gpt-x"] } }));
const facts: RunnerFacts = {
  os: "linux", shells: ["bash", "sh"], shellPaths: { bash: "/usr/bin/bash", sh: "/bin/sh" }, script: { path: "/usr/bin/script", kind: "util-linux" },
  home: "/home/deploy", user: "deploy", privileged: false, pty: true,
  ember: { paths: ["/home/deploy/.local/share/ember-remote"], pids: [4242], names: emberNamesRegExp(["ember-remote", "ember_atspi.py"]) },
  extraPath: [], wsl: { mountRoot: "/mnt", interop: true, windows: { home: "C:\\Users\\ana", localAppData: "C:\\Users\\ana\\AppData\\Local", appData: "C:\\Users\\ana\\AppData\\Roaming", temp: "C:\\Users\\ana\\AppData\\Local\\Temp", systemRoot: "C:\\Windows", emberPaths: ["C:\\Users\\ana\\AppData\\Local\\ember"] } },
};
const desktop: DesktopState = { access: "text", why: "Wayland: no screenshots", session: { type: "wayland", locked: false, active: true }, notice: "shown" };
const window = { app: "gedit", pid: 100, path: "/org/a11y/atspi/accessible/1", name: "notes.txt - gedit", role: "frame", active: true, bounds, busy: false };
const seen: Seen = {
  window, x11Window: { id: 1234, pid: 100, title: "notes.txt - gedit", x: 0, y: 0, width: 800, height: 600, wmClass: "gedit" },
  nodes: [{ id: 3, parent: 1, depth: 2, role: "push button", name: "Save", states: ["enabled", "focusable"], bounds, actions: ["click"], value: 0.5, size: { rows: 1048576, columns: 1024 } }],
  blocked: false, busy: false, truncated: null, others: [{ name: "Open", role: "dialog", active: false, modal: true }], ms: 12, axScale: 1,
};
const stamp: ActStamp = { taskId: "1-abcdef12", kind: "text", app: "gedit", window: "notes.txt - gedit", element: { role: "text", name: "Body" }, valueSha256: "e".repeat(64), verdict: "confirm", approval: { given: true }, ageMs: 120 };
const element = { role: "text", name: "Body", states: ["editable"], bounds, text: "hello", value: 2 };
const runId = "0123456789abcdef";
const spec: RunSpec = {
  runId, taskId: "1-abcdef12", shell: "bash", command: "rm -r build", cwd: "/home/deploy/src", timeoutMs: 120_000, cols: 100, rows: 30,
  stamp: { taskId: "1-abcdef12", sha256: "a".repeat(64), verdict: "ask", classes: ["destroy"], rules: ["posix.rm"], approval: { ageMs: 900 } },
};
const welcome: Welcome = {
  proto: 1, partsId: "0.1.0-0123456789ab", os: "linux", arch: "x64", machineIdHash: "b".repeat(64), isWsl: false, uid: 1000, user: "deploy",
  home: "/home/deploy", facts, desktop, remoteAdmin: admin, pid: 4242, tccLimited: false, graceSeconds: 20,
};
const hello: Hello = {
  proto: 1, partsId: "0.1.0-0123456789ab", local: { name: "ana-laptop", os: "win32" }, pcId: "c".repeat(32),
  consent: { version: 1, at: "2026-10-22T12:00:00.000Z" }, neverLook: ["KeePassXC"], localAdmin: admin, epoch: 1,
};

/** A valid example of every op's arguments and result (typed: the compiler checks that every op has one). */
const OPS: { [O in Op]: { args: OpArgs<O>; result: OpResult<O> } } = {
  "hello": { args: hello, result: welcome },
  "policy.sync": { args: { neverLook: ["keepassxc"], localAdmin: admin }, result: {} },
  "desktop.state": { args: {}, result: desktop },
  "perceive.read": { args: { target: { pid: 100, title: "notes.txt - gedit" }, keep: true, cells: ["C62"] }, result: seen },
  "perceive.focused": { args: {}, result: seen },
  "perceive.perceive": {
    args: { image: true, scope: "window", target: { pid: 100, path: "/org/a11y/atspi/accessible/1" } },
    result: { seen, image: { channel: 7, bytes: 51_234, sha256: "d".repeat(64), width: 800, height: 600, rect: bounds, scale: 1, mime: "image/png" }, noShot: "a password window is open" },
  },
  "perceive.atPoint": { args: { target: { pid: 100, path: "/1" }, x: 15, y: 25, k: 1 }, result: { chain: [{ role: "frame", name: "gedit", bounds }, { role: "push button", name: "Save", bounds: null, secret: false }] } },
  "perceive.windows": { args: {}, result: { windows: [window] } },
  "perceive.openWindows": { args: {}, result: { lines: [{ app: "gedit", title: "notes.txt", active: true, busy: false }] } },
  "perceive.systemDialog": { args: {}, result: { open: false } },
  "ax.readElement": { args: { id: 3, shown: true, formula: false }, result: element },
  "ax.canDo": { args: { id: 3, kind: "click", caret: false }, result: { tier1: true, why: "", action: "click", handler: { role: "push button", name: "Save" } } },
  "ax.listOptions": { args: { id: 4 }, result: { options: ["Monospace", "Sans"], left: 0 } },
  "act": {
    args: { opId: "op-1", epoch: 1, stamp, op: "set_text", id: 5, text: "hello", mode: "replace" },
    result: { status: "ok", result: { ok: true, action: "set_text", before: element, after: element, unchecked: 0 } },
  },
  "apps.list": { args: {}, result: { apps: [{ id: "org.gnome.gedit.desktop", name: "Text Editor", keywords: ["text"], categories: ["Utility"], argv: ["gedit", "%U"], terminal: false }] } },
  "apps.launch": { args: { epoch: 1, appId: "org.gnome.gedit.desktop", stamp: { ...stamp, kind: "open_app" } }, result: { status: "deny", reason: "Ember doesn't run terminals", pid: 77 } },
  "cmd.facts": { args: {}, result: facts },
  "cmd.inspect": { args: { paths: ["/home/deploy/build"], cwd: "/home/deploy" }, result: { paths: [{ exists: true, real: "/home/deploy/build" }, { exists: null, real: null }] } },
  "cmd.git": { args: { cwd: "/home/deploy/src/app" }, result: { git: { branch: "feature-x", pushDefault: "simple", upstream: "origin/feature-x" } } },
  "cmd.run": {
    args: { epoch: 1, spec },
    result: { status: "needs_confirm", reason: "It deletes build", says: ["Deletes build and everything in it."], rules: ["posix.rm"] },
  },
  "cmd.input": { args: { runId, data: "aGVsbG8K" }, result: {} },
  "cmd.stop": { args: { runId, why: "user" }, result: {} },
  "stop": { args: { epoch: 2 }, result: { ms: 41, late: ["desktop"] } },
  "audit.recent": { args: { limit: 50 }, result: { entries: [{ t: "2026-10-22T12:00:00.000Z", event: "command", phase: "ended", code: 0, classes: ["destroy"], after: { name: "x" } }] } },
  "bye": { args: {}, result: {} },
};

/** A valid example of every event. */
const EVS: { [E in EvName]: EvMap[E] } = {
  "desktop.changed": desktop,
  "cmd.exit": { runId, exit: { code: 0, signal: null, ended: "exit", ms: 1200, error: "", needsConfirm: false, remoteSays: ["x"] }, outBytes: 2048 },
  "console.stop": { at: "2026-10-22T12:00:00.000Z" },
  "policy.changed": admin,
  "notice": { state: "shown" },
  "log": { level: "info", event: "remote.serve_started" },
};

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
/** What a value looks like after crossing the link (JSON). */
const wire = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
/** Every leaf of a JSON value with its path. */
function leaves(v: Json, at: (string | number)[] = []): { at: (string | number)[]; v: Json }[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...at, i]));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => leaves(x, [...at, k]));
  return [{ at, v }];
}
/** Every object (the root included) with its path, except inside free-form records (audit entries). */
function objects(v: Json, at: (string | number)[] = []): (string | number)[][] {
  if (at.includes("entries")) return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => objects(x, [...at, i]));
  if (v && typeof v === "object") return [at, ...Object.entries(v).flatMap(([k, x]) => objects(x, [...at, k]))];
  return [];
}
/** A copy of `v` with `fn` applied at `at`. */
function edit(v: Json, at: (string | number)[], fn: (x: Json) => unknown): unknown {
  const copy = structuredClone(v) as Record<string | number, unknown>;
  if (!at.length) return fn(copy as Json);
  let o = copy;
  for (const k of at.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  o[at[at.length - 1]] = fn(o[at[at.length - 1]] as Json);
  return copy;
}

/** Every check the PC makes of a message (§7.2): the example passes; an extra key, a long string or a non-finite number fails. */
function checkSchema(name: string, schema: z.ZodType<unknown>, example: unknown): void {
  const v = wire(example);
  const ok = schema.safeParse(v);
  expect(ok.success, `${name}: ${ok.success ? "" : JSON.stringify(ok.error.issues.slice(0, 3))}`).toBe(true);
  for (const at of objects(v)) {
    expect(schema.safeParse(edit(v, at, o => ({ ...(o as object), sneaky: 1 }))).success, `${name}: extra key at ${at.join(".")}`).toBe(false);
  }
  for (const leaf of leaves(v)) {
    if (typeof leaf.v === "string") {
      expect(schema.safeParse(edit(v, leaf.at, () => "x".repeat(100_000))).success, `${name}: long string at ${leaf.at.join(".")}`).toBe(false);
    }
    if (typeof leaf.v === "number") {
      for (const bad of [Infinity, -Infinity, NaN]) {
        expect(schema.safeParse(edit(v, leaf.at, () => bad)).success, `${name}: ${bad} at ${leaf.at.join(".")}`).toBe(false);
      }
    }
  }
}

describe("the protocol's schemas", () => {
  it("has a schema for every op and event, and nothing else", () => {
    expect(Object.keys(OP_SCHEMAS).sort()).toEqual(Object.keys(OPS).sort());
    expect(Object.keys(EV_SCHEMAS).sort()).toEqual(Object.keys(EVS).sort());
  });

  for (const op of Object.keys(OPS) as Op[]) {
    it(`checks ${op}'s arguments and result`, () => {
      checkSchema(`${op} args`, OP_SCHEMAS[op].args as z.ZodType<unknown>, OPS[op].args);
      checkSchema(`${op} result`, OP_SCHEMAS[op].result as z.ZodType<unknown>, OPS[op].result);
    });
  }

  for (const ev of Object.keys(EVS) as EvName[]) {
    it(`checks the ${ev} event`, () => checkSchema(ev, EV_SCHEMAS[ev] as z.ZodType<unknown>, EVS[ev]));
  }

  it("holds lists to CAPS", () => {
    const tooMany = <T>(x: T, n: number) => Array.from({ length: n + 1 }, () => x);
    expect(OP_SCHEMAS["perceive.focused"].result.safeParse(wire({ ...seen, nodes: tooMany(seen.nodes[0], CAPS.nodes) })).success).toBe(false);
    expect(OP_SCHEMAS["cmd.inspect"].args.safeParse({ paths: tooMany("/a", CAPS.paths), cwd: "/" }).success).toBe(false);
    expect(OP_SCHEMAS["perceive.windows"].result.safeParse(wire({ windows: tooMany(window, CAPS.windows) })).success).toBe(false);
    expect(OP_SCHEMAS["audit.recent"].args.safeParse({ limit: CAPS.auditEntries + 1 }).success).toBe(false);
    expect(OP_SCHEMAS["perceive.read"].result.safeParse(wire({ ...seen, window: { ...window, bounds: { ...bounds, x: CAPS.coord + 1 } } })).success).toBe(false);
    expect(OP_SCHEMAS["cmd.input"].args.safeParse({ runId, data: "A".repeat(5468) }).success).toBe(false);
    // 4 KiB decoded at most: 4096 bytes pass; the longest text the length cap allows (4098 bytes) doesn't.
    expect(OP_SCHEMAS["cmd.input"].args.safeParse({ runId, data: Buffer.alloc(4096, 7).toString("base64") }).success).toBe(true);
    expect(OP_SCHEMAS["cmd.input"].args.safeParse({ runId, data: Buffer.alloc(4097, 7).toString("base64") }).success).toBe(false);
    expect(OP_SCHEMAS["cmd.input"].args.safeParse({ runId, data: "A".repeat(5464) }).success).toBe(false);
    expect(OP_SCHEMAS["cmd.input"].args.safeParse({ runId, data: "not base64!" }).success).toBe(false);
  });

  it("rejects a value outside its set (an unknown kind, shell, class or status)", () => {
    expect(OP_SCHEMAS.act.args.safeParse(wire({ ...OPS.act.args, stamp: { ...stamp, kind: "delete_everything" } })).success).toBe(false);
    expect(OP_SCHEMAS["cmd.run"].args.safeParse(wire({ epoch: 1, spec: { ...spec, shell: "fish" } })).success).toBe(false);
    expect(OP_SCHEMAS["cmd.run"].args.safeParse(wire({ epoch: 1, spec: { ...spec, stamp: { ...spec.stamp, classes: ["harmless"] } } })).success).toBe(false);
    expect(OP_SCHEMAS.act.result.safeParse({ status: "approved" }).success).toBe(false);
    expect(OP_SCHEMAS.hello.args.safeParse(wire({ ...hello, proto: 2 })).success).toBe(false);
    expect(OP_SCHEMAS.hello.result.safeParse(wire({ ...welcome, os: "freebsd" })).success).toBe(false);
  });

  it("carries the runner's own process names as literal names, never as a pattern", () => {
    const parsed = OP_SCHEMAS["cmd.facts"].result.parse(wire(facts));
    const names = parsed.ember.names;
    expect(names.test("ember-remote")).toBe(true);
    expect(names.test("EMBER_ATSPI.PY")).toBe(true);
    expect(names.test("ember_atspiXpy")).toBe(false);
    expect(names.test("ember-remote2")).toBe(false);
    expect(wire(names)).toEqual({ names: ["ember-remote", "ember_atspi.py"] });
    // After a worker thread's structured clone (which drops toJSON) the names still check out and serialise again.
    expect(wire(OP_SCHEMAS["cmd.facts"].result.parse({ ...facts, ember: { ...facts.ember, names: structuredClone(names) } }).ember.names)).toEqual({ names: ["ember-remote", "ember_atspi.py"] });
    // A pattern from anywhere else never passes: not from the wire, not in this process.
    for (const bad of [{ names: ["(a+)+$"] }, { source: "(a+)+$", flags: "" }, {}]) {
      expect(OP_SCHEMAS["cmd.facts"].result.safeParse({ ...wire(facts) as object, ember: { paths: [], pids: [], names: bad } }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(OP_SCHEMAS["cmd.facts"].result.safeParse({ ...facts, ember: { ...facts.ember, names: /(a+)+$/ } }).success).toBe(false);
    expect(() => emberNamesRegExp(["a|b"])).toThrow();
    expect(wire(emberNamesRegExp([]))).toEqual({ names: [] });
    expect(emberNamesRegExp([]).test("")).toBe(false);
  });
});

// ─────────────── The fixed launcher texts ───────────────

const BODIES = [
  posixBody({ pty: true, from: "env" }), posixBody({ pty: false, from: "env" }),
  posixBody({ pty: true, from: "b64" }), posixBody({ pty: false, from: "b64" }),
];
const INNERS = (["bash", "zsh", "sh"] as const).flatMap(sh => (["env", "b64"] as const).map(from => posixInner(sh, `/usr/bin/${sh}`, from)));

describe("the fixed launcher texts (§3.3)", () => {
  it("has no single quote, tab, line break or run of spaces in the prelude and bodies", () => {
    for (const t of [POSIX_PRELUDE, ...BODIES]) {
      expect(t, t).not.toMatch(/['\t\n\r]| {2}/);
    }
  });

  it("has only posixInner's two fixed single quotes around its -c text", () => {
    for (const t of INNERS) {
      expect(t.split("'").length - 1, t).toBe(2);
      expect(t, t).toMatch(/^exec \/usr\/bin\/(bash|zsh|sh) (--noprofile --norc |-f )?-c '[^']+'$/);
      expect(t, t).not.toMatch(/[\t\n\r]| {2}/);
    }
    expect(posixInner("sh", "/bin/sh", "env")).toBe(`exec /bin/sh -c '${posixBody({ pty: true, from: "env" })}'`);
    expect(NO_RC).toEqual({ bash: ["--noprofile", "--norc"], zsh: ["-f"], sh: [] });
  });

  it("survives WSL_EVAL's split and re-join unchanged (every EMBER_INNER value)", () => {
    for (const t of [...INNERS, posixBody({ pty: false, from: "b64" })]) expect(t.split(/[ \t\n]+/).join(" ")).toBe(t);
    expect(WSL_EVAL).toBe("set -f; eval $EMBER_INNER");
    expect(WSL_EVAL).not.toMatch(/['"\\]/);
  });

  it("reads the command, unsets it, sizes the PTY and evals it, in that order", () => {
    expect(posixBody({ pty: true, from: "env" })).toBe(`${POSIX_PRELUDE}; c=$EMBER_CMD; unset EMBER_CMD; unset BASH_ENV ENV; stty cols "$EMBER_COLS" rows "$EMBER_ROWS" 2>/dev/null; unset EMBER_COLS EMBER_ROWS; eval "$c"`);
    expect(posixBody({ pty: false, from: "b64" })).toBe(`${POSIX_PRELUDE}; c=$(printf %s "$EMBER_CMD_B64" | base64 -d) || exit 126; unset EMBER_CMD_B64; unset BASH_ENV ENV; eval "$c"`);
    expect(POSIX_PRELUDE).toBe('set +f; export PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat MANPAGER=cat; [ -n "$LANG" ] || export LANG=C.UTF-8; printf "\\033]777;ember-start\\007"');
  });

  it("pins PowerShell's launcher exactly", () => {
    expect(PS_INNER).toBe(
      "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; $OutputEncoding = New-Object Text.UTF8Encoding $false }; " +
      "$s = [ScriptBlock]::Create($env:EMBER_CMD); Remove-Item Env:\\EMBER_CMD -ErrorAction SilentlyContinue; " +
      "$global:LASTEXITCODE = 0; & $s; $ok = $?; $c = $LASTEXITCODE; if ($c) { exit $c } elseif (-not $ok) { exit 1 }",
    );
  });
});

// ─────────────── The stubs keep today's behaviour ───────────────

const hands: Hands = {
  perception: {} as PerceptionPort, sidecar: {} as SidecarPort, policy: {} as Hands["policy"], audit: {} as Hands["audit"],
  confirmer: {} as Hands["confirmer"], flyTo: () => undefined, currentWindow: () => null,
};
const sys = { os: "linux" } as SystemPlatform;
const deps = (localHands: Hands | null) => ({ os: "linux", sys, localHands } as unknown as TargetsDeps);

describe("the targets runtime stub (local only)", () => {
  it("gives today's local hands, with no commands, local grant keys and unchanged lease keys", () => {
    const t = createTargets(deps(hands));
    const got = t.agent.handsFor("local");
    if (!got.ok) throw new Error(got.why);
    for (const k of Object.keys(hands) as (keyof Hands)[]) expect(got.hands[k]).toBe(hands[k]);
    expect(got.hands.commands).toBeNull();
    expect(got.hands.system).toBe(sys);
    expect(got.hands.binding).toEqual({ id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "screen" });
    expect(got.hands.grantKey("GEdit")).toBe("gedit");
    expect(got.hands.leaseKey("100:notes")).toBe("100:notes");
    expect(got.hands.onAuthorized).toBeUndefined();
  });

  it("promises nothing new: caps off, no active line, no menu, no question panels, nothing to stop", async () => {
    const t = createTargets(deps(hands));
    expect(t.agent.active).toBe("local");
    expect(t.agent.caps()).toEqual({ commands: false, targets: false });
    expect(t.agent.activeLine()).toBe("");
    expect(t.agent.describeScreen("local")).toBeNull();
    expect(t.wsl).toBeNull();
    expect(t.menuItems()).toEqual([]);
    expect(t.bubbleAction("ui:cmdstop:0123456789abcdef")).toBe(false);
    expect(t.quickContext()).toBeNull();
    expect(t.panelReady(1)).toBe(false);
    expect(t.questionWords({ title: "May I?", prompt: "x", options: [] } as unknown as Parameters<typeof t.questionWords>[0])).toBeNull();
    expect(t.busy()).toEqual({ commands: 0, connections: 0 });
    expect(t.summaries()).toEqual([{ id: "local", kind: "local", label: "This computer", state: "ready", can: "apps", active: true }]);
    await expect(t.stopAll()).resolves.toBeUndefined();
    await expect(t.doctorRows()).resolves.toEqual([]);
    await expect(targetDoctorRows({ os: "linux", sys, admin: () => loaded(null), resourcesPath: "/opt/ember/resources", packaged: true })).resolves.toEqual([]);
  });

  it("binds every task here, and refuses other computers and a computer the user didn't name", () => {
    const t = createTargets(deps(hands));
    const bound = t.agent.bind({ userWords: "open gedit" });
    expect(bound.ok && bound.binding.id).toBe("local");
    expect(t.agent.bind({ userWords: "on this computer", choice: "This computer" }).ok).toBe(true);
    expect(t.agent.bind({ userWords: "open gedit", choice: "build-01" })).toEqual({ ok: false, why: "The user didn't name that computer. Use the one they chose, or ask them." });
    expect(t.agent.handsFor("ssh:build-01").ok).toBe(false);
    expect(t.agent.handsFor("wsl:Ubuntu").ok).toBe(false);
    expect(createTargets(deps(null)).agent.handsFor("local").ok).toBe(false);
  });
});

describe("the other stubs", () => {
  it("change nothing they wrap and add no rule", () => {
    const base = {} as AtspiSidecar;
    const o = {} as WrapForWslOptions;
    expect(wrapForWsl(base, o)).toBe(base);
    const ws = {} as Parameters<typeof wrapWindowsForWsl>[0];
    expect(wrapWindowsForWsl(ws, o)).toBe(ws);
    const privacy = { isSecurityWindow: () => false, isTerminalApp: () => false };
    expect(wslAwarePrivacy(privacy)).toBe(privacy);
    expect(wslAwareSystem(sys)).toBe(sys);
    expect(targetRules({} as ActionRequest, "win32")).toBeNull();
    expect(createWsl({ log: {} as never, env: {}, os: "win32", ember: { winPaths: [] }, jobHost: null })).toBeNull();
  });

  it("run, show and connect nothing, and fail closed", async () => {
    const runner = createLocalRunner({ log: {} as never, os: "linux", env: {}, ember: { paths: [], pids: () => [], names: /ember/ }, home: "/home/ana", user: "ana", elevated: () => false, extraPath: [], jobHost: null });
    await expect(runner.facts()).rejects.toThrow("not built");
    await expect(runner.inspect(["/a", "/b"], "/")).resolves.toEqual([{ exists: null, real: null }, { exists: null, real: null }]);
    await expect(runner.start(spec).done).resolves.toMatchObject({ ended: "failed-to-start" });
    const win = createCommandWindowPort({ create: () => { throw new Error("no window"); }, ipc: {} as never, log: {} as never, os: "linux", keyHint: () => null });
    expect(win.cardReady(1)).toBe(false);
    await expect(win.announce({} as never, 4000, new AbortController().signal)).resolves.toBe(false);
    const prompts = createPromptWindow({ create: () => { throw new Error("no window"); }, ipc: {} as never, log: {} as never, os: "linux" });
    await expect(prompts.ask({ id: "p1", kind: "touch", host: "build-01" })).resolves.toEqual({ id: "p1", ok: false });
    expect(prompts.consentReady(1)).toBe(false);
    // Package AG built carried.ts and flow.ts (command-flow.test.ts): nothing read carries nothing; a stopped task runs nothing.
    expect(carriedText("echo hi", [], "say hi", "linux")).toBeNull();
    await expect(runCommandTool({ target: "This computer", command: "ls", why: "list" }, { isOver: () => true } as CommandFlowContext)).resolves.toMatchObject({ resultType: "denied" });
    const conns = createConnections({} as Parameters<typeof createConnections>[0]);
    await expect(conns.connect(HostRecordSchema.parse(host()), { interactive: true })).rejects.toBeInstanceOf(ConnectError);
    expect(conns.link("build-01")).toBeNull();
    expect(() => createMux({} as Parameters<typeof createMux>[0])).toThrow();
    expect(() => remoteTargetParts({} as never, {} as never)).toThrow();
    await expect(captureRect({ capture: () => null }, bounds)).rejects.toThrow();
  });
});
