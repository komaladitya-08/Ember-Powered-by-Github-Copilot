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

it.each([
  `["redis-cli", "-a", "${PASSWORD}", "PING"]`,
  `["curl", "-u", "ada:${PASSWORD}", "https://example.com"]`,
  `["docker", "login", "-p", "${PASSWORD}"]`,
  `["mongosh", "-p", "${PASSWORD}"]`,
  `["sshpass", "-p", "${PASSWORD}", "ssh", "host"]`,
  `["smbclient", "-U", "ada%${PASSWORD}", "//host/share"]`,
  `["htpasswd", "-nb", "ada", "${PASSWORD}"]`,
  `["openssl", "enc", "-k", "${PASSWORD}"]`,
  JSON.stringify(["net", "use", String.raw`\\host\share`, PASSWORD]),
])("hides and refuses each recognised client's literal argv password in %s (memory-v7-1)", text => {
  expect(redactSecrets(text)).not.toContain(PASSWORD);
  expect(memoryRefusal(text)).not.toBeNull();
});

it.each([
  `["redis-cli", "-a", process.env.REDIS_PASSWORD, "ping"]`,
  `["redis-cli", "-a", "$REDIS_PASSWORD", "ping"]`,
  `["redis-cli", "-a"]`,
  `["curl", "-u", "$USER:$PASSWORD"]`,
  `["docker", "run", "-p", "8080:80", "image"]`,
  `["docker", "login", "-p", "$PASSWORD"]`,
  `["htpasswd", "-n", "ada"]`,
  `["openssl", "enc", "-pass", "env:PW"]`,
])("keeps non-literal or non-password argv arguments %s (memory-v7-1)", text => {
  expect(redactSecrets(text)).toBe(text);
});

it.each([
  `["mYsQl", "-p${PASSWORD}"]`,
  JSON.stringify(["mysql", ...Array.from({ length: 20 }, (_, i) => `arg-${i}`), `-p${PASSWORD}`]),
  `["CMD", "mYsQlAdMiN", "ping", "-p${PASSWORD}"]`,
  `["Redis-Cli", "-a", "${PASSWORD}"]`,
  `["CURL.EXE", "-u", "ada:${PASSWORD}"]`,
  JSON.stringify(["C:\\Program Files\\Docker\\DOCKER.EXE", "login", "-p", PASSWORD]),
])("retains case-insensitive and native executable argv protection in %s (memory-y7-1)", text => {
  expect(redactSecrets(text)).not.toContain(PASSWORD);
  expect(memoryRefusal(text)).not.toBeNull();
});
