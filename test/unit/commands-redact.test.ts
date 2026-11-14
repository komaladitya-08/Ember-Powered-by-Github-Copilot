/**
 * Secret redaction (design §3.11 step 4): each pattern hides its value as "[secret hidden]", keeps what names it, and
 * leaves ordinary text alone; commandLineSecret finds the same tokens typed into a command (§3.5.4).
 */

import { describe, expect, it } from "vitest";
import { commandLineSecret, REDACT_PASSES, redactSecrets, SECRET_HIDDEN, UNGUARDED_PASSES } from "../../app/main/commands/redact";
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

  // A password that is its own element of a list of a program's arguments: a compose file's exec-form healthcheck, a
  // subprocess list, `docker inspect`'s Test array, a YAML list (memory-q6-1).
  it.each([
    ['test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-uroot", "-phunter2"]', `test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-uroot", "-p${SECRET_HIDDEN}"]`],
    ['subprocess.run(["mysql", "-u", "root", "-pSummer2024!", "db"])', `subprocess.run(["mysql", "-u", "root", "-p${SECRET_HIDDEN}", "db"])`],
    ['"Test": [\n  "CMD",\n  "/usr/bin/mysql",\n  "-uroot",\n  "-pS3cretPass",\n  "-e",\n  "SELECT 1"\n]', `"Test": [\n  "CMD",\n  "/usr/bin/mysql",\n  "-uroot",\n  "-p${SECRET_HIDDEN}",\n  "-e",\n  "SELECT 1"\n]`],
    ["execFile('mysqldump', ['-u', 'root', '-pWint3r, Sh0p', 'shop'])", `execFile('mysqldump', ['-u', 'root', '-p${SECRET_HIDDEN}', 'shop'])`],
    ["test: [CMD, mysqladmin, ping, -uroot, -phunter2]", `test: [CMD, mysqladmin, ping, -uroot, -p${SECRET_HIDDEN}]`],
    ["test:\n  - CMD\n  - mysqladmin\n  - ping\n  - -phunter2\n", `test:\n  - CMD\n  - mysqladmin\n  - ping\n  - -p${SECRET_HIDDEN}\n`],
    ['["mysql", "-u", "root", "--password", "hunter2"]', `["mysql", "-u", "root", "--password", "${SECRET_HIDDEN}"]`],
    ['["vault", "login", "--token", "hvs.abc123"]', `["vault", "login", "--token", "${SECRET_HIDDEN}"]`],
    ['["redis-cli", "-a", "hunter2", "ping"]', `["redis-cli", "-a", "${SECRET_HIDDEN}", "ping"]`],
    ['["sshpass", "-p", "hunter2", "ssh", "host"]', `["sshpass", "-p", "${SECRET_HIDDEN}", "ssh", "host"]`],
    ["command: [sshpass, -p, hunter2, ssh, host]", `command: [sshpass, -p, ${SECRET_HIDDEN}, ssh, host]`],
    ['["curl", "-u", "admin:hunter2", "https://x"]', `["curl", "-u", "admin:${SECRET_HIDDEN}", "https://x"]`],
    ['["curl", "-s", "--user", "admin:hunter2", "https://x"]', `["curl", "-s", "--user", "admin:${SECRET_HIDDEN}", "https://x"]`],
    ['["docker", "login", "-u", "ci", "-p", "hunter2", "registry.example.com"]', `["docker", "login", "-u", "ci", "-p", "${SECRET_HIDDEN}", "registry.example.com"]`],
    ['["mongosh", "-u", "admin", "-p", "hunter2", "--eval", "db.runCommand({ ping: 1 })"]', `["mongosh", "-u", "admin", "-p", "${SECRET_HIDDEN}", "--eval", "db.runCommand({ ping: 1 })"]`],
  ])("hides the password in %j, an element of a list of arguments (memory-q6-1)", (text, want) => {
    expect(redactSecrets(text)).toBe(want);
  });
  it.each([
    ['["mysql", "-u", "root", "-p", "db"]'], ['["mysql", "-h", "db", "-P", "3306", "-u", "root", "-p"]'], ['test: ["CMD", "mysqladmin", "ping", "-p"]'],
    ['["mysql", "-u", "root", "-p$MYSQL_ROOT_PASSWORD"]'], ['["mysql", "-u", "root", "-p${MYSQL_ROOT_PASSWORD}"]'], ['["mysql", "-pPASSWORD"]'],
    ['["mysql", "--password", "$DB_PASS"]'], ['parser.add_argument("--password", "-p", help="prompt for it")'], ['["sshpass", "-p", "$SSHPASS", "ssh", "host"]'],
    ['["curl", "-u", "admin", "https://x"]'], ['["curl", "-u", "$USER:$PASS", "https://x"]'], ['["ssh", "-p", "2222", "host"]'], ['["docker", "run", "-p", "8080:80", "nginx"]'],
    ['["gcc", "-I/usr/include/mysql", "-pthread"]'], ['.option("--token", "the API token to use")'], ["I tried mysql, redis and -pthread builds"],
    ['["redis-cli", "-a", "$REDIS_PASSWORD", "ping"]'], ['["redis-cli", "-h", "cache", "ping"]'],
    ['["ffmpeg", "-i", "in.mp4", "-pass", "1", "-an"]'], ['["openssl", "rsa", "-passin", "file:key.pem"]'], ['click.option("--password", "password")'],
  ])("leaves %j alone: an option that prompts, a variable, a port or another program's option (memory-q6-1)", text => {
    expect(redactSecrets(text)).toBe(text);
  });

  // The pair wherever a list of arguments is built, as the first arguments of a call or a tuple too (memory-x7-1,
  // memory-y7-2).
  it.each([
    ['exec.Command("vault", "login", "--token", "hvs.abc123")', `exec.Command("vault", "login", "--token", "${SECRET_HIDDEN}")`],
    ['["deploy", "--db-pass", "Wint3r!Sh0p"]', `["deploy", "--db-pass", "${SECRET_HIDDEN}"]`],
    ['["cast", "send", "--private-key", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478"]', `["cast", "send", "--private-key", "${SECRET_HIDDEN}"]`],
    ['["app", "--api-key", "swordfish"]', `["app", "--api-key", "${SECRET_HIDDEN}"]`],
    ['run(\n  "app",\n  "--password",\n  "hunter2",\n)', `run(\n  "app",\n  "--password",\n  "${SECRET_HIDDEN}",\n)`],
    ['args.push("--password", "hunter2")', `args.push("--password", "${SECRET_HIDDEN}")`],
    ["args.push( '--api-key', 'Zx9Qw7Lm2Pa4' )", `args.push( '--api-key', '${SECRET_HIDDEN}' )`],
    ['cmd.extend(("--password", "hunter2"))', `cmd.extend(("--password", "${SECRET_HIDDEN}"))`],
    ['argv = ("--password", "hunter2", "--host", "db")', `argv = ("--password", "${SECRET_HIDDEN}", "--host", "db")`],
    ['Arrays.asList("--db-password", "Tr0ub4dor&3")', `Arrays.asList("--db-password", "${SECRET_HIDDEN}")`],
    ['listOf("--token", "s3cr3tT0ken99")', `listOf("--token", "${SECRET_HIDDEN}")`],
    ['["--one-time-password", "482193"]', `["--one-time-password", "${SECRET_HIDDEN}"]`],
    ['["--password", "Pa/ss.word"]', `["--password", "${SECRET_HIDDEN}"]`],
    // Look-alikes of what is left alone below: a value that only starts like a word or a name, an option that only
    // starts with "no", a pair after a switch, and a pair inside a mapping (memory-x7-1).
    ['["--token", "none1234"]', `["--token", "${SECRET_HIDDEN}"]`],
    ['["--password", "strings"]', `["--password", "${SECRET_HIDDEN}"]`],
    ['("--password", "store_true!")', `("--password", "${SECRET_HIDDEN}")`],
    ['["--api-key", "api_key_9f8e7d6c"]', `["--api-key", "${SECRET_HIDDEN}"]`],
    ['["--token", "Auth_Token"]', `["--token", "${SECRET_HIDDEN}"]`],
    ['["--nonce-token", "abc123xyz"]', `["--nonce-token", "${SECRET_HIDDEN}"]`],
    ['["psql", "--no-password", "--password", "hunter2"]', `["psql", "--no-password", "--password", "${SECRET_HIDDEN}"]`],
    ['{"cmd": ["--password", "hunter2"], "description": "x"}', `{"cmd": ["--password", "${SECRET_HIDDEN}"], "description": "x"}`],
    ['args.push("--password", "hunter2"); opts = {"name": "x"}', `args.push("--password", "${SECRET_HIDDEN}"); opts = {"name": "x"}`],
    ['["--secret", "top_secret"]', `["--secret", "${SECRET_HIDDEN}"]`],
    ['["--token", "s3cr3t_token"]', `["--token", "${SECRET_HIDDEN}"]`],
    ['("--password", "winter2024_password")', `("--password", "${SECRET_HIDDEN}")`],
    ['parser.add_argument("--token", "auth_token", help="x")', `parser.add_argument("--token", "${SECRET_HIDDEN}", help="x")`],
    ['case "--password", "hunter2":', `case "--password", "${SECRET_HIDDEN}":`],
    ['switch (a) { case "--password", "hunter2": }', `switch (a) { case "--password", "${SECRET_HIDDEN}": }`],
  ])("hides the value in %j (memory-x7-1, memory-y7-2)", (text, want) => {
    expect(redactSecrets(text)).toBe(want);
  });
  // What only looks like the pair, kept at 6b750a2 and hidden by round seven's list pattern (memory-x7-1): an option
  // that takes no value (`--no-password`), the option's own name as code writes it (click's explicit name, a dest), a
  // null or type word, or a mapping's key after it.
  it.each([
    ['["psql", "--no-password", "shop"]'], ['["pg_dump", "--no-password", "mydb"]'], ['["--no-token", "anything"]'],
    ['["--token", "none"]'], ['["--api-key", "null"]'], ['("--password", "store_true")'], ["  ['--token', 'string'],"],
    ['  ["--password", "string", "The password"],'], ['("--secret", "None")'],
    ['{"name": "--password", "description": "Password for the database"}'],
    ['@click.option("--api-key", "api_key", envvar="API_KEY", help="API key")'], ['@click.option("--access-token", "access_token", required=True)'],
    ['@click.option("--client-secret", "client_secret")'], ['@click.option("--db-password", "db_password", prompt=True)'],
    ['options = [{"name": "--token", "description": "Access token"}]'],
  ])("leaves %j alone: no value, the option's own name, a type or a mapping's key (memory-x7-1)", text => {
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

describe("redactSecrets: shapes that came through unhidden (commands-remote-r9-9)", () => {
  it.each([
    ["-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----\nafter", `${SECRET_HIDDEN}\nafter`],
    [`AGE-SECRET-KEY-1${"Q".repeat(58)}`, SECRET_HIDDEN],
    [`token pypi-${"A".repeat(60)} set`, `token ${SECRET_HIDDEN} set`],
    [`hvs.${"a".repeat(24)}`, SECRET_HIDDEN],
    [`ya29.a0AfH6SMBx-EXAMPLE_token_value_abcdefghijklmnop`, SECRET_HIDDEN],
    [`ops_${"e".repeat(60)}`, SECRET_HIDDEN],
    [`dp.st.dev.${"a".repeat(40)}`, SECRET_HIDDEN],
    [`bot 123456789:${"A".repeat(35)} up`, `bot ${SECRET_HIDDEN} up`],
    [`${"M".repeat(24)}.${"a".repeat(6)}.${"b".repeat(27)}`, SECRET_HIDDEN],
    ["root:$6$rounds=5000$saltsalt$" + "h".repeat(40) + ":19000:0:99999:7:::", `root:${SECRET_HIDDEN}:19000:0:99999:7:::`],
    ["ana:$apr1$" + "s".repeat(8) + "$" + "h".repeat(22), `ana:${SECRET_HIDDEN}`],
    ["https://a.blob.core.windows.net/c/b?sv=2022&sig=" + "s".repeat(43) + "%3D&se=2026", `https://a.blob.core.windows.net/c/b?sv=2022&sig=${SECRET_HIDDEN}&se=2026`],
    ["< set-cookie: sessionid=abc123def456; Path=/; HttpOnly", `< set-cookie: sessionid=${SECRET_HIDDEN}; Path=/; HttpOnly`],
    ["802-11-wireless-security.psk:           hunter2hunter2", `802-11-wireless-security.psk:           ${SECRET_HIDDEN}`],
    ["    Key Content            : hunter2hunter2", `    Key Content            : ${SECRET_HIDDEN}`],
    ['{\n  "id": "https://v.vault.azure.net/secrets/db/1",\n  "name": "db",\n  "value": "S3cr3t!Passw0rd"\n}', `{\n  "id": "https://v.vault.azure.net/secrets/db/1",\n  "name": "db",\n  "value": "${SECRET_HIDDEN}"\n}`],
  ])("hides %j", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("leaves ordinary text that only looks a little like them", () => {
    for (const text of ["awk '{print $1$2$3}' a.txt", "12:34:56 build ok", "version 1234567890:abc", "Key Content of the page", "the psk is set in Settings",
      "https://x.example/?signature=short", "{\n  \"value\": \"plain\"\n}", "-----BEGIN PGP PUBLIC KEY BLOCK-----\nabc\n-----END PGP PUBLIC KEY BLOCK-----"]) {
      expect(redactSecrets(text), text).toBe(text);
    }
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
    ["a run of quoted clients in a list (memory-q6-1)", repeat('"mysql", ')], ["a run of list elements (memory-q6-1)", repeat('"a", ')],
    ["a run of bare clients in a list (memory-q6-1)", repeat("mysql, ")], ["a YAML list of clients (memory-q6-1)", repeat("  - mysql\n")],
    ["a run of secret-named options in a list (memory-q6-1)", repeat('"--password", ')], ["a run of sshpass elements (memory-q6-1)", repeat('"sshpass", "-p", ')],
    ["a run of switched-off options in a list (memory-x7-1)", repeat('"--no-password", ')], ["a run of null values in a list (memory-x7-1)", repeat('"--token", "none", ')],
    ["a run of own names in a list (memory-x7-1)", repeat('"--api-key", "api_key", ')], ["a value before a run of spaces (memory-x7-1)", `"--password", "hunter2"${" ".repeat(size)}`],
    ["a run of capital values (memory-x7-1)", `"--password", "${"A".repeat(size)}`],
  ])("takes linear time on %s (1 MiB)", (_name, text) => {
    const t0 = performance.now();
    redactSecrets(text);
    // Linear work here is tens of milliseconds; the quadratic patterns took minutes to hours at this size.
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("an Azure Key Vault secret printed with its tags (commands-classes-x9-7)", () => {
  /** `az keyvault secret show`'s own output: the fields in az's order, the tags between the id and the value. */
  const shown = (tags: string, value = "Hunter2-Production-Pass"): string => `{
  "attributes": {
    "created": "2026-01-01T00:00:00+00:00",
    "enabled": true,
    "expires": null,
    "recoveryLevel": "Recoverable+Purgeable"
  },
  "contentType": null,
  "id": "https://myvault.vault.azure.net/secrets/db-password/0123456789abcdef0123456789abcdef",
  "kid": null,
  "managed": null,
  "name": "db-password",
  "tags": ${tags},
  "value": "${value}"
}`;

  it.each([
    ["no tags", "null"], ["empty tags", "{}"], ["one tag", '{\n    "env": "prod"\n  }'], ["several tags", '{\n    "env": "prod",\n    "owner": "ana",\n    "file-encoding": "utf-8"\n  }'],
    ["tags on one line", '{"env": "prod"}'],
  ])("hides the value with %s", (_name, tags) => {
    const out = redactSecrets(shown(tags));
    expect(out).not.toContain("Hunter2");
    expect(out).toBe(shown(tags, SECRET_HIDDEN));
  });

  it("hides the secret's value, not a tag's, when a tag is named \"value\"", () => {
    const out = redactSecrets(shown('{\n    "value": "a-tag"\n  }'));
    expect(out).not.toContain("Hunter2");
    expect(out).toContain('"value": "a-tag"');
  });

  it("hides the whole value when it holds a quote written with a backslash", () => {
    const out = redactSecrets(shown("{}", 'Hun\\"ter2-Tail'));
    expect(out).not.toContain("ter2-Tail");
    expect(out).toBe(shown("{}", SECRET_HIDDEN));
  });

  it("hides each value of several secrets printed one after another, and leaves a list that shows no value", () => {
    const two = `[${shown("{}", "First-Secret-Value")},\n${shown('{"env": "prod"}', "Second-Secret-Value")}]`;
    const out = redactSecrets(two);
    expect(out).not.toContain("First-Secret-Value");
    expect(out).not.toContain("Second-Secret-Value");
    const list = '[\n  {\n    "id": "https://v.vault.azure.net/secrets/a",\n    "tags": {}\n  },\n  {\n    "id": "https://v.vault.azure.net/secrets/b",\n    "tags": null\n  }\n]';
    expect(redactSecrets(list)).toBe(list);
  });

  it("hides the value when a note between the id and the value mentions another secrets address (merge review integ-y-1)", () => {
    // A note naming a secrets address with no quote within 200 characters after it is no secret's id, and once stopped
    // the id's look for its value there, so the value went on (dfbac18, reverted).
    const text = `{"id": "https://v.vault.azure.net/secrets/a/1", "note": "see vault.azure.net/secrets/ ${"x ".repeat(110)}", "value": "Zq8vP2mXw4"}`;
    expect(redactSecrets(text)).not.toContain("Zq8vP2mXw4");
  });

  it.each([
    ["on one line", '{"value":"Zq8vP2mXw4","id":"https://v.vault.azure.net/secrets/a/4387e","attributes":{"enabled":true}}'],
    ["pretty-printed", '{\n  "value": "Zq8vP2mXw4",\n  "id": "https://v.vault.azure.net/secrets/a/4387e"\n}'],
    ["with its content type between", '{"value":"Zq8vP2mXw4","contentType":"text/plain","id":"https://v.vault.azure.net/secrets/a/4387e"}'],
    ["holding a quote written with a backslash", '{"value":"Zq8v\\"P2mXw4","id":"https://v.vault.azure.net/secrets/a/4387e"}'],
  ])("hides the value the REST API prints before the secret's id, %s (merge review integ-y-3)", (_name, text) => {
    const out = redactSecrets(text);
    expect(out).not.toContain("Zq8v");
    expect(out).not.toContain("P2mXw4");
    expect(out).toContain(SECRET_HIDDEN);
    expect(out).toContain("vault.azure.net/secrets/a/4387e");
  });

  it("leaves a value whose id is no Key Vault secret's, and stays quick on a run of values (merge review integ-y-3)", () => {
    const plain = '{"value":"keep-me","id":"https://example.com/items/1"}';
    expect(redactSecrets(plain)).toBe(plain);
    const run = '"value":"a", "x": 1, '.repeat(200_000);
    const t = Date.now();
    redactSecrets(run);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("stays quick on a long output that never closes", () => {
    const id = '"id": "https://v.vault.azure.net/secrets/a/1", ';
    for (const text of [id.repeat(4000), id + "{".repeat(200_000), id + '{"a":1}'.repeat(30_000), `${id}"value": "${"\\".repeat(200_001)}`]) {
      const t = Date.now();
      redactSecrets(text);
      expect(Date.now() - t).toBeLessThan(2000);
    }
  });
});

describe("redactSecrets: environments, tables and webhook addresses (commands-remote-r10-6, -c10-1)", () => {
  it.each([
    ["DB_PASS=hunter2horse", `DB_PASS=${SECRET_HIDDEN}`],
    ["ADMIN_PASS=hunter2horse\nSMTP_PASS=x9y8z7", `ADMIN_PASS=${SECRET_HIDDEN}\nSMTP_PASS=${SECRET_HIDDEN}`],
    ["PASSPHRASE=hunter2horse", `PASSPHRASE=${SECRET_HIDDEN}`],
    ["AUTH=hunter2horse", `AUTH=${SECRET_HIDDEN}`],
    ["REDIS_AUTH=hunter2horse", `REDIS_AUTH=${SECRET_HIDDEN}`],
    ["MYSQL_PW=hunter2horse", `MYSQL_PW=${SECRET_HIDDEN}`],
    ["SIGNING_KEY=abcdef0123", `SIGNING_KEY=${SECRET_HIDDEN}`],
    ["PATH=/usr/bin DB_PASS=hunter2horse HOME=/root", `PATH=/usr/bin DB_PASS=${SECRET_HIDDEN} HOME=/root`],
    ["REDIS_URL=redis://:Sekr1tPw@cache:6379", `REDIS_URL=redis://${SECRET_HIDDEN}@cache:6379`],
    ["amqp://:guestpw@rabbit/", `amqp://${SECRET_HIDDEN}@rabbit/`],
    ["DJANGO_KEY=django-insecure-abcdefghijklmnop", `DJANGO_KEY=${SECRET_HIDDEN}`],
    ["SECRET=django-insecure-a8#k!z@q2&w", `SECRET=${SECRET_HIDDEN}`],
    ["hook https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX done", `hook https://hooks.slack.com/services/${SECRET_HIDDEN} done`],
    ["https://discord.com/api/webhooks/123456789/abcDEF_ghi-jkl", `https://discord.com/api/webhooks/123456789/${SECRET_HIDDEN}`],
    ["https://acme.webhook.office.com/webhookb2/abc-123@def/IncomingWebhook/xyz/0", `https://acme.webhook.office.com/webhookb2/${SECRET_HIDDEN}`],
    ["KEY                VALUE\ndbPassword         hunter2-correct-horse\napiToken           ZXhhbXBsZV90b2tlbl92YWx1ZQ",
      `KEY                VALUE\ndbPassword         ${SECRET_HIDDEN}\napiToken           ${SECRET_HIDDEN}`],
    ["    OUTPUT       VALUE\n    dbPassword   Tr0ub4dor&3xyz\n    adminKey     a1b2c3d4e5f6g7h8i9j0",
      `    OUTPUT       VALUE\n    dbPassword   ${SECRET_HIDDEN}\n    adminKey     ${SECRET_HIDDEN}`],
    ["│ DB_PASSWORD │ hunter2 │ All │", `│ DB_PASSWORD │ ${SECRET_HIDDEN} │ All │`],
  ])("hides the value in %j", (text, want) => {
    expect(redactSecrets(text)).toBe(want);
  });

  it.each([
    "tests pass: 12, fail: 0", "PATH=/usr/bin HOME=/root", "secretstorage   3.3.1", "tokenizer.json   12K", "monkey    3", "Bypass the cache",
    "https://example.com/a?b=c", "keyboard  us", "LOW_PASS=8000 HIGH_PASS=200 RENDER_PASS=shadow2",
  ])("leaves ordinary text alone: %j", text => {
    expect(redactSecrets(text)).toBe(text);
  });

  it.each([["names ending like a secret", "a_pass=b "], ["table rows", "dbPassword   x\n"], ["webhook prefixes", "hooks.slack.com/services/"], ["empty users", "://:@"]])(
    "takes linear time on a run of %s (1 MiB)", (_name, unit) => {
      const text = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
      const t0 = performance.now();
      redactSecrets(text);
      expect(performance.now() - t0).toBeLessThan(1500);
    });
});

describe("redactSecrets: short secret names as YAML and JSON print them, schemes and tab-parted rows (r10-commands-x10-5)", () => {
  it.each([
    ["environment:\n  DB_PASS: hunter2\n  REDIS_AUTH: abc", `environment:\n  DB_PASS: ${SECRET_HIDDEN}\n  REDIS_AUTH: ${SECRET_HIDDEN}`],
    ["SIGNING_KEY: abc", `SIGNING_KEY: ${SECRET_HIDDEN}`], ["DB_PW: abc", `DB_PW: ${SECRET_HIDDEN}`], ["  db_pass: 'hunter2'", `  db_pass: '${SECRET_HIDDEN}'`],
    ["  - SMTP_PASS: x9y8z7", `  - SMTP_PASS: ${SECRET_HIDDEN}`], ['{"DB_PASS": "x1", "API_KEY": "y2"}', `{"DB_PASS": "${SECRET_HIDDEN}", "API_KEY": "${SECRET_HIDDEN}"}`],
    ["AUTH=Basic dXNlcjpwYXNz", `AUTH=${SECRET_HIDDEN}`], ["HTTP_AUTH=Bearer abc.def.ghi", `HTTP_AUTH=${SECRET_HIDDEN}`], ["PROXY_AUTH: Basic dXNlcjpwYXNz", `PROXY_AUTH: ${SECRET_HIDDEN}`],
    ["DB_PASSWORD\thunter2", `DB_PASSWORD\t${SECRET_HIDDEN}`],
  ])("hides the value in %j", (text, want) => {
    expect(redactSecrets(text)).toBe(want);
  });

  it.each(["The PASS: rate was high", "- key: app", "  key: password", "auth: required", "LOW_PASS: 8000", "secretKeyRef:", "Checks passed: 12"])(
    "leaves prose and ordinary fields alone: %j", text => {
      expect(redactSecrets(text)).toBe(text);
    });

  it("takes linear time on a run of YAML names ending like a secret (1 MiB)", () => {
    const text = "  a_pass: b\n".repeat(Math.ceil((1024 * 1024) / 12));
    const t0 = performance.now();
    redactSecrets(text);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("the Azure Key Vault passes on output with no value in it (stop-yield-x9-left-1)", () => {
  const ids = '"https://kv.vault.azure.net/secrets/name-1/abc"\n';
  const big = ids.repeat(Math.ceil((4 * 1024 * 1024) / ids.length));
  const fold = (passes: readonly ((t: string) => string)[], text: string) => passes.reduce((t, pass) => pass(t), text);

  it("takes one pass well under Stop's 300 ms over 4 MiB of secret ids with no value", () => {
    // The best of three runs of each pass, so another program's load on the machine isn't counted (here: about 170 ms,
    // the vault pass's 1,500 to 2,200 ms before).
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
    expect(worst).toBeLessThan(300);
  }, 60_000);

  it("gives the same bytes as the passes without the check, with a value or without one", () => {
    expect(fold(REDACT_PASSES, big)).toBe(fold(UNGUARDED_PASSES, big));
    const pieces = ['"id": "https://kv.vault.azure.net/secrets/a/1"', '"value": "s3cr3t"', '"value":"x\\"y"', ", ", '"tags": {"value": "t"}', "{", "}", "\n", "vault.azure.net/secrets/",
      '"value"', ' "contentType": "text/plain"', '"id"', ": ", '"', "value", "vault.azure.net"];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let k = 0; k < 2000; k++) {
      const text = Array.from({ length: 1 + rnd(14) }, () => pieces[rnd(pieces.length)]).join("");
      expect(fold(REDACT_PASSES, text), text).toBe(fold(UNGUARDED_PASSES, text));
    }
    // (The unguarded fold over 4 MiB is the slow search itself: seconds on a loaded machine.)
  }, 60_000);
});
