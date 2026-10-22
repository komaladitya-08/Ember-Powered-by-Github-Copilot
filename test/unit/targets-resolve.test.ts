/**
 * Which computer the user's own words name (§2.3, targets/resolve.ts): one normalisation for names and requests (NFKC,
 * lower case, spoken numbers, letters and digits only), whole-word runs, place words, this computer's fixed words per
 * OS, WSL's words, and binding a task (two computers refused, the model's choice only when the user named it too).
 */

import { describe, expect, it } from "vitest";
import { NOT_NAMED, TWO_NAMED, WSL_WORDS, bindTarget, namedAnywhere, normaliseName, targetOfChoice, targetsNamed, type NamedTarget } from "../../app/main/targets/resolve";

const local: NamedTarget = { id: "local", names: ["This computer"] };
const build: NamedTarget = { id: "ssh:build-01", names: ["build-01", "build-01.example.com"] };
const ubuntu: NamedTarget = { id: "wsl:Ubuntu", names: ["Ubuntu", "Ubuntu (WSL)", ...WSL_WORDS] };
const debian: NamedTarget = { id: "wsl:Debian", names: ["Debian", "Debian (WSL)"] };
const all = [local, build, ubuntu, debian];

describe("normaliseName", () => {
  it("folds case, compatibility forms, punctuation and spoken numbers into one run", () => {
    expect(normaliseName("build-01")).toBe("build01");
    expect(normaliseName("Build 01")).toBe("build01");
    expect(normaliseName("build zero one")).toBe("build01");
    expect(normaliseName("ＢＵＩＬＤ－０１")).toBe("build01");
    expect(normaliseName("Ubuntu-22.04")).toBe("ubuntu2204");
    expect(normaliseName("build twenty")).toBe("build20");
  });
});

describe("targetsNamed", () => {
  it("names a target after a place word, with or without a determiner", () => {
    expect(targetsNamed("on build-01, check the disk", all)).toEqual(["ssh:build-01"]);
    expect(targetsNamed("check the disk on the build-01", all)).toEqual(["ssh:build-01"]);
    expect(targetsNamed("open gedit in Ubuntu", all)).toEqual(["wsl:Ubuntu"]);
    expect(targetsNamed("look inside my debian", all)).toEqual(["wsl:Debian"]);
    expect(targetsNamed("restart nginx via build-01.example.com", all)).toEqual(["ssh:build-01"]);
  });

  it("hears spoken numbers as the name's digits", () => {
    expect(targetsNamed("on build zero one list the logs", all)).toEqual(["ssh:build-01"]);
    expect(targetsNamed("on Build 01 list the logs", all)).toEqual(["ssh:build-01"]);
  });

  it("names a target as the request's first words before a colon or comma, or before 's desktop and the like", () => {
    expect(targetsNamed("build-01: df -h", all)).toEqual(["ssh:build-01"]);
    expect(targetsNamed("Build zero one, how full is the disk?", all)).toEqual(["ssh:build-01"]);
    expect(targetsNamed("what is on build-01's screen", all)).toEqual(["ssh:build-01"]);
    expect(targetsNamed("open a file in build-01’s shell", all)).toEqual(["ssh:build-01"]);
  });

  it("names nothing without a place (the name as a thing, not a place)", () => {
    expect(targetsNamed("Send build-01's report to Ana", all)).toEqual([]);
    expect(targetsNamed("email the build-01 logs to Ana", all)).toEqual([]);
    expect(targetsNamed("build-01 is slow today", all)).toEqual([]);
  });

  it("keeps word boundaries: a name inside a longer word is not named", () => {
    expect(targetsNamed("on rebuild01 do it", all)).toEqual([]);
    expect(targetsNamed("on build-012 do it", all)).toEqual([]);
  });

  it("never matches a name shorter than three characters", () => {
    expect(targetsNamed("on ab do it", [{ id: "ssh:ab", names: ["ab"] }])).toEqual([]);
  });

  it("names this computer by its fixed words, per OS", () => {
    expect(targetsNamed("do it on this computer", all)).toEqual(["local"]);
    expect(targetsNamed("open my laptop's settings", all)).toEqual(["local"]);
    expect(targetsNamed("do it here", all)).toEqual(["local"]);
    expect(targetsNamed("here's what I want: open gedit", all)).toEqual([]);
    expect(targetsNamed("run it locally", all)).toEqual(["local"]);
    expect(targetsNamed("open Notepad on Windows", all, "win32")).toEqual(["local"]);
    expect(targetsNamed("open Notepad on Windows", all, "linux")).toEqual([]);
    expect(targetsNamed("open Notes on my Mac", all, "darwin")).toEqual(["local"]);
  });

  it("names the default distro with WSL's words (rule 5), only as a place", () => {
    expect(targetsNamed("open gedit in WSL", all, "win32")).toEqual(["wsl:Ubuntu"]);
    expect(targetsNamed("list my files in Linux", all, "win32")).toEqual(["wsl:Ubuntu"]);
    expect(targetsNamed("check it on the Linux side", all, "win32")).toEqual(["wsl:Ubuntu"]);
    expect(targetsNamed("what is WSL", all, "win32")).toEqual([]);
  });

  it("lists every target named, once each, in order of appearance", () => {
    expect(targetsNamed("check the disk on build-01 and on this computer", all)).toEqual(["ssh:build-01", "local"]);
    // "from" isn't a place word: copying from a computer names only where the task acts.
    expect(targetsNamed("copy it from build-01 to this computer", all)).toEqual(["local"]);
    expect(targetsNamed("in Debian, then in Ubuntu, then in Debian again", all)).toEqual(["wsl:Debian", "wsl:Ubuntu"]);
  });

  it("never throws on odd input", () => {
    expect(targetsNamed(undefined as unknown as string, all)).toEqual([]);
    expect(targetsNamed("", all)).toEqual([]);
    expect(targetsNamed("on \u0000‮ build-01", all)).toEqual(["ssh:build-01"]);
  });
});

describe("namedAnywhere and targetOfChoice", () => {
  it("finds a name anywhere in the user's words (without the place rule)", () => {
    expect(namedAnywhere("send build-01's report to Ana", build)).toBe(true);
    expect(namedAnywhere("send the report to Ana", build)).toBe(false);
    expect(namedAnywhere("use this pc please", local)).toBe(true);
  });

  it("maps the model's name for a computer to exactly one target", () => {
    expect(targetOfChoice("build-01", all)).toBe("ssh:build-01");
    expect(targetOfChoice("Ubuntu", all)).toBe("wsl:Ubuntu");
    expect(targetOfChoice("this computer", all)).toBe("local");
    expect(targetOfChoice("build", all)).toBeNull();
    expect(targetOfChoice("", all)).toBeNull();
  });
});

describe("bindTarget (§2.3)", () => {
  const bind = (userWords: string, choice?: string, active: NamedTarget["id"] = "local") =>
    bindTarget({ userWords, ...(choice !== undefined ? { choice } : {}), targets: all, active, os: "linux" });

  it("binds to the one target the user's words name, whatever the model chose", () => {
    expect(bind("on build-01, check the disk", "Ubuntu")).toEqual({ ok: true, id: "ssh:build-01" });
  });

  it("refuses two different targets in one request", () => {
    expect(bind("check the disk on build-01 and on this computer")).toEqual({ ok: false, why: TWO_NAMED });
  });

  it("uses the picker's choice when nothing is named and the model chose nothing", () => {
    expect(bind("check the disk", undefined, "wsl:Ubuntu")).toEqual({ ok: true, id: "wsl:Ubuntu" });
  });

  it("takes the model's choice only when the user's words name it too, or it is the picker's", () => {
    expect(bind("send build-01's report to Ana", "build-01")).toEqual({ ok: true, id: "ssh:build-01" });
    expect(bind("open gedit", "build-01")).toEqual({ ok: false, why: NOT_NAMED });
    expect(bind("open gedit", "This computer")).toEqual({ ok: true, id: "local" });
    expect(bind("open gedit", "build-01", "ssh:build-01")).toEqual({ ok: true, id: "ssh:build-01" });
  });

  it("tells the model to offer a connection for a computer the user named that Ember doesn't know", () => {
    const r = bind("open the logs on build-02 please", "build-02");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/offer_connect/);
    expect(bind("open the logs please", "build-02")).toEqual({ ok: false, why: NOT_NAMED });
  });
});
