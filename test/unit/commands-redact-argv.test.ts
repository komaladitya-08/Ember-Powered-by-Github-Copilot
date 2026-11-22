/**
 * Passwords in lists of arguments (round seven's memory-q6-1, memory-v7-1 and memory-y7-1, ported from the audit-seven
 * branch): every recognised client in any case and with Windows' `.exe`, htpasswd's and `net use`'s own forms, a
 * long MySQL list, and what only says where a password is read from left alone; each pass stays well inside Stop's
 * 300 ms on a long list that holds none.
 */
import { describe, expect, it } from "vitest";
import { REDACT_PASSES, redactSecrets, SECRET_HIDDEN } from "../../app/main/commands/redact";
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

  it("takes each pass under Stop's 300 ms over 4 MiB of client names that hold no password", () => {
    // The best of three runs of each pass, so another program's load isn't counted (here: at most about 180 ms, for
    // 4 MiB of "MYSQL.EXE" with a "-p" among them; "mysql" alone took about 190 ms before its row needed a "-p").
    const units = ['"mysql", "x", ', '"MYSQL.EXE", "-p", ', '"htpasswd", "-b", ', '"net", "use", "\\\\\\\\h", ', '"Redis-Cli", "-a", ', '"mysql", "-px1", ', "'unterminated \" "];
    for (const unit of units) {
      const big = `[${unit.repeat(Math.ceil((4 * 1024 * 1024) / unit.length))}"end"]`;
      let worst = 0;
      for (const pass of REDACT_PASSES) {
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
