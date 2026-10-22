/**
 * Which computer the user's own words name (§2.3, targets/resolve.ts): one normalisation for names and requests (NFKC,
 * lower case, spoken numbers, letters and digits only), whole-word runs, place words, this computer's fixed words per
 * OS, WSL's words, and binding a task (two computers refused, the model's choice only when the user named it too).
 */

import { describe, expect, it } from "vitest";
import {
  NOT_NAMED, TWO_NAMED, WSL_WORDS, bindTarget, namedAnywhere, normaliseName, otherTargetsNamed, placesNamed, targetOfChoice, targetsNamed,
  type NamedTarget,
} from "../../app/main/targets/resolve";

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

  it("never moves a task off the picker's computer for a bare \"here\" (the review: a delete announced on the wrong one)", () => {
    const here = [
      "check what's taking space here", "Here is what I need: check the disk usage", "delete build/ here", "what's in here",
      "list the files in here", "Ember, come here and delete build/", "move it over here", "do it here",
    ];
    for (const w of here) {
      expect(targetsNamed(w, all), w).toEqual([]);
      expect(bind(w, undefined, "ssh:build-01"), w).toEqual({ ok: true, id: "ssh:build-01" });
      expect(bind(w, undefined, "wsl:Ubuntu"), w).toEqual({ ok: true, id: "wsl:Ubuntu" });
      expect(bind(w), w).toEqual({ ok: true, id: "local" });
      // The model can't use the word to pick this computer either.
      expect(bind(w, "This computer", "ssh:build-01"), w).toEqual({ ok: false, why: NOT_NAMED });
    }
    // "here" beside a named computer is the folder there, not a second computer.
    expect(bind("on build-01, list the files here")).toEqual({ ok: true, id: "ssh:build-01" });
    expect(bind("delete build/ here on build-01", undefined, "local")).toEqual({ ok: true, id: "ssh:build-01" });
    // This computer's own words still move the task, and still clash with another computer's name.
    expect(bind("delete build/ on this computer", undefined, "ssh:build-01")).toEqual({ ok: true, id: "local" });
    expect(bind("check the disk locally", undefined, "ssh:build-01")).toEqual({ ok: true, id: "local" });
    expect(bind("on build-01, copy the logs to this computer")).toEqual({ ok: false, why: TWO_NAMED });
    expect(namedAnywhere("check what's taking space here", local)).toBe(false);
  });

  it("tells the model to offer a connection for a computer the user named that Ember doesn't know", () => {
    const r = bind("open the logs on build-02 please", "build-02");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/offer_connect/);
    expect(bind("open the logs please", "build-02")).toEqual({ ok: false, why: NOT_NAMED });
  });
});

describe("otherTargetsNamed (D4.4's wrong-target guard)", () => {
  it("finds every other computer the words name anywhere, place word or not", () => {
    expect(otherTargetsNamed("build-01 delete build/", all, "local")).toEqual(["ssh:build-01"]);
    expect(otherTargetsNamed("delete build/ then tell build zero one", all, "local")).toEqual(["ssh:build-01"]);
    expect(otherTargetsNamed("copy it from ubuntu to debian", all, "local")).toEqual(["wsl:Ubuntu", "wsl:Debian"]);
    expect(otherTargetsNamed("on build-01 delete build/", all, "ssh:build-01")).toEqual([]);
  });

  it("names this computer by its fixed words, but not by a bare \"here\"", () => {
    expect(otherTargetsNamed("delete build/ on this computer", all, "ssh:build-01")).toEqual(["local"]);
    expect(otherTargetsNamed("delete build/ locally", all, "ssh:build-01")).toEqual(["local"]);
    expect(otherTargetsNamed("delete build/ here", all, "ssh:build-01")).toEqual([]);
    expect(otherTargetsNamed("delete build/ on this computer", all, "local")).toEqual([]);
  });

  it("keeps word boundaries, and counts names too short to bind (they bind to the active computer instead)", () => {
    expect(otherTargetsNamed("rebuild01 delete build/", all, "local")).toEqual([]);
    const pi: NamedTarget = { id: "ssh:pi", names: ["pi"] };
    expect(bindTarget({ userWords: "delete build/ on pi", targets: [local, pi], active: "local", os: "linux" })).toEqual({ ok: true, id: "local" });
    expect(otherTargetsNamed("delete build/ on pi", [local, pi], "local")).toEqual(["ssh:pi"]);
    expect(otherTargetsNamed("delete build/ on pip", [local, pi], "local")).toEqual([]);
    expect(otherTargetsNamed("delete build/", [local, { id: "ssh:x", names: ["-"] }], "local")).toEqual([]);
  });
});

describe("placesNamed (the lead's ruling: a computer Ember doesn't know, named as a place)", () => {
  it("finds a place word before a name with a dot, a hyphen or a digit, or an ssh-style user@host", () => {
    expect(placesNamed("delete build/ on prod-db", all)).toEqual(["prod-db"]);
    expect(placesNamed("restart nginx at deploy@10.0.0.5", all)).toEqual(["deploy@10.0.0.5"]);
    expect(placesNamed("copy the logs onto web.example.com, then tidy up", all)).toEqual(["web.example.com"]);
    expect(placesNamed("delete build/ on the build-box", all)).toEqual(["build-box"]);
    expect(placesNamed("on prod-db's desktop delete build/", all)).toEqual(["prod-db"]);
    expect(placesNamed("in 10.0.0.5 delete build/", all)).toEqual(["10.0.0.5"]);
    expect(placesNamed("push it into deploy@prod-db:/srv/app", all)).toEqual(["deploy@prod-db:/srv/app"]);
    expect(placesNamed("delete build/ on (prod2).", all)).toEqual(["prod2"]);
    expect(placesNamed("on prod-db and on Prod-DB, delete build/", all)).toEqual(["prod-db"]);
  });

  it("finds the same computer in the other ways a request names one", () => {
    // Rule 3's other place words, and "from" and "ssh".
    for (const w of ["via", "over", "inside", "from"]) expect(placesNamed(`delete build/ ${w} prod-db`, all)).toEqual(["prod-db"]);
    expect(placesNamed("ssh prod-db and delete build/", all)).toEqual(["prod-db"]);
    expect(placesNamed("ssh to prod-db, then delete build/", all)).toEqual(["prod-db"]);
    // A word for a computer between the place word and the name.
    expect(placesNamed("delete build/ on the server prod-db", all)).toEqual(["prod-db"]);
    expect(placesNamed("delete build/ on host 10.0.0.5", all)).toEqual(["10.0.0.5"]);
    // The request's first word before ":" or "," (rule 3), as for a computer Ember knows.
    expect(placesNamed("prod-db: delete build/", all)).toEqual(["prod-db"]);
    expect(placesNamed("deploy@prod-db, delete build/", all)).toEqual(["deploy@prod-db"]);
    // A port or a folder after the host, other dashes, other quotes.
    expect(placesNamed("delete build/ on prod-db:22", all)).toEqual(["prod-db:22"]);
    expect(placesNamed("delete build/ at 10.0.0.5:2222", all)).toEqual(["10.0.0.5:2222"]);
    expect(placesNamed("delete build/ on prod‐db", all)).toEqual(["prod-db"]);
    expect(placesNamed("delete build/ on `prod-db`", all)).toEqual(["prod-db"]);
    expect(placesNamed("delete build/ on «prod-db»", all)).toEqual(["prod-db"]);
    // Known ones stay left out in every form.
    expect(placesNamed("build-01: delete build/", all)).toEqual([]);
    expect(placesNamed("delete build/ on the server build-01:22", all)).toEqual([]);
  });

  it("leaves out every name a known target answers to, the bound one's included", () => {
    expect(placesNamed("delete build/ on build-01", all)).toEqual([]);
    expect(placesNamed("delete build/ on build-01.example.com", all)).toEqual([]);
    expect(placesNamed("delete build/ at ana@build-01", all)).toEqual([]);
    expect(placesNamed("in Ubuntu-22.04 delete build/", [...all, { id: "wsl:Ubuntu-22.04", names: ["Ubuntu-22.04"] }])).toEqual([]);
  });

  it.each([
    "delete build/ on the desktop", "delete the old files in my home folder", "fix the typo on line 12", "delete build/ here",
    "fix the bug in main.ts and delete build/", "write it into notes.md", "delete build/ in 5 minutes", "remind me at 5pm",
    "delete the cache in v1.2", "click the button in the top-right corner", "open it in read-only mode", "delete build/ on 2 files",
    "delete everything in src/app", "delete build/ in ~/proj", "run it on Linux", "delete build/", "",
    "delete the lines from 10-20", "on 2026-10-22, delete build/", "delete files over 10MB", "at 17:30, delete build/",
    "regenerate my ssh keys", "Note: delete build/", "copy it from main.ts", "on the server, delete build/",
  ])("names no computer in %j", words => {
    expect(placesNamed(words, all)).toEqual([]);
  });
});
