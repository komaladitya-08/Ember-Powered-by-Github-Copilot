/**
 * Command classes that ran unasked in round eleven's re-rate (commands-remote-r11-*, -c11-*): each test is a table of
 * spellings of one class, with neighbours of each example, and the plain lines beside them that still run. Pure
 * classifier and decision; no Electron. What needs a file the task wrote is in command-flow.test.ts ("programs that run
 * what they are given").
 */

import { describe, expect, it } from "vitest";
import { runCase, type ContextName } from "../fixtures/commands/corpus";
import type { ShellId } from "../../app/main/commands/types";
import { optIs, parseOpts, has, values } from "../../app/main/commands/words";
import { lit } from "../../app/main/commands/words";
import { keptQuestion } from "../../app/main/commands/autopilot";
import { notReviewable } from "../../app/main/commands/review";
import { UNRESOLVED_TARGET_RULE } from "../../app/main/commands/types";

interface Opts { words?: string; shell?: ShellId; context?: ContextName; downloaded?: string[]; missing?: string[] }
const result = (cmd: string, o: Opts = {}) =>
  runCase({ cmd, verdict: "run", ...(o.words ? { words: o.words } : {}), ...(o.downloaded ? { downloaded: o.downloaded } : {}), ...(o.missing ? { missing: o.missing } : {}) },
    { shell: o.shell ?? "bash", context: o.context ?? "linux" });
const decide = (cmd: string, o: Opts = {}) => result(cmd, o).decision;

describe("a long option written whole that is a prefix of another (commands-remote-r11-2)", () => {
  it("reads curl's --output as the file it saves, never as --output-dir too", () => {
    for (const [cmd, file] of [
      ["curl --output a.py https://x.example/a", "/home/ana/proj/a.py"], ["curl -s https://x.example/a --output a.py", "/home/ana/proj/a.py"],
      ["curl -fsSL --output notes.txt https://x.example/n", "/home/ana/proj/notes.txt"], ["curl --output ~/.bashrc https://x.example/a", "/home/ana/.bashrc"],
      ["curl --output=report.pdf https://x.example/r", "/home/ana/proj/report.pdf"], ["curl --output-dir d --output a.py https://x.example/a", "/home/ana/proj/d/a.py"],
    ] as const) {
      const r = result(cmd);
      expect(r.cls.downloads, cmd).toEqual([file]);
      expect(r.decision.verdict, cmd).toBe("ask");
      expect(r.decision.rules, cmd).toContain("download.output");
      expect(r.decision.reason, cmd).not.toMatch(/\.py\/|\.txt\/|\.pdf\/|bashrc\//);
    }
    // A new file runs as before; running what it saved asks.
    for (const cmd of ["curl --output a.py https://x.example/a", "curl -o a.py https://x.example/a"]) expect(decide(cmd, { missing: ["/home/ana/proj/a.py"] }).verdict, cmd).toBe("run");
    for (const cmd of ["python3 a.py", "bash a.py", "./a.py"]) expect(decide(cmd, { downloaded: ["/home/ana/proj/a.py"] }).rules, cmd).toContain("escape.run-downloaded");
  });

  it("takes a name the table knows whole as that option only, and an abbreviation as any option it may be", () => {
    const p = parseOpts([lit("--output"), lit("a"), lit("--trace"), lit("t"), lit("--prox"), lit("x")], { longValue: ["output", "output-dir", "trace", "trace-ascii", "proxy", "proxy-user"] });
    expect(values(p, "output-dir")).toEqual([]);
    expect(values(p, "output")).toEqual(["a"]);
    expect(values(p, "trace-ascii")).toEqual([]);
    expect(has(p, "trace")).toBe(true);
    expect(optIs("--output", "output-dir", p.long)).toBe(false);
    // An abbreviation of no name the table knows whole still counts as each name it may stand for.
    expect(optIs("--outp", "output-dir", p.long)).toBe(true);
    expect(optIs("--outp", "output", p.long)).toBe(true);
    // Without a table, as before.
    expect(optIs("--output", "output-dir")).toBe(true);
  });

  it("still reads a proxy's password, as main read --proxy by --proxy-user's prefix", () => {
    for (const cmd of ["curl --proxy http://u:pw@proxy:3128 https://x.example", "curl --proxy-user u:pw https://x.example"]) expect(decide(cmd).rules, cmd).toContain("secret.token-arg");
  });
});

describe("output that is a secret by where it comes from (commands-remote-r11-4)", () => {
  it("asks before reading a container's, a service's or a cluster's mounted secrets, in every mode", () => {
    for (const cmd of [
      "cat /run/secrets/db_password", "cat /run/secrets/postgres_password", "cat /var/run/secrets/kubernetes.io/serviceaccount/token", "head -c 100 /run/secrets/x",
      "cat /run/credentials/app.service/db", "base64 /run/secrets/db", "cp /run/secrets/db /tmp/x", "tar czf - /run/secrets", "grep . /run/secrets/*",
      "cat /etc/kubernetes/admin.conf", "cat /etc/rancher/k3s/k3s.yaml", "cat /var/lib/rancher/k3s/server/token", "cat /vault/secrets/config", "cat /etc/ssl/private/site.key",
      "less /etc/credstore/db", "xxd /run/keys/x",
    ]) {
      const r = result(cmd);
      expect(r.decision.verdict, cmd).toBe("ask");
      expect(r.decision.rules, cmd).toContain("path.secret");
      expect(keptQuestion(r.decision, r.cls.findings), cmd).toBe("secret");
    }
    expect(decide("Get-Content C:\\ProgramData\\Docker\\secrets\\db", { shell: "powershell", context: "win32" }).rules).toContain("path.secret");
    // Listing the folder still runs.
    for (const cmd of ["ls /run/secrets", "ls -la /var/run/secrets/kubernetes.io/serviceaccount"]) expect(decide(cmd).verdict, cmd).toBe("run");
  });

  it("asks before redis-cli prints a password, a pattern of settings, its users or a key named like a secret", () => {
    for (const cmd of [
      "redis-cli CONFIG GET requirepass", "redis-cli -h prod CONFIG GET '*'", "redis-cli config get masterauth", "redis-cli CONFIG GET '*pass*'", "redis-cli CONFIG GET tls-key-file-pass",
      "redis-cli CONFIG GET maxmemory requirepass", "redis-cli ACL LIST", "redis-cli ACL GETUSER default", "redis-cli AUTH hunter2 PING", "redis-cli HELLO 3 AUTH default hunter2",
      "redis-cli GET api_token", "redis-cli GET session:abc", "redis-cli HGETALL user:1:credentials", "redis-cli MGET a db_password", "redis-cli GET \"$KEY\"",
    ]) {
      const r = result(cmd);
      expect(r.decision.verdict, cmd).toBe("ask");
      expect(r.decision.rules, cmd).toContain("secret.db");
      expect(keptQuestion(r.decision, r.cls.findings), cmd).toBe("secret");
    }
    // Ordinary reads still run.
    for (const cmd of ["redis-cli PING", "redis-cli GET counter", "redis-cli CONFIG GET maxmemory", "redis-cli INFO"]) {
      expect(decide(cmd).verdict, cmd).toBe("run");
    }
  });
});

describe("redis-cli's ACL, decided no less safely than on main (commands-remote-r11-4)", () => {
  it("asks before every ACL verb as a change, as main did, and as a secret where it prints passwords", () => {
    for (const cmd of ["redis-cli ACL WHOAMI", "redis-cli ACL USERS", "redis-cli ACL LIST", "redis-cli ACL GETUSER default", "redis-cli ACL CAT"]) {
      const d = decide(cmd);
      expect(d.verdict, cmd).toBe("ask");
      expect(d.rules, cmd).toContain("db.change");
    }
    for (const cmd of ["redis-cli ACL LIST", "redis-cli ACL GETUSER default"]) expect(decide(cmd).rules, cmd).toContain("secret.db");
  });
});

describe("Windows certutil's file verbs (commands-remote-c11-1)", () => {
  const PS = { shell: "powershell" as const, context: "win32" as const };
  const CMD = { shell: "cmd" as const, context: "win32" as const };

  it("asks before it encodes or dumps a secret, overwrites a file or writes to a share, as copy does", () => {
    for (const [cmd, rule, o] of [
      ["certutil -encode ~\\.ssh\\id_rsa out.txt", "path.secret", PS], ["certutil -encodehex ~\\.ssh\\id_rsa out.txt", "path.secret", PS],
      ["certutil -dump ~\\.ssh\\id_rsa", "path.secret", PS], ["certutil -encode C:\\Users\\ana\\.aws\\credentials o.txt", "path.secret", PS],
      ["certutil -encode %USERPROFILE%\\.ssh\\id_rsa o.txt", "path.secret", CMD], ["certutil /encode %USERPROFILE%\\.ssh\\id_rsa o.txt", "path.secret", CMD],
      ["certutil -f -decode in.b64 report.docx", "certutil.output", PS], ["certutil -decodehex in.hex report.docx", "certutil.output", PS],
      ["certutil -f -decode in.b64 ~\\Documents\\old\\a.docx", "certutil.output", PS], ["certutil -encode report.docx \\\\x.example\\share\\r.txt", "upload.unc", PS],
      ["certutil -v -encode ~\\.ssh\\id_rsa o.txt", "path.secret", PS], ["certutil -decode in.b64 /tmp/x", "certutil.output", PS], ["certutil -decode in.b64 /Users/ana/Documents/a.docx", "certutil.output", PS],
      ["certutil -encode -zz a.txt ~\\.ssh\\id_rsa", "path.secret", PS],
    ] as const) {
      const d = decide(cmd, o);
      expect(d.verdict, cmd).toBe("ask");
      expect(d.rules, cmd).toContain(rule);
    }
    // Hashing, listing a store and encoding into a new file still run.
    for (const cmd of ["certutil -hashfile a.zip SHA256", "certutil -store my", "certutil -encode a.txt b.txt"]) expect(decide(cmd, { ...PS, missing: ["C:\\Users\\ana\\proj\\b.txt"] }).verdict, cmd).toBe("run");
  });

  it.each<[string, string]>([
    ["certutil -exportPVK My 01 out", "secret"], ["certutil -recoverKey 01 out.pfx", "secret"], ["certutil -MergePFX a.pfx,b.pfx out.pfx", "secret"],
    ["certutil -ConvertEPF a.pfx out.epf", "secret"], ["certutil -delkey MyKey", "destroy"], ["certutil -dspublish -f a.cer RootCA", "system"],
    ["certutil -ImportCert a.cer", "system"], ["certutil -installcert a.cer", "system"], ["certutil /delkey MyKey", "destroy"],
  ])("asks before %s, which exports or deletes a key or changes what is trusted (r11-commands-y11-5)", (cmd, cls) => {
    for (const o of [PS, CMD]) {
      const d = decide(cmd, o);
      expect(d.verdict, cmd).toBe("ask");
      expect(d.classes, cmd).toContain(cls);
    }
  });
});

describe("tar's -C before what it packs, and cpio's names from its input (commands-remote-c11-2)", () => {
  it("judges what tar packs under the -C before it, so a secret folder asks and Ember's own is refused", () => {
    for (const cmd of [
      "tar -C ~ -cf - .ssh", "tar czf - -C ~ .ssh", "tar -C ~ -cf - .aws", "tar -C ~ -cf - .gnupg", "tar -C ~ -cf - .config/gh", "tar -C ~/.ssh -cf - .",
      "tar -C ~/.ssh -cf - ./", "tar --directory ~ -czf - .ssh", "tar --directory=/home/ana -cf - .ssh", "tar -cf a.tar -C build out -C ~ .aws", "tar -C / -cf - home/ana/.ssh",
      "tar -C ~ -C .ssh -cf - .", "gtar -C ~ -cf - .ssh", "bsdtar -C ~ -cf - .ssh", "tar -C ~ -cf - ./.ssh", "tar -C /run -cf - secrets",
    ]) {
      const d = decide(cmd);
      expect(d.verdict, cmd).toBe("ask");
      expect(d.rules, cmd).toContain("path.secret");
    }
    for (const cmd of ["bsdtar -C ~/.config -cf - ember", "tar -C ~ -cf - .config/ember/audit", "tar -C ~/.config -czf - ember", "tar --directory ~/.config -cf /tmp/x ember --remove-files"]) {
      expect(result(cmd).cls.refuse?.rule, cmd).toBe("ember.path");
    }
    // A folder or a member Ember can't see asks; the project's own packing runs.
    for (const cmd of ["tar -C \"$D\" -cf - x", "tar -cf - \"$X\""]) expect(decide(cmd).rules, cmd).toContain("unclear.unresolved-arg");
    for (const cmd of ["tar -C build -czf out.tgz .", "tar czf x.tgz src", "tar -C dist -cf - ."]) { const d = decide(cmd, { missing: ["/home/ana/proj/out.tgz", "/home/ana/proj/x.tgz"] }); expect(d.verdict, `${cmd} ${d.rules}`).toBe("run"); }
  });

  it("judges the names cpio packs from its input, and asks when it can't see them", () => {
    for (const cmd of ["cpio -o <<< ~/.ssh/id_rsa", "echo ~/.ssh/id_rsa | cpio -o", "printf '%s\\n' ~/.aws/credentials | cpio -ov > x.cpio", "echo ~/.ssh/id_rsa | cpio -pd /tmp/x"]) {
      expect(decide(cmd).rules, cmd).toContain("path.secret");
    }
    expect(decide("find . -name '*.c' | cpio -o > x.cpio").rules).toContain("unclear.unresolved-arg");
  });
});

describe("a deletion or a write of something Ember can't name (commands-remote-c11-3)", () => {
  const UNNAMED = [
    "rm -rf \"$X\"", "rm -rf $(cat dirs.txt)", "rm -rf ${D}/*", "find \"$D\" -delete", "truncate -s0 \"$F\"", "echo > \"$LOG\"", "cp a.txt \"$OUT\"",
    "mv x \"$(dirname \"$P\")/y\"", "shred -u ~bob/x",
  ];
  it("is judged as if it could be Ember's own records: it asks, even when the user's words ask to delete, and no check may clear it", () => {
    for (const cmd of UNNAMED) {
      for (const words of ["", "delete the folder", "clear the log file"]) {
        const r = result(cmd, { words });
        expect(r.decision.verdict, `${cmd} / ${words}`).toBe("ask");
        expect(r.decision.rules, cmd).toContain(UNRESOLVED_TARGET_RULE);
        expect(notReviewable(r.decision, { words: words || "tidy up", mode: "on", askEvery: null, userAskEvery: false, command: cmd, findings: r.cls.findings }), cmd).toBe("it changes something Ember can't name");
      }
    }
    for (const cmd of ["Remove-Item $p -Recurse", "Set-Content $f x"]) expect(decide(cmd, { shell: "powershell", context: "win32" }).rules, cmd).toContain(UNRESOLVED_TARGET_RULE);
    // A deletion Ember can name is judged as before.
    for (const cmd of ["rm -rf build", "echo hi > out.txt"]) expect(decide(cmd).rules, cmd).not.toContain(UNRESOLVED_TARGET_RULE);
  });
});

describe("an option or a verb Ember doesn't know is said by name, never taken for a danger (commands-remote-r11-3, -c11-1; the owner's decision of 2026-11-14)", () => {
  it("names sqlite3's, duckdb's and certutil's unlisted options and verbs as unknown, and still judges what follows them", () => {
    for (const [cmd, rule, o] of [
      ["sqlite3 -frob a.db .tables", "unknown.option", {}], ["duckdb -zz a.db", "unknown.option", {}], ["duckdb -frobnicate app.db", "unknown.option", {}],
      ["certutil -frobnicate x", "unknown.verb", { shell: "powershell", context: "win32" }], ["certutil -hashfile -zz a.zip", "unknown.option", { shell: "powershell", context: "win32" }],
    ] as [string, string, Opts][]) {
      const d = decide(cmd, o);
      expect(d.rules, cmd).toContain(rule);
      expect(d.rules.filter(r => r.startsWith("unclear.")), cmd).toEqual([]);
    }
    // sqlite3's archive mode is a write, whatever spelling.
    for (const cmd of ["sqlite3 app.sqlar -Ax", "sqlite3 -A app.sqlar -x", "sqlite3 --archive app.sqlar", "sqlite3 -Acf a.sqlar src"]) expect(decide(cmd).classes, cmd).toContain("destroy");
  });
});

describe("git's plumbing and submodules that throw away work not committed (commands-remote-c11-4)", () => {
  it("asks before read-tree's reset or update, checkout-index's force and a forced submodule deinit or update", () => {
    for (const cmd of ["git read-tree -u --reset HEAD", "git read-tree --reset HEAD", "git read-tree -mu HEAD", "git read-tree -u -m HEAD~1", "git checkout-index -a -f",
      "git checkout-index --all --force", "git checkout-index -f src/a.c", "git submodule deinit -f --all", "git submodule deinit --force lib", "git submodule update -f",
      "git submodule update --init --force", "git -C sub read-tree --reset -u HEAD"]) {
      const d = decide(cmd);
      expect(d.verdict, cmd).toBe("ask");
      expect(d.classes, cmd).toContain("destroy");
    }
    for (const cmd of ["git read-tree HEAD", "git checkout-index -a --prefix=out/", "git submodule deinit lib", "git submodule update --init"]) {
      expect(decide(cmd, { missing: ["/home/ana/proj/out"] }).rules, cmd).not.toContain("git.discard");
    }
  });
});

describe("a workload's manifest or helm's values written out whole (commands-remote-y10-7)", () => {
  it("files them as secrets, so Interactive asks and Autopilot keeps the output from the model", () => {
    for (const cmd of ["kubectl get deploy x -o yaml", "kubectl get pod web -o json", "kubectl get cm app -o yaml", "kubectl get deployment/x -oyaml", "oc get sts db -o yaml",
      "kubectl -n prod get configmap app --output=json", "kubectl get cronjob backup -o jsonpath='{.spec}'", "helm get values x -a", "helm get values x --all", "helm get all x", "helm get manifest x"]) {
      const r = result(cmd);
      expect(r.decision.verdict, cmd).toBe("ask");
      expect(keptQuestion(r.decision, r.cls.findings), cmd).toBe("secret");
    }
    for (const cmd of ["kubectl get pods", "kubectl get deploy -o wide", "helm get values x", "kubectl get svc x -o yaml"]) expect(decide(cmd).classes, cmd).not.toContain("secret");
  });
});

describe("a program Ember doesn't know, after the user's words against it (r11-commands-x11-1)", () => {
  it("asks, saying they didn't ask for it, where their words name it and say not to; announces it otherwise", () => {
    for (const [cmd, words] of [
      ["frobtool build", "Don't run frobtool."], ["frobtool build --all", "tidy up, never use frobtool"], ["cargo frobnicate", "Build it, but don't run cargo frobnicate."],
      ["/opt/tools/frobtool build", "no frobtool please"], ["cargo frobnicate --release", "do not run cargo frobnicate"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.verdict, `${cmd} / ${words}`).toBe("ask");
      expect(d.says, `${cmd} / ${words}`).toContain("You didn't ask for this.");
    }
    for (const [cmd, words] of [["frobtool build", "run frobtool"], ["frobtool build", "don't push, build it with frobtool"], ["cargo frobnicate", "don't run cargo build, run cargo frobnicate"], ["frobtool build", ""]]) {
      expect(decide(cmd, { words }).verdict, `${cmd} / ${words}`).toBe("announce");
    }
  });
});
