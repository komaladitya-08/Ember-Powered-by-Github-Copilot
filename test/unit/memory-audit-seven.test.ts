/** Seventh-round memory regressions: literal argv credentials and durable acknowledgements fail closed. */
import { describe, expect, it } from "vitest";
import { redactSecrets, SECRET_HIDDEN } from "../../app/main/commands/redact";
import { memoryRefusal } from "../../app/main/memory/guard";

const PASSWORD = "Summer2024!";

describe("credentials in argument arrays", () => {
  it.each([
    `["CMD", "mysqladmin", "ping", "-h", "localhost", "-uroot", "-p${PASSWORD}"]`,
    `subprocess.run(["mysql", "-u", "root", "-p${PASSWORD}"])`,
    `args = [\n  "mysql",\n  "-h", hostname,\n  "-p${PASSWORD}"\n]`,
    `["C:\\\\xampp\\\\mysql\\\\bin\\\\MYSQL.EXE", "-p${PASSWORD}"]`,
    `('mariadb', '-p${PASSWORD}', 'app')`,
  ])("hides and refuses a MySQL password in %s (memory-q6-1)", text => {
    expect(redactSecrets(text)).not.toContain(PASSWORD);
    expect(redactSecrets(text)).toContain(SECRET_HIDDEN);
    expect(memoryRefusal(text)).not.toBeNull();
  });

  it.each([
    `["mysql", "-p", "shop"]`,
    `["mysql", "-p$DB_PASS", "shop"]`,
    `["mysqlclient", "-pthread"]`,
    `const files = ["mysql.cc", "-pthread"];`,
    `["mysql", "-pPASSWORD"]`,
  ])("keeps credential-free argument text %s (memory-q6-1)", text => {
    expect(redactSecrets(text)).toBe(text);
  });
});
