/**
 * Command classes round twelve's re-rate found (commands-remote-r12-*, -c12-*, y10-4, y11-8, tasks-approvals-r12-1):
 * each test is a table of spellings of one class, with neighbours on both sides, the dangerous ones that must be caught
 * and the ordinary ones that must go on running. Pure classifier, decision and redactor; no Electron. What goes through
 * the whole run_command flow is in command-flow.test.ts.
 */

import { describe, expect, it } from "vitest";
import { runCase, type ContextName } from "../fixtures/commands/corpus";
import type { ShellId } from "../../app/main/commands/types";
import { keptQuestion } from "../../app/main/commands/autopilot";
import { redactSecrets, SECRET_HIDDEN } from "../../app/main/commands/redact";
import { classifyCommand } from "../../app/main/commands/classify";
import { wordsRuleOut } from "../../app/main/commands/flow";

interface Opts { words?: string; shell?: ShellId; context?: ContextName; downloaded?: string[]; missing?: string[] }
const result = (cmd: string, o: Opts = {}) =>
  runCase({ cmd, verdict: "run", ...(o.words ? { words: o.words } : {}), ...(o.downloaded ? { downloaded: o.downloaded } : {}), ...(o.missing ? { missing: o.missing } : {}) },
    { shell: o.shell ?? "bash", context: o.context ?? "linux" });
const decide = (cmd: string, o: Opts = {}) => result(cmd, o).decision;

// A password in halves, so no fixture looks like a real one to a scanner.
const PW = "Xk29!" + "pqLm";

describe("files that hold a mail, chat or download client's password (commands-remote-r12-1)", () => {
  it("reads them as secrets: Interactive asks and Autopilot keeps the output from the model", () => {
    for (const cmd of [
      "cat ~/.msmtprc", "cat ~/.config/msmtp/config", "cat ~/.mbsyncrc", "cat ~/.fetchmailrc", "cat ~/.offlineimaprc", "cat ~/.authinfo",
      "cat ~/.authinfo.gpg", "cat ~/.config/aerc/accounts.conf", "cat ~/.curlrc", "cat ~/.wgetrc", "cat ~/.config/hexchat/servlist.conf",
      "cat ~/.muttrc", "cat ~/.config/mutt/muttrc", "cat ~/.mutt/muttrc", "less ~/.config/isyncrc", "grep pass ~/.msmtprc",
      "cat wp-config.php", "cat /var/www/html/wp-config.php", "head -40 site/wp-config.php",
    ]) {
      const r = result(cmd);
      expect(r.decision.verdict, cmd).toBe("ask");
      expect(r.decision.rules, cmd).toContain("path.secret");
      expect(keptQuestion(r.decision, r.cls.findings), cmd).toBe("secret");
    }
  });

  it("still runs listing them, and reading the files around them that hold no password", () => {
    for (const cmd of [
      "ls -la ~", "ls ~/.config/hexchat", "cat ~/.config/hexchat/hexchat.conf", "cat wp-config-sample.php", "cat ~/.gitconfig", "cat ~/.config/aerc/aerc.conf",
      "cat Web.config", "cat pom.xml", "cat config/config.php",
    ]) expect(decide(cmd).verdict, cmd).toBe("run");
  });
});

describe("passwords in common config formats, hidden from the model (commands-remote-r12-1)", () => {
  it("hides the value of PHP's define and arrays, XML elements and attributes, and netrc and mail-client lines", () => {
    for (const [text, kept] of [
      [`define( 'DB_PASSWORD', '${PW}' );`, "define( 'DB_PASSWORD', '"],
      [`define("AUTH_KEY", "${PW}");`, `define("AUTH_KEY", "`],
      [`define('SECURE_AUTH_SALT', '${PW}');`, "define('SECURE_AUTH_SALT', '"],
      [`$config['password'] = '${PW}';`, "$config['password'] = '"],
      [`$db['default']['password'] = "${PW}";`, `$db['default']['password'] = "`],
      [`'db_password' => '${PW}',`, "'db_password' => '"],
      [`:password => "${PW}"`, `:password => "`],
      [`<password>${PW}</password>`, "<password>"],
      [`<Password>${PW}</Password>`, "<Password>"],
      [`<smtpPassword>${PW}</smtpPassword>`, "<smtpPassword>"],
      [`<Pass encoding="base64">${PW}</Pass>`, `<Pass encoding="base64">`],
      [`<add key="Password" value="${PW}"/>`, `<add key="Password" value="`],
      [`<add key="SmtpPassword" value="${PW}" />`, `<add key="SmtpPassword" value="`],
      [`<entry name="api_token" value='${PW}'/>`, `<entry name="api_token" value='`],
      [`machine smtp.x.org login ana port 587 password Tr0ub4dor&3`, "machine smtp.x.org login ana port 587 password "],
      [`account gmail\nhost smtp.gmail.com\nuser ana@gmail.com\npassword qwpzlrtxmnbvhjkd\n`, "user ana@gmail.com\npassword "],
      [`IMAPAccount work\nPass ${PW}\n`, "IMAPAccount work\nPass "],
      [`set smtp_pass = "${PW}"`, `set smtp_pass = "`],
      [`set imap_pass="${PW}"`, `set imap_pass="`],
      [`remotepass = ${PW}`, "remotepass = "],
      [`poll mail.x.org protocol imap user 'ana' there with password '${PW}' is ana here`, "with password '"],
      [`user = ana:${PW}`, "user = ana:"],
      [`--user ana:${PW}`, "--user ana:"],
      [`proxy-user = ana:${PW}`, "proxy-user = ana:"],
    ] as const) {
      const out = redactSecrets(text);
      expect(out, text).not.toContain(PW.slice(0, 5) + PW.slice(5));
      expect(out, text).not.toMatch(/Tr0ub4dor|qwpzlrtx/);
      expect(out, text).toContain(kept + SECRET_HIDDEN);
    }
  });

  it("never reads => as = followed by the value >", () => {
    expect(redactSecrets(`'password' => 'x${PW}'`)).toBe(`'password' => '${SECRET_HIDDEN}'`);
  });

  it("leaves the words around them that are not passwords", () => {
    for (const text of [
      "compass = north", "bypass = true", "passthrough = 1", "    pass\n", "pass  # nothing to do", "password reset instructions sent",
      "<passage>Some text</passage>", "<compass>north</compass>", "PassCmd \"gpg -dq ~/.mail.gpg\"", "user = ana", "<add key=\"Theme\" value=\"dark\"/>",
      "define('WP_DEBUG', true);", "'driver' => 'mysql',", "$config['base_url'] = 'https://x.example';", "<password/>", "<password></password>",
      "The password is stored in your keyring.", "passwordeval \"pass show mail\"",
    ]) expect(redactSecrets(text), text).toBe(text);
  });
});

describe("the user's no in their own ordinary words (commands-remote-r12-2)", () => {
  const ctx = { os: "linux" as const, home: "/home/ana", cwd: "/home/ana/proj", ember: { paths: ["/home/ana/.config/ember"], pids: [10], names: /^ember$/ }, downloaded: new Set<string>() };
  const ruled = (words: string, command: string) => wordsRuleOut(classifyCommand(command, "bash", ctx).findings, words);

  it("rules the step out, so Autopilot refuses it and Assisted never sends it to the check", () => {
    for (const [words, command] of [
      ["do not push the changes", "git push origin main"], ["don't push to github", "git push origin main"], ["don't push to the remote", "git push origin main"],
      ["Fix the failing tests. Do not push the changes.", "git push origin main"], ["there's no need to push", "git push origin main"],
      ["check with me before pushing", "git push origin main"], ["do not under any circumstances push to origin", "git push origin main"],
      ["do not remove any files", "rm -rf build"], ["without deleting files", "rm -rf build"], ["do not delete any folders", "rm -rf build"],
      ["don't remove any directories", "rm -rf build"], ["make no deletions", "rm -rf build"], ["don't delete my work", "rm -rf build"],
      ["do not delete my data", "rm -rf build"], ["keep all files", "rm -rf build"], ["fix the tests, don't delete any tests", "rm -rf build"],
      ["refactor but do not remove any code", "rm -rf build"], ["no file deletions", "rm -rf build"], ["keep everything", "rm -rf build"],
      ["do not publish to npm", "npm publish"], ["stop before publishing", "npm publish"], ["bump the version and stop before you publish", "npm publish"],
      ["never deploy this to production", "gh release create v1"], ["commit without pushing", "git push origin main"],
      ["don't use root", "sudo dnf install -y nginx"], ["do not use administrator rights", "sudo dnf install -y nginx"],
      ["don't install anything system-wide", "sudo dnf install -y nginx"], ["don't install any packages", "sudo dnf install -y nginx"],
      ["don't install any new dependencies", "npm install lodash"], ["never use sudo for this", "sudo systemctl restart nginx"],
    ]) expect(ruled(words, command), `${words} / ${command}`).toBe(true);
  });

  it("never rules out a step the words ask for, or one beside a no to something else", () => {
    for (const [words, command] of [
      ["push my changes", "git push origin main"], ["delete build/ but don't delete src/", "rm -rf build"], ["don't forget to push", "git push origin main"],
      ["push if the tests don't fail", "git push origin main"], ["publish it, no need to ask", "npm publish"],
      ["I don't mind if you push", "git push origin main"], ["don't hesitate to push", "git push origin main"], ["delete the build folder and keep going", "rm -rf build"],
      ["clean the build folder, keep the sources", "rm -rf build"], ["install nginx", "sudo dnf install -y nginx"], ["delete build without removing src", "rm -rf build"],
      ["remove build, never delete notes.txt", "rm -rf build"], ["don't run the linter, just push", "git push origin main"], ["keep it simple and push", "git push origin main"],
      ["keep the tests passing, delete build", "rm -rf build"], ["no problem, install it", "pip install requests"], ["don't push", "ls -la"],
    ]) expect(ruled(words, command), `${words} / ${command}`).toBe(false);
  });
});
