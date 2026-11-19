import { expect, it } from "vitest";
import { codingBwrapAudit, codingNamespaceProbe, codingUsernsProfile } from "../../scripts/ci/coding-userns-preflight.mjs";

it("retains only fixed denial fields for the exact Bubblewrap command, without journal paths or arguments", () => {
  const audit = 'audit: apparmor="DENIED" operation="capable" profile="unprivileged_userns" comm="bwrap" capability=12 capname="net_admin" args="PRIVATE_PROMPT" name="/home/private-path"\n';
  expect(codingBwrapAudit(audit)).toEqual([{ profile: "unprivileged_userns", operation: "capable", capability: 12, capname: "net_admin" }]);
  expect(JSON.stringify(codingBwrapAudit(audit))).not.toMatch(/PRIVATE_PROMPT|home|private-path/);
  expect(codingBwrapAudit(audit.replace('comm="bwrap"', 'comm="other"'))).toEqual([]);
  expect(codingBwrapAudit(audit.replace('apparmor="DENIED"', 'apparmor="ALLOWED"'))).toEqual([]);
});

it("bounds records and withholds arbitrary audit labels and unsupported fields", () => {
  expect(codingBwrapAudit("x".repeat(65_537))).toEqual([]);
  const unknown = 'apparmor="DENIED" operation="PRIVATE_PROMPT" profile="SECRET_LABEL" comm="bwrap" capability=999 capname="SECRET_CAP"';
  expect(codingBwrapAudit(unknown)).toEqual([{ profile: "other", operation: "other", capability: null, capname: null }]);
  expect(codingBwrapAudit((unknown + "\n").repeat(80)).length).toBeLessThanOrEqual(40);
});

it("grants only userns permission to the exact root-owned Bubblewrap path and preserves the full namespace probe", () => {
  expect(codingUsernsProfile).toMatch(/profile ember-ci-bwrap \/usr\/bin\/bwrap flags=\(unconfined\) \{\s*userns,\s*\}/);
  expect(codingUsernsProfile).not.toMatch(/\*|capability|change_profile|\/\*\*/);
  for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--new-session", "--die-with-parent", "--clearenv"]) expect(codingNamespaceProbe).toContain(flag);
  expect(codingNamespaceProbe.slice(-2)).toEqual(["--", "/usr/bin/true"]);
  expect(codingNamespaceProbe).not.toContain("--share-net");
});
