/**
 * Secret redaction (design §3.11 step 4): each pattern hides its value as "[secret hidden]", keeps what names it, and
 * leaves ordinary text alone; commandLineSecret finds the same tokens typed into a command (§3.5.4).
 */

import { describe, expect, it } from "vitest";
import { commandLineSecret, redactSecrets, SECRET_HIDDEN } from "../../app/main/commands/redact";
import { memoryRefusal } from "../../app/main/memory/guard";

const GH = `ghp_${"a1B2".repeat(9)}`;
const PAT = `github_pat_${"x".repeat(22)}`;
const JWT = `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`;

describe("redactSecrets", () => {
  it.each([
    [`token ${GH} here`, `token ${SECRET_HIDDEN} here`],
    [`use ${PAT}`, `use ${SECRET_HIDDEN}`],
    [`gho_${"z".repeat(36)} and ghs_${"y".repeat(40)}`, `${SECRET_HIDDEN} and ${SECRET_HIDDEN}`],
    ["key AKIAABCDEFGHIJKLMNOP done", `key ${SECRET_HIDDEN} done`],
    ["ASIAABCDEFGHIJKLMNOP", SECRET_HIDDEN],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG", `aws_secret_access_key = ${SECRET_HIDDEN}`],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nafter", `${SECRET_HIDDEN}\nafter`],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----", SECRET_HIDDEN],
    [`bearer ${JWT}`, `bearer ${SECRET_HIDDEN}`],
    ["xoxb-1234567890-abcdef", SECRET_HIDDEN],
    [`AIza${"Q".repeat(35)}`, SECRET_HIDDEN],
    [`npm_${"k".repeat(36)}`, SECRET_HIDDEN],
    ["DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abc+/def==;EndpointSuffix=x", `DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${SECRET_HIDDEN};EndpointSuffix=x`],
    ["sv=1&SharedAccessSignature=sig123;x", `sv=1&SharedAccessSignature=${SECRET_HIDDEN};x`],
    ["Authorization: Bearer abc.def", `Authorization: Bearer ${SECRET_HIDDEN}`],
    ["authorization: token 123abc", `authorization: token ${SECRET_HIDDEN}`],
    ["Authorization: Basic dXNlcjpwYXNz", `Authorization: Basic ${SECRET_HIDDEN}`],
    ["cloning https://ana:hunter2@github.com/o/r.git", `cloning https://${SECRET_HIDDEN}@github.com/o/r.git`],
    ["password=hunter2", `password=${SECRET_HIDDEN}`],
    ["DB_PASSWORD: hunter2", `DB_PASSWORD: ${SECRET_HIDDEN}`],
    ['{"api_key": "abc123", "name": "x"}', `{"api_key": "${SECRET_HIDDEN}", "name": "x"}`],
    ["client_secret=abc; next", `client_secret=${SECRET_HIDDEN}; next`],
    ["ACCESS-KEY=zzz", `ACCESS-KEY=${SECRET_HIDDEN}`],
    ["private_key: k", `private_key: ${SECRET_HIDDEN}`],
    ["passwd=p pwd=q secret=r token=s", `passwd=${SECRET_HIDDEN} pwd=${SECRET_HIDDEN} secret=${SECRET_HIDDEN} token=${SECRET_HIDDEN}`],
    ["mysql --host=db --db-pass=hunter2 app", `mysql --host=db --db-pass=${SECRET_HIDDEN} app`],
    ["--pass=hunter2", `--pass=${SECRET_HIDDEN}`],
    ["node run --deploy-pass=pq --verbose", `node run --deploy-pass=${SECRET_HIDDEN} --verbose`],
    ["curl --password=hunter2 http://x", `curl --password=${SECRET_HIDDEN} http://x`],
  ])("hides %j", (text, want) => {
    expect(redactSecrets(text)).toBe(want);
  });

  /** A key-like run of letters and digits, `n` long. */
  const run = (n: number) => "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3gH5jK7mN9pQ1sT3vW5yZ7bC9dF1gH3jK5mN7pQ9sT1vW3yZ5bC7dF9gH1jK3mN5pQ7sT9vW1yZ3".repeat(2).slice(0, n);
  const KEYS = [
    `sk-proj-${run(48)}_${run(20)}`, `sk-${run(48)}`, `sk-ant-api03-${run(90)}`, `sk_live_${run(24)}`, `rk_test_${run(24)}`,
    `whsec_${run(32)}`, `hf_${run(34)}`, `glpat-${run(20)}`,
  ];
  it.each(KEYS.map(k => [k]))("hides today's common API key %j bare, after echo and inside JSON (safety-privacy-2)", key => {
    expect(redactSecrets(key)).toBe(SECRET_HIDDEN);
    expect(redactSecrets(`$ echo ${key}\n${key}`)).toBe(`$ echo ${SECRET_HIDDEN}\n${SECRET_HIDDEN}`);
    expect(redactSecrets(`{"openai_key": "${key}", "n": 1}`)).toBe(`{"openai_key": "${SECRET_HIDDEN}", "n": 1}`);
    expect(redactSecrets(`HF token ${key} for the build`)).toBe(`HF token ${SECRET_HIDDEN} for the build`);
    expect(commandLineSecret(key)).toBe(true);
  });

  // A password given to a program's short option, which only the option's program says is one (safety-privacy-c5-2).
  it.each([
    ["mysql -u root -pWint3r!Sh0p", `mysql -u root -p${SECRET_HIDDEN}`],
    ["mysqldump -u root -p'Wint3r!Sh0p' shop > shop.sql", `mysqldump -u root -p'${SECRET_HIDDEN}' shop > shop.sql`],
    ["curl -u admin:Wint3r!Sh0p https://x", `curl -u admin:${SECRET_HIDDEN} https://x`],
    ["curl --user=admin:Wint3r!Sh0p https://x", `curl --user=admin:${SECRET_HIDDEN} https://x`],
    ["docker login registry.example.com -u deploy -p Wint3r!Sh0p", `docker login registry.example.com -u deploy -p ${SECRET_HIDDEN}`],
    ["mongo -u admin -p Wint3r!Sh0p", `mongo -u admin -p ${SECRET_HIDDEN}`],
    ["sshpass -p 'Wint3r!Sh0p' ssh host", `sshpass -p '${SECRET_HIDDEN}' ssh host`],
    ["redis-cli -a Wint3r!Sh0p", `redis-cli -a ${SECRET_HIDDEN}`],
    ["smbclient //srv/share -U admin%Wint3r!Sh0p", `smbclient //srv/share -U admin%${SECRET_HIDDEN}`],
    ["htpasswd -b .htpasswd admin Wint3r!Sh0p", `htpasswd -b .htpasswd admin ${SECRET_HIDDEN}`],
    ["openssl enc -k Wint3r!Sh0p -in a", `openssl enc -k ${SECRET_HIDDEN} -in a`],
    ["net use Z: \\\\srv\\share Wint3r!Sh0p /user:admin", `net use Z: \\\\srv\\share ${SECRET_HIDDEN} /user:admin`],
    ["echo 'Wint3r!Sh0p' | sudo -S apt update", `echo '${SECRET_HIDDEN}' | sudo -S apt update`],
  ])("hides the password in %j (safety-privacy-c5-2)", (text, want) => {
    expect(redactSecrets(text)).toBe(want);
  });
  it.each([
    ["mysql -u root -p"], ["mysql -u root -p shop"], ['mysql -u root -p"$DB_PASS"'], ["mysql -u root -pPASSWORD"], ['curl -u "$USER:$PASS" https://x'],
    ["curl -u admin: https://x"], ["docker run -p 8080:80 nginx"], ['docker login -u me -p "$TOKEN"'], ["docker login --password-stdin"], ['sshpass -p "$PW" ssh host'],
    ["ps -p 1234"], ["grep -p foo"], ['git commit -am "fix mysql -p handling"'],
  ])("leaves %j alone: a prompt, a variable, a placeholder or another program's option (safety-privacy-c5-2)", text => {
    expect(redactSecrets(text)).toBe(text);
  });
  // htpasswd printing to its output takes no file, and a MySQL client is a command word, never a library or a path in
  // a build line (memory-x6-4).
  it.each([
    ["htpasswd -nb admin Wint3r!Sh0p", `htpasswd -nb admin ${SECRET_HIDDEN}`],
    ["htpasswd -nbB admin Wint3r!Sh0p > .htpasswd", `htpasswd -nbB admin ${SECRET_HIDDEN} > .htpasswd`],
    ["htpasswd -nbB -C 10 admin Wint3r!Sh0p", `htpasswd -nbB -C 10 admin ${SECRET_HIDDEN}`],
    ["htpasswd -bc .htpasswd admin Wint3r!Sh0p", `htpasswd -bc .htpasswd admin ${SECRET_HIDDEN}`],
    ["docker exec -i db mysql -uroot -pWint3r!Sh0p shop < dump.sql", `docker exec -i db mysql -uroot -p${SECRET_HIDDEN} shop < dump.sql`],
    ["sudo mysql -pWint3r!Sh0p", `sudo mysql -p${SECRET_HIDDEN}`], ["/usr/bin/mysqldump -pWint3r!Sh0p shop", `/usr/bin/mysqldump -p${SECRET_HIDDEN} shop`],
    ["mariadb-dump -u root -pWint3r!Sh0p shop", `mariadb-dump -u root -p${SECRET_HIDDEN} shop`],
    ['sh -c "mysql -u root -pWint3r!Sh0p shop"', `sh -c "mysql -u root -p${SECRET_HIDDEN} shop"`],
  ])("hides the password in %j (memory-x6-4)", (text, want) => {
    expect(redactSecrets(text)).toBe(want);
  });
  it.each([
    ["CFLAGS = -Wall -O2 -I/usr/include/mysql -pthread"], ["gcc main.c `mysql_config --cflags --libs` -pthread -o app"],
    ["target_link_libraries(report mysqlclient -pthread)"], ["gcc -I/usr/include/mysql -pedantic -Wall -o app main.c"],
    ["g++ -std=c++17 -I/usr/include/mariadb -pipe -c db.cpp"], ["pip install mysqlclient -pre"], ["LIBS = $(mysql_config --libs) -pthread -lm"],
    ["mysqld_safe --user=mysql -pid-file=/run/mysqld.pid"], ["Install mysql-server and then run make -pj4"], ["htpasswd -nB admin"],
  ])("leaves %j alone: a build line or a prompt, which names a MySQL library, never a client's password (memory-x6-4)", text => {
    expect(redactSecrets(text)).toBe(text);
  });
  // A client after a Makefile recipe's prefix, a unit's or a supervisor's "=", in any folder, and MySQL's and MariaDB's
  // other clients that take -p (memory-y6-1).
  it.each([
    ["\t@mysql -u root -pWint3r!Sh0p shop < schema.sql", `\t@mysql -u root -p${SECRET_HIDDEN} shop < schema.sql`],
    ["db-reset:\n\t-mysql -u root -pWint3r!Sh0p shop", `db-reset:\n\t-mysql -u root -p${SECRET_HIDDEN} shop`],
    ["ExecStart=/usr/bin/mysqldump -u b -pWint3r!Sh0p --all-databases", `ExecStart=/usr/bin/mysqldump -u b -p${SECRET_HIDDEN} --all-databases`],
    ["ExecStartPre=-/usr/bin/mysql -u b -pWint3r!Sh0p", `ExecStartPre=-/usr/bin/mysql -u b -p${SECRET_HIDDEN}`],
    ["command=mysqldump -pWint3r!Sh0p shop", `command=mysqldump -p${SECRET_HIDDEN} shop`],
    ["cd /opt/lampp && bin/mysql -u root -pWint3r!Sh0p", `cd /opt/lampp && bin/mysql -u root -p${SECRET_HIDDEN}`],
    ["bin\\mysql -u root -pWint3r!Sh0p", `bin\\mysql -u root -p${SECRET_HIDDEN}`],
    ["C:\\xampp\\mysql\\bin\\mysql.exe -u root -pWint3r!Sh0p", `C:\\xampp\\mysql\\bin\\mysql.exe -u root -p${SECRET_HIDDEN}`],
    ["~/mysql/bin/mysql -pWint3r!Sh0p", `~/mysql/bin/mysql -p${SECRET_HIDDEN}`],
    ["$HOME/mysql/bin/mysql -pWint3r!Sh0p", `$HOME/mysql/bin/mysql -p${SECRET_HIDDEN}`],
    ["${MYSQL_HOME}/bin/mysql -pWint3r!Sh0p", `\${MYSQL_HOME}/bin/mysql -p${SECRET_HIDDEN}`],
    ["\t@$(MYSQL_DIR)/bin/mysql -pWint3r!Sh0p", `\t@$(MYSQL_DIR)/bin/mysql -p${SECRET_HIDDEN}`],
    ["mysql_upgrade -u root -pWint3r!Sh0p", `mysql_upgrade -u root -p${SECRET_HIDDEN}`],
    ["mysql_secure_installation -u root -pWint3r!Sh0p", `mysql_secure_installation -u root -p${SECRET_HIDDEN}`],
    ["mariadb-upgrade -pWint3r!Sh0p", `mariadb-upgrade -p${SECRET_HIDDEN}`], ["mariabackup --backup -pWint3r!Sh0p", `mariabackup --backup -p${SECRET_HIDDEN}`],
    ["mariadb-backup --backup -pWint3r!Sh0p", `mariadb-backup --backup -p${SECRET_HIDDEN}`],
    ["[mysql -pWint3r!Sh0p]", `[mysql -p${SECRET_HIDDEN}`], ["*mysql -pWint3r!Sh0p*", `*mysql -p${SECRET_HIDDEN}`],
  ])("hides the password in %j (memory-y6-1)", (text, want) => {
    expect(redactSecrets(text)).toBe(want);
  });
  it.each([
    ["CFLAGS += -I /usr/include/mysql -pthread"], ["CFLAGS=-I/usr/include/mysql -pthread"], ["gcc -isystem /usr/include/mysql -pthread -o app main.c"],
    ["gcc -L /usr/lib64/mysql -lmysqlclient -pthread"], ["CFLAGS = -Wall \\\n\t-I/usr/include/mysql -pthread"], ["\t@gcc -I /usr/include/mysql -pthread -o app main.c"],
    ["gcc -I$(PREFIX)/include/mysql -pthread"], ["gcc -Ivendor/mysql -pthread"], ["mysqld_safe --user=mysql -pid-file=/run/mysqld.pid"],
    ["ssh admin@mysql -p2222"], ["docker run -v /data/mysql:/var/lib/mysql -p3306:3306 mysql:8"], ["./configure --with-mysql=/usr/local/mysql -prefix=/opt"],
  ])("leaves %j alone: an include or library folder, an option's value or a host, never a client (memory-y6-1)", text => {
    expect(redactSecrets(text)).toBe(text);
  });
  // A client after a prompt, a comment mark, markup, curly quotes, a Makefile variable or a setting's "=" anywhere on
  // the line, run from a quoted folder, a share or a variable's folder, or named by a variable or an .exe in any case
  // (memory-z6-1).
  it.each([
    ["C:\\xampp\\mysql\\bin>mysql -u root -pWint3r!Sh0p", `C:\\xampp\\mysql\\bin>mysql -u root -p${SECRET_HIDDEN}`],
    ["C:\\Users\\me>mysqldump -u root -pWint3r!Sh0p shop", `C:\\Users\\me>mysqldump -u root -p${SECRET_HIDDEN} shop`],
    ["C:\\>mysql -u root -pWint3r!Sh0p", `C:\\>mysql -u root -p${SECRET_HIDDEN}`], ["~$mysql -u root -pWint3r!Sh0p", `~$mysql -u root -p${SECRET_HIDDEN}`],
    ["[root@db ~]#mysql -u root -pWint3r!Sh0p", `[root@db ~]#mysql -u root -p${SECRET_HIDDEN}`],
    ['"C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe" -u root -pWint3r!Sh0p', `"C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe" -u root -p${SECRET_HIDDEN}`],
    ['& "$env:ProgramFiles\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe" -u root -pWint3r!Sh0p', `& "$env:ProgramFiles\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe" -u root -p${SECRET_HIDDEN}`],
    ["& $env:ProgramFiles\\MySQL\\bin\\mysql.exe -u root -pWint3r!Sh0p", `& $env:ProgramFiles\\MySQL\\bin\\mysql.exe -u root -p${SECRET_HIDDEN}`],
    ["C:\\Program Files (x86)\\MySQL\\bin\\mysql.exe -u root -pWint3r!Sh0p", `C:\\Program Files (x86)\\MySQL\\bin\\mysql.exe -u root -p${SECRET_HIDDEN}`],
    ["%MYSQL_HOME%\\bin\\mysql.exe -u root -pWint3r!Sh0p", `%MYSQL_HOME%\\bin\\mysql.exe -u root -p${SECRET_HIDDEN}`],
    ['"%MYSQL_HOME%\\bin\\mysql" -u root -pWint3r!Sh0p', `"%MYSQL_HOME%\\bin\\mysql" -u root -p${SECRET_HIDDEN}`],
    ["\\\\db01\\tools\\mysql.exe -u root -pWint3r!Sh0p", `\\\\db01\\tools\\mysql.exe -u root -p${SECRET_HIDDEN}`],
    ["MYSQL.EXE -u root -pWint3r!Sh0p", `MYSQL.EXE -u root -p${SECRET_HIDDEN}`], ["MySQL.exe -u root -pWint3r!Sh0p", `MySQL.exe -u root -p${SECRET_HIDDEN}`],
    ["Mysql -u root -pWint3r!Sh0p", `Mysql -u root -p${SECRET_HIDDEN}`],
    ["#mysqldump -u root -pWint3r!Sh0p shop > backup.sql", `#mysqldump -u root -p${SECRET_HIDDEN} shop > backup.sql`],
    ["//mysql -u root -pWint3r!Sh0p", `//mysql -u root -p${SECRET_HIDDEN}`], ["<!--mysql -u root -pWint3r!Sh0p -->", `<!--mysql -u root -p${SECRET_HIDDEN} -->`],
    ["<code>mysql -u root -pWint3r!Sh0p</code>", `<code>mysql -u root -p${SECRET_HIDDEN}`],
    ["Run \u201cmysql -u root -pWint3r!Sh0p\u201d to log in", `Run \u201cmysql -u root -p${SECRET_HIDDEN} to log in`],
    ["\t$(Q)mysql -u root -pWint3r!Sh0p shop", `\t$(Q)mysql -u root -p${SECRET_HIDDEN} shop`],
    ["\t$(MYSQL) -u root -pWint3r!Sh0p shop", `\t$(MYSQL) -u root -p${SECRET_HIDDEN} shop`], ["${MYSQLDUMP} -pWint3r!Sh0p shop", `\${MYSQLDUMP} -p${SECRET_HIDDEN} shop`],
    ["  - DB_CMD=mysql -u root -pWint3r!Sh0p", `  - DB_CMD=mysql -u root -p${SECRET_HIDDEN}`],
    ["export MYSQL_CMD=mysql -u root -pWint3r!Sh0p", `export MYSQL_CMD=mysql -u root -p${SECRET_HIDDEN}`],
    ["run )mysql -u root -pWint3r!Sh0p", `run )mysql -u root -p${SECRET_HIDDEN}`], ["$/usr/bin/mysql -u root -pWint3r!Sh0p", `$/usr/bin/mysql -u root -p${SECRET_HIDDEN}`],
  ])("hides the password in %j (memory-z6-1)", (text, want) => {
    expect(redactSecrets(text)).toBe(want);
  });
  it.each([
    ["gcc -I./include/mysql -pthread"], ["gcc -I${PREFIX}/include/mysql -pthread"],
    ["CFLAGS += $(MYSQL_CFLAGS) -pthread"], ["docker run -v mysql:/var/lib/mysql -p3306:3306 mysql:8"], ["curl file:///var/lib/mysql -pthread"],
    ["cmake -DMYSQL_DIR=/usr/local/mysql -pthread"], ["apt install php-mysql -y && make -pj4"], ["ssh deploy@mysql -p2222"],
    ["Run `mysqld_safe --user=mysql -pid-file=/run/mysqld.pid` once"],
  ])("leaves %j alone: a folder, a variable or a name that is no client (memory-z6-1)", text => {
    expect(redactSecrets(text)).toBe(text);
  });

  it("leaves ordinary text alone", () => {
    for (const text of ["sk-learn is scikit-learn", "risk-assessment-for-the-quarterly-planning-2026", "task-1234567890abcdefghijklmnopqrstuvwxyz", "hf_short", "sk_live_short", "build ok in 3.2s", "password reset email sent to the user", "the token is valid", "https://github.com/o/r", "ghp_short", "AKIA1234", "key: value", "--compass=north", "--max-passes=3"]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it.each([
    ["a SendGrid key", `SG.${"aB3_".repeat(5)}xy.${"cD4-".repeat(10)}xyz`],
    ["a DigitalOcean token", `dop_v1_${"0a1b2c3d".repeat(8)}`],
    ["a Twilio API key", `SK${"0a1b2c3d".repeat(4)}`],
  ])("hides %s on its own (safety-privacy-r7-3)", (_what, token) => {
    expect(redactSecrets(`key is ${token} here`)).toBe(`key is ${SECRET_HIDDEN} here`);
    expect(commandLineSecret(token)).toBe(true);
  });

  it("hides a Docker config's auth and a .netrc line's password, keeping what names them (safety-privacy-r7-3)", () => {
    expect(redactSecrets('{ "auths": { "ghcr.io": { "auth": "dXNlcjpodW50ZXIyMTIzNDU2Nzg5MA==" } } }')).toBe(`{ "auths": { "ghcr.io": { "auth": "${SECRET_HIDDEN}" } } }`);
    expect(redactSecrets("machine api.example.com login bob password hunter2xyz")).toBe(`machine api.example.com login bob password ${SECRET_HIDDEN}`);
    expect(redactSecrets("default login anonymous password me@example.com")).toBe(`default login anonymous password ${SECRET_HIDDEN}`);
  });

  it("takes no ordinary sentence about a default password or a machine for a .netrc entry (safety-privacy-x7-2)", () => {
    for (const text of ["the default password is admin", "Reset the default password policy", "machine learning password reset", "default password field",
      "The router still has the default password set; Ana wants to change it", "Ana is studying machine learning password cracking research"]) {
      expect(redactSecrets(text)).toBe(text);
      expect(commandLineSecret(text)).toBe(false);
    }
    for (const command of ['git commit -m "Reset the default password policy"', 'echo "the default password is admin"', 'grep "machine learning password reset" notes.txt', 'git log --grep="default password field"'])
      expect(commandLineSecret(command)).toBe(false);
    for (const note of ["Sam uses the default password manager, Bitwarden, on his Mac", "The router still has the default password set; Ana wants to change it",
      "Team rule: the default password policy is 12 characters", "Ana is studying machine learning password cracking research"]) expect(memoryRefusal(note)).toBeNull();
  });

  it("still hides a .netrc entry's password with no login, by its host's name (safety-privacy-r7-3)", () => {
    expect(redactSecrets("machine api.example.com password hunter2xyz")).toBe(`machine api.example.com password ${SECRET_HIDDEN}`);
    expect(commandLineSecret("echo 'machine api.example.com login bob password hunter2xyz' >> ~/.netrc")).toBe(true);
    expect(memoryRefusal("machine api.example.com login bob password hunter2xyz")).not.toBeNull();
  });

  it("leaves text that only looks a little like those alone (safety-privacy-r7-3)", () => {
    for (const text of ["SG.short.thing", "SKU1234567890abcdef1234567890abcdef12", "dop_v1_short", '"auth": "none"', '"author": "Sam Example of Somewhere"', "the machine asked for a password reset",
      "enter your password again"]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it("stays linear on long runs of the new shapes (safety-privacy-r7-3)", () => {
    const start = Date.now();
    redactSecrets("machine ".repeat(100_000) + "SG.".repeat(100_000) + '"auth": "'.repeat(50_000));
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("doesn't hide a value twice", () => {
    expect(redactSecrets(`password=${GH}`)).toBe(`password=${SECRET_HIDDEN}`);
    expect(redactSecrets(redactSecrets("token=abc"))).toBe(`token=${SECRET_HIDDEN}`);
  });
});

describe("commandLineSecret", () => {
  it.each([GH, PAT, JWT, "AKIAABCDEFGHIJKLMNOP", "https://ana:pw@example.com", "API_TOKEN=abc", "--password=x", "DB_PASSWORD=x", "Authorization: Bearer x"])("finds %j", word => {
    expect(commandLineSecret(word)).toBe(true);
  });
  it.each(["token: fix the build", "PWD=/home/ana", "OLDPWD=/tmp", "--tokenizer=fast", "password", "src/secret.ts", "https://example.com"])("leaves %j", word => {
    expect(commandLineSecret(word)).toBe(false);
  });
  it("gives the same answer every time (no global-flag state)", () => {
    for (let k = 0; k < 3; k++) expect(commandLineSecret(GH)).toBe(true);
  });
});

describe("redactSecrets on long output (review #26)", () => {
  /** The patterns as they were before they were made linear: the oracle for what is hidden. */
  const before = (text: string): string => {
    let out = text;
    for (const re of [
      /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      /xox[abposr]-[A-Za-z0-9-]{10,}/g,
      /AIza[0-9A-Za-z_-]{35}/g,
      /npm_[A-Za-z0-9]{36}/g,
    ]) out = out.replace(re, SECRET_HIDDEN);
    for (const re of [/(aws_secret_access_key\s*[=:]\s*)\S+/gi, /(AccountKey=)[^;\s]+/g, /(SharedAccessSignature=)[^;\s]+/g, /(Authorization:\s*(?:Bearer|Basic|token)\s+)\S+/gi]) {
      out = out.replace(re, (_m, keep: string) => keep + SECRET_HIDDEN);
    }
    out = out.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, `://${SECRET_HIDDEN}@`);
    const kv = /([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?\s*(?:=|:)\s*["']?)([^\s"',;]+)/gi;
    return out.replace(kv, (m, keep: string, value: string) => (value.startsWith("[secret") ? m : keep + SECRET_HIDDEN));
  };

  it.each([
    "DB_PASSWORD=hunter2 and APP.SECRET.KEY: x",
    "my-app.client_secret_id = 'abc' ; next_token=def",
    "export GITHUB_TOKEN=abc; PWD=/home/ana",
    "x.y.z-password-for-db=1 tokenizer=fast max_tokens: 100",
    "secret_token_value=abc password=mytoken=x",
    `x-eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)} y`,
    `${JWT} ${JWT}-eyJ`,
    "-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----BEGIN EC PRIVATE KEY-----\nBBB\n-----END EC PRIVATE KEY-----\ntail",
    "-----BEGIN A PRIVATE KEY-----\nno end here\n-----BEGIN B PRIVATE KEY-----\nnor here",
    "one\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\nmid\n-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    "Authorization: Bearer abc password: [secret hidden] token=[secret hidden]",
    `https://ana:pw@example.com ${GH} AKIAABCDEFGHIJKLMNOP`,
    // A long suffix after the secret word (second round).
    "PASSWORD_FOR_THE_PRODUCTION_DATABASE_SERVER_IN_THE_EU_WEST_REGION_PRIMARY_REPLICA=hunter2",
    "client_secret_for_the_very_long_named_integration_with_the_partner_service_account_v2: abc123",
  ])("hides what the earlier patterns hid in %j", text => {
    expect(redactSecrets(text)).toBe(before(text));
  });

  const size = 1024 * 1024;
  const repeat = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  it.each([
    ["one long token", repeat("a")],
    ["a long run of dots and dashes", repeat(".-")],
    ["a secret word repeated in one token", repeat("password")],
    ["a secret word repeated on 4 KiB lines", repeat(`${"DB_TOKEN".repeat(511)}\n`)],
    ["private key headers without an end", repeat("-----BEGIN RSA PRIVATE KEY-----\n")],
    ["a run of -eyJ", repeat("-eyJ")],
    ["a run of sk- (safety-privacy-2)", repeat("sk-")],
    ["sk- keys one short of long enough", repeat(`sk-${"a1".repeat(9)} `)],
    ["a run of hf_ and glpat-", repeat("hf_glpat-")],
    ["URL-like runs", repeat("://a:")],
    ["a line of recipe and unit prefixes (memory-y6-1)", repeat("@-+!:")], ["a run of dashes (memory-y6-1)", repeat("-")],
    ["a run of folders (memory-y6-1)", repeat("a/(b\\${c}/")], ["a run of settings (memory-y6-1)", repeat("a=")],
    ["a run of prompts and clients (memory-z6-1)", repeat(">mysql $(Q)MYSQL ")], ["a run of quoted clients (memory-z6-1)", repeat('"MySQL.exe" ')],
    ["a run of Windows folders (memory-z6-1)", repeat("(x86)\\%a%\\$env:a\\")], ["a run of options' values (memory-z6-1)", repeat("--a=mysql ")],
  ])("takes linear time on %s (1 MiB)", (_name, text) => {
    const t0 = performance.now();
    redactSecrets(text);
    // Linear work here is tens of milliseconds; the quadratic patterns took minutes to hours at this size.
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
