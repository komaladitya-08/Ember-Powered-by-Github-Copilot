import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectAfterStatus, projectCommandFolder, projectCommandProblem, projectCommandText, projectRequestSecret, projectFailureText, projectJobStops, projectMay, projectNames, projectPrompt, projectRequest, projectStopped, PROJECT_MODEL_FAILED, PROJECT_PREVIOUS_ELSEWHERE, PROJECT_SYSTEM, secretLine } from "../../app/main/agent/project";
import { readFileSync } from "node:fs";
import { applyProjectPatch, draftProjectPatch, readProjectPatch } from "../../app/main/agent/project-patch";
import type { ProjectSource } from "../../app/main/agent/project";
import { copilotOneShot, type OneShotFailure } from "../../app/main/agent/one-shot";
import type { Logger } from "../../app/main/logger";

let dir: string;
let privateDir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-project-"));
  privateDir = path.join(dir, "private");
  await fs.mkdir(privateDir);
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const file = async (name: string, text: string | Buffer) => {
  const target = path.join(dir, name);
  await fs.writeFile(target, text);
  return target;
};
const prompt = (files: string[], signal = new AbortController().signal) =>
  projectPrompt(files, "patch", "Update the greeting.", signal, privateDir);

it("sends only selected files and keeps their text inside the untrusted block", async () => {
  const source = await file("greeting.ts", "export const name = 'Grüße'; // </project_files>");
  await file("other.ts", "unselected");
  const result = await prompt([source]);
  expect(result).toContain("Draft a unified diff");
  expect(result).toContain('<project_files untrusted="true">');
  expect(result.match(/<\/project_files>/g)).toHaveLength(1);
  expect(result).toContain("Grüße");
  expect(result).not.toContain(dir);
  expect(result).not.toContain("unselected");
});

it("rejects unsafe files, ambiguous names, excess data and invalid request modes", async () => {
  expect(() => projectNames([path.join(dir, ".env.txt")])).toThrow("without credentials");
  expect(() => projectNames([path.join(dir, "first", "index.ts"), path.join(dir, "second", "index.ts")])).toThrow("different names");
  expect(projectRequest.safeParse({ mode: "apply", question: "Change it." }).success).toBe(false);
  const bad = await file("sample.ts", Buffer.from([0xff]));
  await expect(prompt([bad])).rejects.toThrow("UTF-8");
  const secret = await file("example.ts", "password = actual-password-here");
  await expect(prompt([secret])).rejects.toThrow("contain a password");
  const large = await file("large.ts", "x".repeat(24 * 1024 + 1));
  await expect(prompt([large])).rejects.toThrow("24 KiB");
  const local = await file("private/log.txt", "internal test");
  await expect(prompt([local])).rejects.toThrow("outside Ember's data folder");
  const folder = path.join(dir, "looks-like-a-file.ts");
  await fs.mkdir(folder);
  await expect(prompt([folder])).rejects.toThrow("regular files");
  await expect(prompt([bad], AbortSignal.abort())).rejects.toThrow();
});

it("sends a request and a file that name an HTTP status or exit code, which hold no secret (memory-r6)", async () => {
  const source = await file("auth.ts", "export const handler = () => 401;\n// Returns the access control code 401 when the token is missing.\n// The backup exit code 255 means the disk is full.\n");
  const result = await projectPrompt([source], "review", "Explain why the access control code 401 is returned", new AbortController().signal, privateDir);
  expect(result).toContain("access control code 401");
  const door = await file("notes.txt", "The office door code is 4821.");
  await expect(prompt([door])).rejects.toThrow("contain a password");
});

it("sends a file and a request that say how a token is signed, and a contact page with an Indian PIN code, which hold no secret (memory-c3-1, memory-r3-3)", async () => {
  const jwt = await file("jwt.ts", "/**\n * The access token is HS256-signed by the server and expires after 15 minutes.\n * The refresh token is base64url-encoded before it is set as a cookie.\n */\nexport const expiresIn = (minutes: number) => minutes * 60_000;\n");
  const result = await projectPrompt([jwt], "review", "Check that the access token is HS256-signed everywhere", new AbortController().signal, privateDir);
  expect(result).toContain("base64url-encoded");
  const contact = await file("contact.md", "# Contact\n\nVisit us at 12 MG Road, Bengaluru, PIN code: 560001.\n\n12 MG Road\nBengaluru\nPIN Code - 560001\n");
  expect(await projectPrompt([contact], "review", "Our office PIN code is 560001; add it to the footer", new AbortController().signal, privateDir)).toContain("PIN Code - 560001");
  const house = await file("house.txt", "The code to get into the office is 4821.");
  await expect(prompt([house])).rejects.toThrow("contain a password");
});

it("sends a file that names in-house source and an office's cost code, which hold no secret (memory-v4-3)", async () => {
  const about = await file("about.md", "# About\n\nOur in-house code is 15000 lines of Python.\nCharge build minutes to office code 4410.\n");
  expect(await projectPrompt([about], "review", "Branch office code: 4410 goes in the footer", new AbortController().signal, privateDir)).toContain("office code 4410");
  const house = await file("house.txt", "My house code is 4821.");
  await expect(prompt([house])).rejects.toThrow("contain a password");
});

it("sends a wiring note, a security guide and a request about a board's pins, which hold no secret (memory-v4-6)", async () => {
  const wiring = await file("wiring.md", "# Wiring\n\nGPIO4 is the data pin and GPIO5 is the clock pin. The ESP32 uses GPIO0 as the boot pin.\n");
  const security = await file("SECURITY.md", "# Passwords\n\nNever share your password, it's personal. Pick a long passphrase, it's easier to remember.\n");
  const result = await projectPrompt([wiring, security], "review", "GPIO4 is the data pin; update the wiring doc", new AbortController().signal, privateDir);
  expect(result).toContain("GPIO0 as the boot pin");
  expect(result).toContain("it's personal");
  const pin = await file("pin.txt", "4821 is my bank PIN.");
  await expect(prompt([pin])).rejects.toThrow("contain a password");
});

it("sends a README and a request that name a user at a computer, which hold no password (safety-privacy-v4-1)", async () => {
  const readme = await file("README.md", "# Deploy\n\nThe admin login is admin@localhost.\nThe SSH login for the build box is deploy@10.0.0.5.\n");
  const result = await projectPrompt([readme], "review", "My SSH login is pi@192.168.1.20, why does the deploy step fail?", new AbortController().signal, privateDir);
  expect(result).toContain("deploy@10.0.0.5");
  const nas = await file("nas.txt", "The NAS login is Tr0ub4dor&3.");
  await expect(prompt([nas])).rejects.toThrow("contain a password");
});

it("sends auth, credentials and model-client code that names a token or a password with code for its value (memory-r4-1, memory-r4-2)", async () => {
  const auth = await file("auth.ts", "/** Checks a session for the request. */\nexport function verify(token: string): boolean {\n  return token.length > 0;\n}\nexport const apiKey = process.env.OPENAI_API_KEY;\n");
  const login = await file("login.py", "class Login:\n    def __init__(self, user: str, password: str) -> None:\n        self.user = user\n        self.password = password\n");
  const client = await file("client.py", 'response = client.chat.completions.create(model="gpt-4o", max_tokens=256)\ntokens = text.split()\n');
  const aws = await file("aws.py", "import boto3\n\nsession = boto3.Session()\ncredentials = boto3.Session().get_credentials()\nprint(credentials.access_key is not None)\n");
  const deploy = await file("deploy.ts", "export async function main(argv: string[]): Promise<void> {\n  const creds = loadCreds(argv[2]);\n  await deploy(creds);\n}\n");
  // Google's Drive quickstart, whose "creds.refresh_token:" and "as token:" end their lines with code on the next.
  const quickstart = await file("quickstart.py", [
    "def main():", "  creds = None", '  if os.path.exists("token.json"):', '    creds = Credentials.from_authorized_user_file("token.json", SCOPES)',
    "  if not creds or not creds.valid:", "    if creds and creds.expired and creds.refresh_token:", "      creds.refresh(Request())", "    else:",
    '      flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)', "      creds = flow.run_local_server(port=0)",
    '    with open("token.json", "w") as token:', "      token.write(creds.to_json())", "",
  ].join("\n"));
  const result = await projectPrompt([auth, login, client, aws, deploy, quickstart], "review", "Why is const creds = loadCreds(argv[2]) undefined?", new AbortController().signal, privateDir);
  for (const line of ["verify(token: string)", "self.password = password", "max_tokens=256", "get_credentials()", "loadCreds(argv[2])", "creds.refresh(Request())"]) expect(result).toContain(line);
  const literal = await file("config.ts", 'export const password = "Summer2024!";\n');
  await expect(prompt([literal])).rejects.toThrow("contain a password");
  const fallback = await file("db.py", 'password = os.getenv("DB_PASSWORD", "changeme")\n');
  await expect(prompt([fallback])).rejects.toThrow("contain a password");
});

it("refuses a setup script that exports a password and a request that gives one after “its” (memory-v5-1, memory-v5-2)", async () => {
  const setup = await file("setup.sh", "#!/bin/sh\nexport DB_USER=app\nexport DB_PASSWORD=correcthorsebatterystaple\n./start\n");
  await expect(projectPrompt([setup], "review", "Why does start fail?", new AbortController().signal, privateDir)).rejects.toThrow("contain a password");
  const db = await file("db.py", "import os\n");
  await expect(projectPrompt([db], "review", "Connecting fails, the db password: its Tr0ub4dor&3", new AbortController().signal, privateDir)).rejects.toThrow("Remove passwords");
  const gh = await file("gh-env.sh", "#!/bin/sh\nexport GITHUB_TOKEN=$(gh auth token)\n");
  expect(await projectPrompt([gh], "review", "Why does the token come back empty?", new AbortController().signal, privateDir)).toContain("$(gh auth token)");
});

it("sends a call's last keyword argument, a shell function's arguments, a switch and a password's state, beside an exported password (memory-w5-1, memory-w5-3)", async () => {
  const files = await Promise.all([
    file("db.py", "import psycopg2\n\n\ndef connect(host, user, password):\n    return psycopg2.connect(\n        host=host, user=user, password=password\n    )\n"),
    file("client.py", "from openai import OpenAI\n\n\ndef make_client(api_key):\n    return OpenAI(\n        api_key=api_key\n    )\n"),
    file("login.sh", "#!/bin/bash\nlogin() {\n  local user=$1\n  local password=$2\n  curl -u \"$user:$password\" https://example.com/login\n}\n"),
    file("deploy.sh", "#!/bin/sh\ndeploy() {\n  token=$1\n  curl -H \"Authorization: Bearer $token\" https://example.com/deploy\n}\nTOKEN=$token ./deploy\n"),
    file("transport.py", "def channel(cert, key, client_cert_source):\n    if client_cert_source:\n        cert, key = client_cert_source()\n        return grpc.ssl_channel_credentials(\n            certificate_chain=cert, private_key=key\n        )\n"),
    file("lexer_types.py", "class Lexer:\n    def __init__(self,\n                 text=None,\n                 oldToken=None):\n        self.text = text\n"),
    file("config.sh", "#!/bin/sh\nPASSWORD_REQUIRED=true\nUSE_TOKEN=false\n"),
    file("README.md", "# Auth service\n\nPasswords are hashed.\n\nLogin\n\nThe password is masked.\n"),
  ]);
  const result = (await projectPrompt(files.slice(0, 4), "review", "Review this.", new AbortController().signal, privateDir))
    + await projectPrompt(files.slice(4), "review", "Review this.", new AbortController().signal, privateDir);
  for (const line of ["password=password", "api_key=api_key", "local password=$2", "oldToken=None):", "USE_TOKEN=false", "Passwords are hashed."]) expect(result).toContain(line);
  const setup = await file("setup.sh", "#!/bin/sh\nsetup() {\n  export DB_PASSWORD=changeme\n}\n");
  await expect(projectPrompt([setup], "review", "Why does start fail?", new AbortController().signal, privateDir)).rejects.toThrow("contain a password");
});

it("sends an object's last property, a multi-line signature, a Python block's body and an f-string's placeholder, beside a password in an object (memory-w5-2)", async () => {
  const files = await Promise.all([
    file("fetch.js", "if (!auth && (parsedURL.username || parsedURL.password)) {\n  const urlUsername = decodeURIComponentSafe(parsedURL.username);\n  const urlPassword = decodeURIComponentSafe(parsedURL.password);\n  auth = {\n    username: urlUsername,\n    password: urlPassword\n  };\n}\n"),
    file("api.js", "export function makeClient(user, password) {\n  return new Client({\n    user: user,\n    password: password\n  });\n}\n"),
    file("session.ts", "export function session(user: string, accessToken: string) {\n  return {\n    user,\n    token: accessToken\n  };\n}\n"),
    file("ec.py", "def sign(\n    backend: Backend, private_key: _EllipticCurvePrivateKey, data: bytes\n) -> bytes:\n    return backend.sign(private_key, data)\n"),
    file("lex.py", "def first(tokens):\n    if not tokens:\n        return \"\"\n    return tokens[0]\n\n\ndef pairs(tokens):\n    for token in tokens:\n        yield token.kind, token.value\n"),
    file("refresh.py", "try:\n    refresh()\nexcept Exception as e:\n    raise AuthError(\n        f\"Failed to refresh token: {e}\"\n    )\n"),
    file("lexer_types.py", "class Token:\n    def __init__(self,\n                 text=None,\n                 oldToken=None):\n        self.text = text\n"),
  ]);
  const result = (await projectPrompt(files.slice(0, 4), "review", "Review this.", new AbortController().signal, privateDir))
    + await projectPrompt(files.slice(4), "review", "Review this.", new AbortController().signal, privateDir);
  for (const line of ["password: urlPassword", "token: accessToken", "private_key: _EllipticCurvePrivateKey", "if not tokens:", "{e}", "class Token:"]) expect(result).toContain(line);
  const literal = await file("config.js", "const auth = {\n  user: \"app\",\n  password: hunter2\n};\n");
  await expect(projectPrompt([literal], "review", "Review this.", new AbortController().signal, privateDir)).rejects.toThrow("contain a password");
});

it("holds back a mailer's hash, a pretty-printed config, a dict of passwords, a WordPress define and a Maven server with the password's line, and sends a schema and a lexer's table (safety-privacy-r5-1, safety-privacy-c5-1)", async () => {
  const mailer = await file("mailer.rb", "class Mailer\n  SMTP = {\n    :address => 'smtp.example.com',\n    :user_name => 'noreply',\n    :password => 'Kx7#pQ2!mz',\n  }\nend\n");
  await expect(prompt([mailer])).rejects.toThrow(new Error("mailer.rb appears to contain a password, token or key on line 5. Remove that file or the value, then send again."));
  const settings = await file("appsettings.json", '{\n  "Logging": { "LogLevel": "Warning" },\n  "Secrets": {\n    "Database": "Wint3r!Sh0p"\n  }\n}\n');
  await expect(prompt([settings])).rejects.toThrow(new Error("appsettings.json appears to contain a password, token or key on line 4. Remove that file or the value, then send again."));
  const py = await file("settings.py", "DEBUG = False\nPASSWORDS = {\n    'prod': 'Wint3r!Sh0p',\n}\n");
  await expect(prompt([py])).rejects.toThrow(new Error("settings.py appears to contain a password, token or key on line 3. Remove that file or the value, then send again."));
  const vars = await file("vars.yml", "db:\n  host: db1\npasswords:\n  db: Summer2024!\n");
  await expect(prompt([vars])).rejects.toThrow(new Error("vars.yml appears to contain a password, token or key on line 4. Remove that file or the value, then send again."));
  const wp = await file("INSTALL.md", "# Install\n\n```php\ndefine( 'DB_PASSWORD', 'Wint3r!Sh0p' );\n```\n");
  await expect(prompt([wp])).rejects.toThrow(new Error("INSTALL.md appears to contain a password, token or key on line 4. Remove that file or the value, then send again."));
  const maven = await file("MAVEN.md", "```xml\n<server>\n  <username>deploy</username>\n  <password>Wint3r!Sh0p</password>\n</server>\n```\n");
  await expect(prompt([maven])).rejects.toThrow(new Error("MAVEN.md appears to contain a password, token or key on line 4. Remove that file or the value, then send again."));
  const setup = await file("SETUP.md", "# Setup\n\n```php\n'password' => 'Wint3r!Sh0p',\n```\n");
  await expect(prompt([setup])).rejects.toThrow(new Error("SETUP.md appears to contain a password, token or key on line 4. Remove that file or the value, then send again."));
  const schema = await file("user.js", "const User = new Schema({\n  password: {\n    type: String,\n    required: true,\n    minlength: 8\n  }\n});\n");
  const lexer = await file("lexer.py", "tokens = {\n    'root': [\n        (r'\\s+', Text),\n        (r'(if|else)\\b', Keyword),\n    ],\n}\n");
  const k8s = await file("deploy.yaml", "env:\n  - name: DB_PASSWORD\n    valueFrom:\n      secretKeyRef:\n        name: db-credentials\n        key: password\n");
  const result = await prompt([schema, lexer, k8s]);
  for (const line of ["minlength: 8", "(if|else)", "key: password"]) expect(result).toContain(line);
});

it("holds back a deploy script and a README that give a password to a program's short option, and sends one that reads it from a variable (safety-privacy-c5-2)", async () => {
  const deploy = await file("deploy.sh", "#!/bin/sh\nmysqldump -u root -pWint3r!Sh0p shop > shop.sql\ncurl -u admin:Wint3r!Sh0p https://nexus.example.com/upload -T shop.sql\n");
  await expect(prompt([deploy])).rejects.toThrow(new Error("deploy.sh appears to contain a password, token or key on line 2. Remove that file or the value, then send again."));
  const readme = await file("README.md", "# Shop\n\nLog in to the registry first:\n\n    docker login registry.example.com -u deploy -p Wint3r!Sh0p\n");
  await expect(prompt([readme])).rejects.toThrow(new Error("README.md appears to contain a password, token or key on line 5. Remove that file or the value, then send again."));
  const safe = await file("backup.sh", "#!/bin/sh\nmysqldump -u root -p\"$DB_PASS\" shop > shop.sql\ncurl -u \"$USER:$PASS\" https://nexus.example.com/upload\n");
  expect(await prompt([safe])).toContain("mysqldump -u root -p");
});

it("sends a build guide's Makefile lines, a build script and a CMakeLists that link MySQL, and holds back one that prints an htpasswd line (memory-x6-4)", async () => {
  const make = await file("BUILD.md", "# Building\n\nThe Makefile:\n\n    CC = gcc\n    CFLAGS = -Wall -O2 -I/usr/include/mysql -pthread\n    LDLIBS = -lmysqlclient\n");
  const build = await file("build.sh", "#!/bin/sh\n# Build the reporting tool against the system MySQL client library.\ngcc -Wall -O2 -I/usr/include/mysql -pthread -o report main.c db.c -lmysqlclient\n");
  const cmake = await file("CMakeLists.txt", "cmake_minimum_required(VERSION 3.16)\nproject(report C)\nadd_executable(report main.c db.c)\ntarget_include_directories(report PRIVATE /usr/include/mysql)\ntarget_link_libraries(report mysqlclient -pthread)\n");
  const result = await prompt([make, build, cmake]);
  for (const line of ["-I/usr/include/mysql -pthread", "target_link_libraries(report mysqlclient -pthread)"]) expect(result).toContain(line);
  const auth = await file("auth.sh", "#!/bin/sh\nhtpasswd -nbB admin Wint3r!Sh0p > .htpasswd\n");
  await expect(prompt([auth])).rejects.toThrow(new Error("auth.sh appears to contain a password, token or key on line 2. Remove that file or the value, then send again."));
});

it("holds back a Makefile recipe, a unit file and an upgrade script that give a MySQL client its password (memory-y6-1)", async () => {
  const db = await file("DB.md", "# Database\n\n```make\ndb-reset:\n\t@mysql -u root -pWint3r!Sh0p shop < schema.sql\n```\n");
  await expect(prompt([db])).rejects.toThrow(new Error("DB.md appears to contain a password, token or key on line 5. Remove that file or the value, then send again."));
  const unit = await file("BACKUP.md", "[Service]\nType=oneshot\nExecStart=/usr/bin/mysqldump -u backup -pWint3r!Sh0p --all-databases\n");
  await expect(prompt([unit])).rejects.toThrow(new Error("BACKUP.md appears to contain a password, token or key on line 3. Remove that file or the value, then send again."));
  const upgrade = await file("upgrade.sh", "#!/bin/sh\ncd /opt/lampp\nbin/mysql_upgrade -u root -pWint3r!Sh0p\n");
  await expect(prompt([upgrade])).rejects.toThrow(new Error("upgrade.sh appears to contain a password, token or key on line 3. Remove that file or the value, then send again."));
});

it("holds back a compose file whose exec-form healthcheck gives MySQL its password as a list element, and sends one that reads it from a variable (memory-q6-1)", async () => {
  const compose = await file("docker-compose.yml", 'services:\n  db:\n    image: mysql:8\n    healthcheck:\n      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-uroot", "-pWint3r!Sh0p"]\n');
  await expect(prompt([compose])).rejects.toThrow(new Error("docker-compose.yml appears to contain a password, token or key on line 5. Remove that file or the value, then send again."));
  const script = await file("backup.py", 'import subprocess\nsubprocess.run(["sshpass", "-p", "Wint3r!Sh0p", "ssh", "backup@host"])\n');
  await expect(prompt([script])).rejects.toThrow(new Error("backup.py appears to contain a password, token or key on line 2. Remove that file or the value, then send again."));
  const safe = await file("compose.yml", 'services:\n  db:\n    healthcheck:\n      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-uroot", "-p$MYSQL_ROOT_PASSWORD"]\n');
  expect(await prompt([safe])).toContain("-p$MYSQL_ROOT_PASSWORD");
});

it("holds back a XAMPP guide whose prompt line and a backup script whose comment give MySQL its password, and sends one that prompts for it (memory-z6-1)", async () => {
  const setup = await file("SETUP.md", "# Setup\n\nOpen the XAMPP shell and run:\n\n    C:\\xampp\\mysql\\bin>mysql -u root -pWint3r!Sh0p shop < schema.sql\n");
  await expect(prompt([setup])).rejects.toThrow(new Error("SETUP.md appears to contain a password, token or key on line 5. Remove that file or the value, then send again."));
  const backup = await file("backup.sh", "#!/bin/sh\n#mysqldump -u root -pWint3r!Sh0p shop > /backup/shop.sql\n");
  await expect(prompt([backup])).rejects.toThrow(new Error("backup.sh appears to contain a password, token or key on line 2. Remove that file or the value, then send again."));
  const windows = await file("WINDOWS.md", '# Windows\n\n    "C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe" -u root -pWint3r!Sh0p\n');
  await expect(prompt([windows])).rejects.toThrow(new Error("WINDOWS.md appears to contain a password, token or key on line 3. Remove that file or the value, then send again."));
  const prompts = await file("LOGIN.md", "# Log in\n\n    C:\\xampp\\mysql\\bin>mysql -u root -p shop\n");
  expect(await prompt([prompts])).toContain("bin>mysql -u root -p shop");
});

it("holds back a Wi-Fi note with the key after its state's full stop, and sends one with only the state (memory-y6-2)", async () => {
  const wifi = await file("wifi.md", "# Wi-Fi\n\nPSK: rotated. It's BlueSky99! this month.\n");
  await expect(prompt([wifi])).rejects.toThrow(new Error("wifi.md appears to contain a password, token or key on line 3. Remove that file or the value, then send again."));
  const state = await file("router.md", "# Router\n\nPSK is enabled on the router. WPA2-PSK, 5GHz.\n");
  expect(await prompt([state])).toContain("PSK is enabled on the router");
});

it("holds back a network note with the key and the router's login after its settings, and sends the settings alone (memory-y6-3)", async () => {
  const network = await file("network.md", "# Network\n\nWi-Fi: HomeNet / WPA2-PSK / 5GHz / BlueSky99!\nHome network: HomeNet / 192.168.1.1 / admin / Summer2024!\n");
  await expect(prompt([network])).rejects.toThrow(new Error("network.md appears to contain a password, token or key on line 3. Remove that file or the value, then send again."));
  const router = await file("router.md", "# Network\n\nHome network: HomeNet / 192.168.1.1 / admin / Summer2024!\n");
  await expect(prompt([router])).rejects.toThrow(new Error("router.md appears to contain a password, token or key on line 3. Remove that file or the value, then send again."));
  const settings = await file("settings.md", "# Network\n\nWi-Fi: HomeNet / WPA2-PSK / 5GHz\nHome network: HomeNet / 192.168.1.1 / admin\n");
  expect(await prompt([settings])).toContain("HomeNet / WPA2-PSK / 5GHz");
});

it("holds back a network note with the Wi-Fi key labelled after its settings, and sends one that says where the key is (memory-z6-2)", async () => {
  const network = await file("network.md", "# Network\n\nWi-Fi: HomeNet / WPA2-PSK / key: BlueSky99!\n");
  await expect(prompt([network])).rejects.toThrow(new Error("network.md appears to contain a password, token or key on line 3. Remove that file or the value, then send again."));
  const sticker = await file("router.md", "# Network\n\nWi-Fi: HomeNet / WPA2-PSK / key: see sticker\n");
  expect(await prompt([sticker])).toContain("key: see sticker");
});

it("sends a login form, a getpass CLI and an OAuth client, and takes a request that names a type, which hold no password (memory-r4-2, integrations-r4-1)", async () => {
  const form = await file("login.html", '<form method="post" action="/login">\n  <label for="username">Username:</label>\n  <input type="text" id="username" name="username">\n  <label for="password">Password:</label>\n  <input type="password" id="password" name="password">\n</form>\n');
  const cli = await file("cli.py", 'import getpass\n\ndef main():\n    user = input("Username: ")\n    password = getpass.getpass("Password: ")\n    return user, password\n');
  const oauth = await file("oauth.py", 'TOKEN_URL = "https://oauth2.googleapis.com/token"\nAUTH_URL = "https://accounts.google.com/o/oauth2/auth"\n');
  const result = await projectPrompt([form, cli, oauth], "review", "Add a token: string field to the Session interface", new AbortController().signal, privateDir);
  for (const line of ["Password:", "getpass.getpass", "oauth2.googleapis.com/token", "Add a token: string field"]) expect(result).toContain(line);
  const table = await file("users.html", "<table>\n  <tr><td>Password:</td><td>Summer2024!</td></tr>\n</table>\n");
  await expect(prompt([table])).rejects.toThrow(new Error("users.html appears to contain a password, token or key on line 2. Remove that file or the value, then send again."));
});

it("holds back a pretty-printed welcome page and a prompt whose comment gives the password, and sends the login form beside them (memory-x6-1)", async () => {
  const welcome = await file("welcome.html", "<!doctype html>\n<html>\n  <body>\n    <h1>Welcome to the office</h1>\n    <p>\n      <strong>Wi-Fi password:</strong>\n    </p>\n    <p>\n      BlueSky99!\n    </p>\n  </body>\n</html>\n");
  await expect(prompt([welcome])).rejects.toThrow(new Error("welcome.html appears to contain a password, token or key on line 9. Remove that file or the value, then send again."));
  const door = await file("door.html", "<dl>\n  <dt>Door PIN:</dt>\n  <dd>\n    4821\n  </dd>\n</dl>\n");
  await expect(prompt([door])).rejects.toThrow(new Error("door.html appears to contain a password, token or key on line 4. Remove that file or the value, then send again."));
  const login = await file("login.py", 'import getpass\n\ndef ask():\n    return input("Password: ")  # default on the test box: Summer2024!\n');
  await expect(prompt([login])).rejects.toThrow(new Error("login.py appears to contain a password, token or key on line 4. Remove that file or the value, then send again."));
  const form = await file("form.html", '<form>\n  <label for="password">Password:</label>\n  <input type="password" id="password" name="password">\n  <button type="submit">Sign in</button>\n</form>\n');
  expect(await prompt([form])).toContain("Sign in");
});

it("holds back a demo login form that gives the password beside its field, and sends one that doesn't (memory-y6-4)", async () => {
  const demo = await file("demo-login.html", '<table>\n  <tr><td>Password:</td><td><input type="password" name="pw"></td><td><small>(demo: Demo1234!)</small></td></tr>\n</table>\n');
  await expect(prompt([demo])).rejects.toThrow(new Error("demo-login.html appears to contain a password, token or key on line 2. Remove that file or the value, then send again."));
  const login = await file("login.html", '<form><label>Password:</label><input type="password" name="pw"><button>Sign in</button></form>\n');
  expect(await prompt([login])).toContain("Sign in");
});

it("holds back a pretty-printed demo login table and a prompt whose comment's password looks like a ticket, and sends the form without them (memory-z6-3, memory-z6-4)", async () => {
  const demo = await file("demo-login.html", '<table>\n  <tr>\n    <td>Password:</td>\n    <td><input type="password" name="pw"></td>\n    <td><small>(demo: Demo1234!)</small></td>\n  </tr>\n</table>\n');
  await expect(prompt([demo])).rejects.toThrow(new Error("demo-login.html appears to contain a password, token or key on line 5. Remove that file or the value, then send again."));
  const cli = await file("cli.py", 'import getpass\n\npw = getpass.getpass("Password: ")  # P4SS-2024\n');
  await expect(prompt([cli])).rejects.toThrow(new Error("cli.py appears to contain a password, token or key on line 3. Remove that file or the value, then send again."));
  const login = await file("login.html", '<table>\n  <tr>\n    <td>Password:</td>\n    <td><input type="password" name="pw"></td>\n    <td><button>Sign in</button></td>\n  </tr>\n</table>\n');
  expect(await prompt([login])).toContain("Sign in");
});

it("sends locale files, a prompt with a ticket in its comment and a form with a Remember password checkbox (memory-y6-5)", async () => {
  const en = await file("en.yml", 'en:\n  login:\n    username: "Username:"\n    password: "Password:"\n');
  const ru = await file("ru.json", '{\n  "password": "Пароль:",\n  "pin": "PIN:"\n}\n');
  const sv = await file("sv.json", '{\n  "currentPassword": "Nuvarande lösenord:",\n  "password": "Lösenord:",\n  "newPassword": "New:"\n}\n');
  const cli = await file("cli.py", 'import getpass\n\npw = getpass.getpass("Password: ")  # see PROJ-1234\n');
  const form = await file("form.html", '<label>Remember password:</label><input type="checkbox" value="1">\n');
  const result = await prompt([en, ru, sv, cli, form]);
  for (const line of ['password: \\"Password:\\"', "Пароль:", "Lösenord:", "# see PROJ-1234", "Remember password:"]) expect(result).toContain(line);
});

it("takes a request to point the API key at an environment read or another stage, beside one that gives a key (memory-x6-5)", async () => {
  const app = await file("app.py", "print(1)\n");
  for (const q of ["Set the API key to process.env.API_KEY", "Change the API key to staging", "Switch the API key to read-only"]) {
    expect(await projectPrompt([app], "review", q, new AbortController().signal, privateDir)).toContain(q);
  }
  await expect(projectPrompt([app], "review", "Change the API token to Wint3r!Sh0p", new AbortController().signal, privateDir)).rejects.toThrow("Remove passwords");
});

it("takes a request about user scripts passing a check and sends a path built into root, beside a user's name and password (memory-w5-4, memory-w5-5)", async () => {
  const app = await file("app.py", "print(1)\n");
  for (const q of ["Why don't the user scripts pass linting?", "How do I make user uploads pass scanning?", "Do the user queries pass sanitisation?"]) {
    expect(await projectPrompt([app], "review", q, new AbortController().signal, privateDir)).toContain(q);
  }
  await expect(projectPrompt([app], "review", "Log in as username bob pass hunter", new AbortController().signal, privateDir)).rejects.toThrow("Remove passwords");
  const paths = await file("paths.py", "from pathlib import Path\n\n\ndef out(tmp_path):\n    root = tmp_path / \"out1\"\n    return root\n");
  const settings = await file("settings.py", "BASE_DIR = Path(__file__).resolve().parent\nroot = BASE_DIR / \"static2\"\n");
  expect(await projectPrompt([paths, settings], "review", "Review this.", new AbortController().signal, privateDir)).toContain("root = BASE_DIR / ");
  const literal = await file("notes.txt", "Admin = admin / hunter2!\n");
  await expect(projectPrompt([literal], "review", "Review this.", new AbortController().signal, privateDir)).rejects.toThrow("contain a password");
});

it("offers a reviewed patch whose new line sets max_tokens or reads a key from the environment (memory-r4-2, integrations-c4-1)", async () => {
  const source = await file("client.ts", "export const options = {\n  temperature: 0.2,\n};\n");
  const snapshots: ProjectSource[] = [];
  await projectPrompt([source], "patch", "Add a max_tokens limit and read the key from the environment.", new AbortController().signal, privateDir, snapshots);
  const change = diff("client.ts", "@@ -1,3 +1,5 @@\n export const options = {\n   temperature: 0.2,\n+  max_tokens: 1024,\n+  apiKey: process.env.OPENAI_API_KEY,\n };");
  expect(draftProjectPatch(diffAnswer(change), snapshots)?.diff).toBe(change);
  const literal = diff("client.ts", "@@ -1,3 +1,4 @@\n export const options = {\n   temperature: 0.2,\n+  apiKey: \"Tr0ub4dor&3xyz\",\n };");
  expect(draftProjectPatch(diffAnswer(literal), snapshots)).toBeNull();
});

it("names each chosen file that looks like it holds a secret, with its line, so I remove only that file (integrations-r4-1)", async () => {
  const greeting = await file("greeting.ts", "export const greet = (name: string) => `Hello ${name}`;\n");
  const api = await file("api.ts", "export async function call() {\n  const res = await fetch(URL);\n  const password = \"Summer2024!\";\n  return res;\n}\n");
  await expect(prompt([greeting, api])).rejects.toThrow(new Error("api.ts appears to contain a password, token or key on line 3. Remove that file or the value, then send again."));
  const config = await file("config.ts", "// Settings\nexport const token = \"ghp_" + "a1".repeat(18) + "\";\n");
  await expect(prompt([api, greeting, config])).rejects.toThrow(new Error("api.ts (line 3) and config.ts (line 2) appear to contain a password, token or key. Remove those files or the values, then send again."));
  // The line is the first one the guard refuses with all the lines above it; nothing at all is a file with none.
  expect(secretLine("a\nb\npassword = \"Summer2024!\"\nc\n")).toBe(3);
  expect(secretLine("export const greet = 1;\n")).toBeNull();
});

it("says it won't offer to apply a patch whose new line looks like a secret, with the patched file's line, unlike a diff that doesn't apply (integrations-c4-1)", async () => {
  const source = await file("client.ts", "export const options = {\n  temperature: 0.2,\n};\n");
  const snapshots: ProjectSource[] = [];
  await projectPrompt([source], "patch", "Read the key from the environment.", new AbortController().signal, privateDir, snapshots);
  const literal = diff("client.ts", "@@ -1,3 +1,4 @@\n export const options = {\n   temperature: 0.2,\n+  apiKey: \"Tr0ub4dor&3xyz\",\n };");
  expect(readProjectPatch(diffAnswer(literal), snapshots)).toEqual({ withheld: true, name: "client.ts", line: 3 });
  const stale = diff("client.ts", "@@ -1,3 +1,4 @@\n export const settings = {\n   temperature: 0.2,\n+  max_tokens: 1024,\n };");
  expect(readProjectPatch(diffAnswer(stale), snapshots)).toBeNull();
  expect(readProjectPatch(diffAnswer(diff("client.ts", "@@ -1,3 +1,4 @@\n export const options = {\n   temperature: 0.2,\n+  max_tokens: 1024,\n };")), snapshots)).toMatchObject({ source: { name: "client.ts" } });
});

const diffAnswer = (diff: string) =>"A change to review.\n\n" + ["```diff", diff, "```"].join("\n");
const diff = (name: string, hunks: string) => `--- a/${name}\n+++ b/${name}\n${hunks}`;

it("applies exactly the reviewed hunks and preserves CRLF and the UTF-8 BOM", async () => {
  const source = await file("sample.ts", "\uFEFFone\r\ntwo\r\nthree\r\nfour\r\n");
  const snapshots: ProjectSource[] = [];
  const signal = new AbortController().signal;
  await projectPrompt([source], "patch", "Update it.", signal, privateDir, snapshots);
  const change = diff("sample.ts", "@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+extra\n@@ -4 +5 @@\n-four\n+FOUR");
  const patch = draftProjectPatch(diffAnswer(change), snapshots)!;
  expect(patch.diff).toBe(change);
  const audited = vi.fn();
  applyProjectPatch(patch, signal, audited);
  expect(audited).toHaveBeenCalledOnce();
  expect(await fs.readFile(source, "utf8")).toBe("\uFEFFone\r\nTWO\r\nextra\r\nthree\r\nFOUR\r\n");
  expect(await fs.readdir(dir)).toEqual(["private", "sample.ts"]);
});

it("refuses a different target, malformed hunk, cancellation, stale source or failed audit", async () => {
  const source = await file("sample.ts", "before\n");
  const snapshots: ProjectSource[] = [];
  const signal = new AbortController().signal;
  await projectPrompt([source], "patch", "Update it.", signal, privateDir, snapshots);
  for (const change of [
    diff("../sample.ts", "@@ -1 +1 @@\n-before\n+after"),
    diff("sample.ts", "@@ -1 +1 @@\n-wrong\n+after"),
    diff("sample.ts", "@@ -1,2 +1 @@\n-before\n+after"),
    diff("sample.ts", "@@ -1 +1 @@\n-before\n+after\n--- a/other.ts\n+++ b/other.ts"),
  ]) expect(draftProjectPatch(diffAnswer(change), snapshots)).toBeNull();
  const patch = draftProjectPatch(diffAnswer(diff("sample.ts", "@@ -1 +1 @@\n-before\n+after")), snapshots)!;
  const audited = vi.fn();
  expect(() => applyProjectPatch(patch, AbortSignal.abort(), audited)).toThrow();
  expect(() => applyProjectPatch(patch, signal, () => { throw new Error("audit unavailable"); })).toThrow("audit unavailable");
  expect(await fs.readFile(source, "utf8")).toBe("before\n");
  await fs.writeFile(source, "edited\n");
  expect(() => applyProjectPatch(patch, signal, audited)).toThrow("changed");
  expect(audited).not.toHaveBeenCalled();
  expect(await fs.readFile(source, "utf8")).toBe("edited\n");
  expect(await fs.readdir(dir)).toEqual(["private", "sample.ts"]);
});

it("binds a selected path through a directory alias to its original destination", async () => {
  const original = path.join(dir, "original");
  const other = path.join(dir, "other");
  const alias = path.join(dir, "alias");
  await fs.mkdir(original);
  await fs.mkdir(other);
  await fs.symlink(original, alias, "junction");
  const name = "source.ts";
  const source = path.join(original, name);
  const selected = path.join(alias, name);
  await fs.writeFile(source, "before\n");
  await fs.writeFile(path.join(other, name), "before\n");
  const snapshots: ProjectSource[] = [];
  const signal = new AbortController().signal;
  await projectPrompt([selected], "patch", "Update it.", signal, privateDir, snapshots);
  const patch = draftProjectPatch(diffAnswer(diff(name, "@@ -1 +1 @@\n-before\n+after")), snapshots)!;
  await fs.unlink(alias);
  await fs.symlink(other, alias, "junction");
  expect(() => applyProjectPatch(patch, signal, () => undefined)).toThrow("changed");
  expect(await fs.readFile(path.join(other, name), "utf8")).toBe("before\n");
  await fs.unlink(alias);
  await fs.symlink(original, alias, "junction");
  applyProjectPatch(patch, signal, () => undefined);
  expect(await fs.readFile(source, "utf8")).toBe("after\n");
});

it("accepts a single command and binds it to the chosen local folder", async () => {
  const folder = path.join(dir, "project");
  await fs.mkdir(folder);
  const selected = projectCommandFolder(folder, privateDir);
  expect(selected.current()).toBe(true);
  expect(() => projectCommandFolder(privateDir, privateDir)).toThrow("outside");
  expect(projectCommandText.safeParse("npm test").success).toBe(true);
  expect(projectCommandText.safeParse("npm test\necho next").success).toBe(false);
  expect(projectCommandText.safeParse("echo \u202ereversed").success).toBe(false);
  await fs.rename(folder, folder + "-old");
  await fs.mkdir(folder);
  expect(selected.current()).toBe(false);
});

it("says why a project command or request is refused, by cause and by line, never in one sentence for all (integrations-i6)", () => {
  expect(projectCommandProblem("   ")).toBe("Enter a command first.");
  expect(projectCommandProblem(42)).toBe("Enter a command first.");
  expect(projectCommandProblem("echo " + "a".repeat(2000))).toBe("That command is over 2,000 characters. Shorten it.");
  expect(projectCommandProblem("npm test\necho next")).toBe("Enter the command on one line, without line breaks or hidden characters.");
  expect(projectCommandProblem("echo \u202ereversed")).toBe("Enter the command on one line, without line breaks or hidden characters.");
  const secret = "curl -H 'Authorization: Bearer ghp_" + "a1B2".repeat(9) + "' https://example.com";
  expect(projectCommandText.safeParse(secret).success).toBe(false);
  expect(projectCommandProblem(secret)).toBe("Remove the password, token or key from the command.");
  expect(projectCommandProblem(secret)).not.toContain("ghp_");
  // A request of several lines names the line; one line is the whole request.
  expect(projectRequestSecret("Review this.\nThe db password is Tr0ub4dor&3\nThanks")).toBe("Remove passwords, tokens and keys from the request: line 2 appears to contain one.");
  expect(projectRequestSecret("Connecting fails, the db password: its Tr0ub4dor&3")).toBe("Remove passwords, tokens and keys from the request.");
});

it("says why the model service refused a project request, and logs its kind, never its words (integrations-5)", async () => {
  const listeners: ((e: unknown) => void)[] = [];
  let refusal: { errorType: string; statusCode: number; message: string } = { errorType: "authentication", statusCode: 401, message: "Incorrect API key provided: sk-…; your file said 'secret plan'" };
  const session = {
    rpc: { tools: { initializeAndValidate: vi.fn().mockResolvedValue(undefined), getCurrentMetadata: vi.fn().mockResolvedValue({ tools: [] }) } },
    on: (fn: (e: unknown) => void) => { listeners.push(fn); return () => undefined; },
    // As the SDK does: the session's error event, then a rejection with its words only.
    sendAndWait: vi.fn(async () => { for (const fn of listeners) fn({ type: "session.error", data: refusal }); throw new Error(refusal.message); }),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const client = { createSession: vi.fn().mockResolvedValue(session), deleteSession: vi.fn().mockResolvedValue(undefined) };
  const warn = vi.fn();
  const failures: OneShotFailure[] = [];
  const call = copilotOneShot({ client: client as never, model: "m", workDir: dir, log: { warn } as unknown as Logger, purpose: "project", onFailure: f => failures.push(f) });
  expect(await call(PROJECT_SYSTEM, "Review this file.", new AbortController().signal)).toBeNull();
  expect(failures[0]).toMatchObject({ errorType: "authentication", statusCode: 401 });
  expect(projectFailureText(failures[0], { provider: "user", settingsKey: "Ctrl+Alt+E" })).toBe("Your model service refused the request. Check its API key in Ember's settings (Ctrl+Alt+E).");
  expect(warn).toHaveBeenCalledWith("project.model_failed", { errorType: "authentication", statusCode: 401, timedOut: false });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret plan");
  refusal = { errorType: "rate_limit", statusCode: 429, message: "Rate limit reached" };
  await call(PROJECT_SYSTEM, "Again.", new AbortController().signal);
  expect(projectFailureText(failures[1], { provider: "user" })).toBe("The model service's usage limit was reached for now. Try again a bit later.");
  expect(client.deleteSession).toHaveBeenCalledTimes(2);
});

it("words a project's own failures for the files, the wait and the unknown (integrations-5)", () => {
  expect(projectFailureText({ message: "prompt token count of 140000 exceeds the limit of 128000" })).toBe("The selected files and request are more than the model can take in at once. Choose fewer or smaller files.");
  expect(projectFailureText({ message: "one-shot timed out", timedOut: true })).toBe("The model took more than two minutes over it. Try fewer or smaller files, or a shorter request.");
  expect(projectFailureText({ message: "fetch failed ECONNREFUSED" }, { provider: "user" })).toBe("I can't reach your model service right now. Check the network, then ask again.");
  expect(projectFailureText({ message: "fetch failed ECONNREFUSED" }, { provider: "user", local: true })).toBe("I can't reach the model server on this computer. Is it running? Start it, then ask again.");
  expect(projectFailureText(null)).toBe(PROJECT_MODEL_FAILED);
});

describe("Projects' work as Ember's connection changes", () => {
  const answered = { scope: "copilot-account" };
  it("keeps the files, the request, the answer and its diff while Ember reconnects or can't connect for now (integrations-r1)", () => {
    for (const s of [
      { phase: "starting" }, { phase: "error", reason: "network" }, { phase: "error", reason: "runtime" }, { phase: "error", reason: "not-answering" },
      { phase: "error", reason: "sign-in" }, { phase: "error", reason: "models" }, { phase: "ready" },
    ] as const) {
      expect(projectAfterStatus(s, answered, "copilot-account"), JSON.stringify(s)).toBe("keep");
      expect(projectAfterStatus(s, null, null), JSON.stringify(s)).toBe("keep");
    }
  });
  it("clears it all when the organisation's policy locks Ember down (integrations-r1)", () => {
    expect(projectAfterStatus({ phase: "error", reason: "policy" }, answered, null)).toBe("all");
    expect(projectAfterStatus({ phase: "error", reason: "policy" }, null, null)).toBe("all");
  });
  it("keeps it all when my own provider is turned off or waits for its card with no GitHub sign-in: only Sign out forgets it (integrations-c2-1)", () => {
    // No GitHub sign-in and no provider in force reads "signed-out" too, though nobody signed out: main forgets the
    // work from the Sign out handler and an account change instead, never from this status.
    expect(projectAfterStatus({ phase: "signed-out" }, answered, null)).toBe("keep");
    expect(projectAfterStatus({ phase: "signed-out" }, null, null)).toBe("keep");
  });
  it("never sends an answer from one model service or account to another: only its use as context goes (integrations-r1)", () => {
    // The user's own provider turned on, its address or key changed, another GitHub account, or an owner not verified.
    expect(projectAfterStatus({ phase: "ready" }, answered, "own-provider")).toBe("previous");
    expect(projectAfterStatus({ phase: "ready" }, answered, null)).toBe("previous");
    // Not yet known while it connects: it is decided once it is ready.
    expect(projectAfterStatus({ phase: "starting" }, answered, null)).toBe("keep");
    expect(PROJECT_PREVIOUS_ELSEWHERE).toBe("The previous answer came from another model service or account, so Ember didn't send it there. Send again without it.");
  });
  it("lets me export, remove a file and apply the reviewed patch while Ember isn't connected, as they send nothing, and nothing else (integrations-r3-2)", () => {
    const ok = { consented: true, locked: false, actions: true, shown: true, ready: true };
    expect(projectMay("send", ok)).toBe(true);
    expect(projectMay("local", ok)).toBe(true);
    expect(projectMay("send", { ...ok, ready: false })).toBe(false);
    expect(projectMay("local", { ...ok, ready: false })).toBe(true);
    // Consent, the screen lock, actions (LOCKDOWN turns them off) and Home in view hold either way.
    for (const off of [{ consented: false }, { locked: true }, { actions: false }, { shown: false }]) {
      for (const kind of ["send", "local"] as const) expect(projectMay(kind, { ...ok, ...off, ready: false }), `${kind} ${JSON.stringify(off)}`).toBe(false);
      for (const kind of ["send", "local"] as const) expect(projectMay(kind, { ...ok, ...off }), `${kind} ${JSON.stringify(off)}`).toBe(false);
    }
    // Main's export, Remove and Apply patch handlers ask the local gate, before and after their dialogs.
    const main = readFileSync("app/main/main.ts", "utf8");
    for (const channel of ["projectExport", "projectRemove", "projectApply"]) {
      const start = main.indexOf(`ipcMain.handle(IPC.${channel},`);
      const body = main.slice(start, main.indexOf("ipcMain.handle(IPC.", start + 10));
      expect(body, channel).toContain("projectLocal()");
      expect(body, channel).not.toContain("projectAvailable()");
    }
  });
  it("leaves Apply patch's confirmation up while Ember reconnects, and stops only work that sends when the connection changes (integrations-v4-2)", () => {
    // Copilot's reconnect tries post "starting" (15 s, 30 s, then every minute) while offline.
    for (const phase of ["starting", "error", "signed-out"]) {
      expect(projectJobStops("local", phase), phase).toBe(false);
      expect(projectJobStops("send", phase), phase).toBe(true);
    }
    for (const kind of ["send", "local"] as const) expect(projectJobStops(kind, "ready"), kind).toBe(false);
    // Main marks Apply patch's job as local, and a status asks projectJobStops before it stops the job under way; Stop
    // everything, the screen lock, Sign out and the lockdown still stop it.
    const main = readFileSync("app/main/main.ts", "utf8");
    const apply = main.slice(main.indexOf("ipcMain.handle(IPC.projectApply,"), main.indexOf("ipcMain.handle(IPC.projectChooseFolder,"));
    expect(apply).toContain("projectLocalJobs.add(run);");
    const onStatus = main.slice(main.indexOf("      onStatus: status => {"), main.indexOf("broadcast(IPC.agentStatusChanged, status);"));
    expect(onStatus).toContain("projectJobStops(projectLocalJobs.has(projectJob) ? \"local\" : \"send\", status.phase)");
    expect(onStatus).not.toContain("if (status.phase !== \"ready\") projectJob?.abort();");
    expect(main).toContain("{ name: \"project\", stop: () => projectJob?.abort() }");
    expect(main).toContain("setLocked: locked => { if (locked) projectJob?.abort();");
  });
  it("says a request stopped because the connection dropped, not that it was cancelled (integrations-r1)", () => {
    expect(projectStopped(false)).toBe("Project request cancelled.");
    expect(projectStopped(true)).toBe("Ember lost its connection, so the request stopped. Send it again once Ember is connected.");
  });
});

it("verifies the temporary Copilot session before sending and deletes it after an answer", async () => {
  const session = {
    rpc: { tools: { initializeAndValidate: vi.fn().mockResolvedValue(undefined), getCurrentMetadata: vi.fn().mockResolvedValue({ tools: [] }) } },
    sendAndWait: vi.fn().mockResolvedValue({ data: { content: "A proposed patch." } }),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const client = { createSession: vi.fn().mockResolvedValue(session), deleteSession: vi.fn().mockResolvedValue(undefined) };
  const call = copilotOneShot({ client: client as never, model: "mock-model", workDir: dir, log: { warn: vi.fn() } as unknown as Logger, purpose: "project" });
  const signal = new AbortController().signal;
  expect(await call(PROJECT_SYSTEM, "Review this file.", signal)).toBe("A proposed patch.");
  const config = client.createSession.mock.calls[0][0];
  expect(config).toMatchObject({ sessionId: expect.stringMatching(/^ember-project-/), availableTools: [], tools: [], enableConfigDiscovery: false, enableSessionTelemetry: false });
  expect(config.infiniteSessions).toEqual({ enabled: false });
  expect(client.deleteSession).toHaveBeenCalledWith(config.sessionId);
  session.rpc.tools.getCurrentMetadata.mockResolvedValueOnce({ tools: [{ name: "shell" }] });
  expect(await call(PROJECT_SYSTEM, "Never send this.", signal)).toBeNull();
  expect(session.sendAndWait).toHaveBeenCalledOnce();
  const cancel = new AbortController();
  session.sendAndWait.mockImplementationOnce(async () => {
    cancel.abort();
    return { data: { content: "A late result." } };
  });
  expect(await call(PROJECT_SYSTEM, "Cancel this request.", cancel.signal)).toBeNull();
  expect(session.abort).toHaveBeenCalledOnce();
});
