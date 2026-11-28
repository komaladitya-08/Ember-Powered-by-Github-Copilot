/**
 * Passwords in lists of arguments (round seven's memory-q6-1, memory-v7-1 and memory-y7-1, ported from the audit-seven
 * branch): every recognised client in any case and with Windows' `.exe`, htpasswd's and `net use`'s own forms, a
 * long MySQL list, and what only says where a password is read from left alone; the list passes run in short steps,
 * the same bytes as their whole-text forms, so Stop keeps its 300 ms over 4 MiB on a machine three times slower.
 */
import { describe, expect, it } from "vitest";
import { LIST_PASS_STEPS, LIST_PASSES_AT_ONCE, LIST_PASSES_WHOLE, REDACT_PASSES, redactSecrets, redactSteps, runSteps, SECRET_HIDDEN } from "../../app/main/commands/redact";
import { memoryRefusal } from "../../app/main/memory/guard";

const PASSWORD = "Summer2024!";

describe("redactSecrets: passwords in lists of arguments", () => {
  it.each([
    `["CMD", "mysqladmin", "ping", "-h", "localhost", "-uroot", "-p${PASSWORD}"]`,
    `subprocess.run(["mysql", "-u", "root", "-p${PASSWORD}"])`,
    `["C:\\\\xampp\\\\mysql\\\\bin\\\\MYSQL.EXE", "-p${PASSWORD}"]`,
    `["mYsQl", "-p${PASSWORD}"]`,
    `["CMD", "mYsQlAdMiN", "ping", "-p${PASSWORD}"]`,
    JSON.stringify(["mysql", ...Array.from({ length: 20 }, (_, i) => `arg-${i}`), `-p${PASSWORD}`]),
    `["Redis-Cli", "-a", "${PASSWORD}"]`,
    `["CURL.EXE", "-u", "ada:${PASSWORD}"]`,
    JSON.stringify(["C:\\Program Files\\Docker\\DOCKER.EXE", "login", "-p", PASSWORD]),
    `["htpasswd", "-nb", "ada", "${PASSWORD}"]`,
    `["htpasswd", "-nbB", "-C", "10", "ada", "${PASSWORD}"]`,
    `["htpasswd", "-b", ".htpasswd", "ada", "${PASSWORD}"]`,
    JSON.stringify(["net", "use", String.raw`\\host\share`, PASSWORD]),
    JSON.stringify(["NET", "USE", "Z:", String.raw`\\host\share`, PASSWORD]),
    JSON.stringify(["net", "use", String.raw`\\host\share`, "/user:ada", PASSWORD]),
  ])("hides the password in %s, which memory refuses (memory-v7-1, memory-y7-1)", text => {
    const out = redactSecrets(text);
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain(SECRET_HIDDEN);
    expect(memoryRefusal(text)).not.toBeNull();
  });

  it.each([
    `["mysql", "-p", "shop"]`,
    `["mysql", "-p$DB_PASS", "shop"]`,
    `["redis-cli", "-a", "$REDIS_PASSWORD", "ping"]`,
    `["docker", "run", "-p", "8080:80", "image"]`,
    `["htpasswd", "-n", "ada"]`,
    `["htpasswd", "-B", ".htpasswd", "ada"]`,
    JSON.stringify(["net", "use", String.raw`\\host\share`, "/persistent:no"]),
    JSON.stringify(["net", "use", String.raw`\\host\share`, "*"]),
    `["openssl", "enc", "-pass", "env:PW"]`,
    `["openssl", "enc", "-pass", "file:pw.txt"]`,
    `["openssl", "enc", "-pass", "stdin"]`,
    `["Network", "use", "case"]`,
  ])("leaves %s as it is (memory-v7-1)", text => {
    expect(redactSecrets(text)).toBe(text);
  });

  it("still hides an openssl password given as pass: (memory-v7-1)", () => {
    expect(redactSecrets(`["openssl", "enc", "-pass", "pass:${PASSWORD}"]`)).not.toContain(PASSWORD);
  });

  it("takes each pass but the list passes, which run in steps (below), under Stop's 300 ms over 4 MiB of lists", () => {
    // The best of three runs of each pass, so another program's load isn't counted.
    const stepped = new Set(LIST_PASSES_AT_ONCE);
    const units = ['"mysql", "x", ', '"MYSQL.EXE", "-p", ', '"htpasswd", "-b", ', '"net", "use", "\\\\\\\\h", ', '"Redis-Cli", "-a", ', '"mysql", "-px1", ', "'unterminated \" "];
    for (const unit of units) {
      const big = `[${unit.repeat(Math.ceil((4 * 1024 * 1024) / unit.length))}"end"]`;
      let worst = 0;
      for (const pass of REDACT_PASSES) {
        if (stepped.has(pass)) continue;
        let best = Infinity;
        for (let k = 0; k < 3; k++) {
          const t0 = performance.now();
          pass(big);
          best = Math.min(best, performance.now() - t0);
        }
        worst = Math.max(worst, best);
      }
      expect(worst, unit).toBeLessThan(300);
    }
  }, 120_000);
});

describe("redactSecrets: the list passes in steps", () => {
  const MiB = 4 * 1024 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.ceil(MiB / unit.length));
  /** The longest step of `steps` and what they return. */
  const longestStep = (steps: Generator<void, string, void>): { ms: number; out: string } => {
    let ms = 0;
    for (;;) {
      const t = performance.now();
      const r = steps.next();
      ms = Math.max(ms, performance.now() - t);
      if (r.done) return { ms, out: r.value };
    }
  };

  it("hides exactly what each pass's whole-text form hides, wherever its matches start", () => {
    // Text made of what a match holds and what ends one: programs in any case, with folders and .exe, options and
    // values, quotes, escapes, separators, brackets, white space JavaScript counts as \s, and line terminators.
    const parts = [
      "mysql", "MYSQL.EXE", "mYsQl", "mariadb-dump", "mysqlmysql", "sshpass", "mongo", "docker", "login", "helm", "redis-cli", "Redis-Cli",
      "curl", "WGET", "smbclient", "openssl", "htpasswd", "net", "NET", "use", "USE", "/usr/bin/", "C:\\\\bin\\\\", "a/", "\\", "/",
      ".exe", "-p", "-pab", "-px1", "-P", "-a", "-u", "-U", "ada:pw1", "u%pw1", "-k", "-pass", "pass:pw1", "-nb", "-b", "-n", "-B",
      "-C", "10", "Z:", "\\\\\\\\h\\\\s", "/user:ada", "/persistent:no", "--password", "--no-password", "--api-key", "api_key",
      "-db-pass", "none", "string", "env:PW", "stdin", "$X", "PASSWORD", "yourpassword", "hunter2x", "x", "*", "\"", "'", "\\\"",
      "\\'", ",", ", ", ",\n", "\n- ", "\n-", " ", "\t", "\n", "\r", "\u00a0", "\u2028", "[", "]", "(", ")", "{", ":", ": ", "-",
    ];
    let seed = 20_261_122;
    // The generator's high bits: its low bits repeat in short cycles.
    const rand = (n: number): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return Math.floor((seed / 2_147_483_648) * n); };
    const same = (t: string): void => {
      for (let p = 0; p < LIST_PASS_STEPS.length; p++) expect(runSteps(LIST_PASS_STEPS[p](t)), `${p}: ${JSON.stringify(t)}`).toBe(LIST_PASSES_WHOLE[p](t));
    };
    for (let k = 0; k < 2000; k++) {
      let t = "";
      const n = 1 + rand(40);
      for (let i = 0; i < n; i++) t += parts[rand(parts.length)];
      same(t);
    }
    // Lists each row matches, with other elements among them, any quotes, separators and case, an element left out
    // and a character put in, so every row hides something and fails just short of it (a match of each, counted).
    const rows = [
      ["mysql", "*", "-pab1"], ["/usr/bin/MYSQL.EXE", "-pab1"], ["sshpass", "-p", "pw12"], ["mongo", "*", "-ppw12"], ["docker", "*", "login", "*", "-p", "pw12"],
      ["podman", "login", "--password", "pw12"], ["redis-cli", "*", "-a", "pw12"], ["curl", "*", "-u", "ada:pw12"], ["wget", "--user", "ada:pw12"],
      ["smbclient", "*", "-U", "u%pw12"], ["openssl", "*", "-k", "pw12"], ["openssl", "enc", "-pass", "pass:pw12"], ["openssl", "-passin", "pass:pw12"],
      ["htpasswd", "-nb", "ada", "pw12"], ["htpasswd", "-nbB", "-C", "10", "ada", "pw12"], ["htpasswd", "-b", "f", "ada", "pw12"], ["htpasswd", "-B", "-b", "f", "ada", "pw12"],
      ["net", "use", "\\\\h\\s", "pw12"], ["net", "use", "Z:", "\\\\h\\s", "pw12"], ["net", "use", "*", "/user:ada", "pw12"], ["--password", "pw12"], ["--api-key", "api_key"],
      ["--no-password", "pw12"], ["--token", "none"], ["--password", "env:PW"], ["-pass", "stdin"],
    ];
    const fillers = ["x", "-h", "localhost", "ping", "-v", "10", "-p", "$X", "PASSWORD", "a b", "", "-pab", "mysql", "\\\\h"];
    const seps = [", ", ",", ",\n", ",\n  ", "\n- ", "\n  - ", " ", ", [", ", ", ",\t", "] [", ": "];
    const quotes = ['"', "'", ""];
    const opens = ["[", "(", "", "test: [", "- ", "run(", "x, ["];
    const caseOf = (w: string): string => (rand(4) === 0 ? w.toUpperCase() : rand(6) === 0 ? w.replace(/./g, c => (rand(2) ? c.toUpperCase() : c)) : w);
    const hid = new Array<number>(LIST_PASS_STEPS.length).fill(0);
    for (let k = 0; k < 3000; k++) {
      let t = opens[rand(opens.length)];
      const lists = rand(4) === 0 ? 2 : 1;
      for (let l = 0; l < lists; l++) {
        const els: string[] = [];
        for (const w of rows[rand(rows.length)]) {
          if (w === "*") for (let i = rand(4); i > 0; i--) els.push(fillers[rand(fillers.length)]);
          else els.push(caseOf(w));
        }
        if (rand(5) === 0) els.splice(rand(els.length), 1);
        const [q, sep] = [quotes[rand(3)], seps[rand(seps.length)]];
        t += els.map(e => { const o = rand(10) === 0 ? quotes[rand(3)] : q; return o + e + (rand(15) === 0 ? quotes[rand(3)] : o); }).join(rand(6) === 0 ? seps[rand(seps.length)] : sep);
        if (l < lists - 1) t += seps[rand(seps.length)];
      }
      t += ["]", ")", "", "\n", "] ", ": 1"][rand(6)];
      if (rand(8) === 0) { const i = rand(t.length + 1); t = t.slice(0, i) + ['"', "'", "\\", "\n", ",", "/", "-"][rand(7)] + t.slice(i); }
      same(t);
      for (let p = 0; p < LIST_PASS_STEPS.length; p++) if (LIST_PASSES_WHOLE[p](t) !== t) hid[p]++;
    }
    for (const n of hid) expect(n).toBeGreaterThan(10);
  });

  it("never holds Ember's main thread for long over 4 MiB, so Stop answers within 300 ms on a machine three times slower", () => {
    // One whole-text row took 180 to 195 ms on this machine and 645 ms on CI's Windows runner (`"mysql", "-px1", `). A
    // step here runs about 4 ms and the longest was about 12 ms (19 ms with unicode spaces); 50 leaves room for a
    // machine three times slower. The best of three runs, so another program's load isn't counted.
    const cases = [
      ...['"mysql", "-px1", ', '["mysql", "-pab"], ', '\n- "-pab"', '"--password", "stdinx", ', '"MYSQL.EXE", "-p", ', '"htpasswd", "-nb", "u", "pw", ',
        '"net", "use", "\\\\\\\\h\\\\s", "pw", ', '("mysql", "-pab"), ', "- mysql\n- \"-pab\"\n", '"mysql",\u00a0"-pab",\u2028', "'-", "netnetnet"]
        .map(unit => `[${fill(unit)}"end"]`),
      // One run of characters the whole text long, its name at the end after a folder of 2 Mi slashes.
      `${fill("a/")}mysql, "-pab"]`,
      // An option or a value that never closes.
      `["-${fill("ab-")}`,
      `["--password", "${fill("x")}`,
      // White space or one string the whole text long.
      `["mysql",${" ".repeat(MiB)}"-pab"]`,
      `["mysql", "-p${fill('\\"')}`,
    ];
    for (const text of cases) {
      for (let p = 0; p < LIST_PASS_STEPS.length; p++) {
        let best = Infinity, out = "";
        for (let k = 0; k < 3 && best >= 50; k++) {
          const r = longestStep(LIST_PASS_STEPS[p](text));
          best = Math.min(best, r.ms);
          out = r.out;
        }
        expect(best, `${p}: ${JSON.stringify(text.slice(0, 40))}`).toBeLessThan(50);
        // The whole-text client-list scan is quadratic in `\"` (128 KiB took it 9 s), so that case is compared below.
        if (!text.includes('\\"')) expect(out === LIST_PASSES_WHOLE[p](text), `${p}: ${JSON.stringify(text.slice(0, 40))}`).toBe(true);
      }
    }
  }, 240_000);

  it("reads a string that never closes once, where the whole-text scan read the line again from every quote (9 s for 128 KiB)", () => {
    const clientLists = LIST_PASS_STEPS.length - 1;
    for (const text of [
      `["mysql", "-p${'\\"'.repeat(2000)}`,
      `['mysql', '-p${"\\'".repeat(2000)}`,
      `["mysql", "-p${'\\"'.repeat(2000)}"] ['mysql', '-p${"\\'".repeat(2000)}x'] ["mysql", "-pab"]`,
      `["mysql", "-p\\\n", "-pab", "x\\\r", "-pcd"]`,
    ]) {
      expect(runSteps(LIST_PASS_STEPS[clientLists](text)), JSON.stringify(text.slice(-40))).toBe(LIST_PASSES_WHOLE[clientLists](text));
    }
    expect(redactSecrets(`['mysql', '-p${"\\'".repeat(2000)}x'] ["mysql", "-pab"]`)).not.toContain("-pab");
  });

  it("are steps of their own between the redactor's other passes, with the same bytes as at once", () => {
    const text = `[${fill('"mysql", "-px1", ')}"end"]`;
    const steps = redactSteps(text);
    let count = 0;
    for (let r = steps.next(); !r.done; r = steps.next()) count++;
    // A step before each pass, and more within the list passes. How many more depends on the machine: the list passes
    // yield by the clock (LIST_STEP_MS), so a faster run yields less often (184 steps once here, where 190 were asked for).
    expect(count).toBeGreaterThan(REDACT_PASSES.length);
    expect(runSteps(redactSteps(text))).toBe(redactSecrets(text));
    expect(redactSecrets(text)).not.toContain('"-px1"');
  }, 60_000);
});
