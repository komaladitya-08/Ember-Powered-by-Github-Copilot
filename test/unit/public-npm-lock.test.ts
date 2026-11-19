/** A public-dependency switch grants no arbitrary URL, private registry, local file or mutable plan authority. */
import { expect, it } from "vitest";
import { PublicNpmPlan, publicNpmPlanData, publicNpmIntegrity, PUBLIC_NPM_LIMITS } from "../../app/main/agent/public-npm-lock";
import { npmFixture } from "../fixtures/coding/public-npm";

it("issues one immutable public package set bound to exact source digests", () => {
  const f = npmFixture(), plan = PublicNpmPlan.create(f.inputs), data = publicNpmPlanData(plan);
  expect(plan.summary).toMatchObject({ packageCount: 1, registry: "https://registry.npmjs.org", compressedByteLimit: 64 * 1024 * 1024 });
  expect(data.packages).toEqual([f.artifact]); expect(Object.isFrozen(plan.summary.packages)).toBe(true);
  expect(() => publicNpmPlanData(JSON.parse(JSON.stringify(plan)))).toThrow();
  expect(() => publicNpmPlanData(Reflect.construct(PublicNpmPlan, [plan.summary]))).toThrow();
  const original = plan.summary.lockSha256; f.inputs.packageLock.fill(0); expect(plan.summary.lockSha256).toBe(original);
});
it.each(["http", "foreign", "userinfo", "port", "query", "fragment", "encoded", "wrong-version", "git", "file"])("rejects %s registry selection before a downloader can receive a plan", kind => {
  const f = npmFixture(), entry = f.lock.packages[`node_modules/${f.artifact.name}`];
  const url = f.artifact.resolved;
  entry.resolved = kind === "http" ? url.replace("https:", "http:") : kind === "foreign" ? url.replace("registry.npmjs.org", "registry.example")
    : kind === "userinfo" ? url.replace("https://", "https://user:secret@") : kind === "port" ? url.replace(".org/", ".org:443/")
    : kind === "query" ? url + "?data=x" : kind === "fragment" ? url + "#x" : kind === "encoded" ? url.replace("tiny-public", "tiny%2dpublic")
    : kind === "wrong-version" ? url.replace("1.0.0.tgz", "2.0.0.tgz") : kind === "git" ? "git+" + url : "file:../private.tgz";
  expect(() => PublicNpmPlan.create({ ...f.inputs, packageLock: Buffer.from(JSON.stringify(f.lock)) })).toThrow();
});
it.each(["sha256-AA==", "sha512-AA==", "sha512-" + "A".repeat(86) + "== sha512-" + "A".repeat(86) + "==", "sha512-" + "A".repeat(85) + "B=="])("requires a canonical single SHA512 receipt %s", integrity => {
  expect(() => publicNpmIntegrity(integrity)).toThrow();
});
it.each(["../node_modules/x", "/node_modules/x", "node_modules/../x", "node_modules/x/other/node_modules/y"])("refuses lock location %s", location => {
  const f = npmFixture(), entry = f.lock.packages[`node_modules/${f.artifact.name}`];
  const packages = { "": f.pkg, [location]: entry };
  expect(() => PublicNpmPlan.create({ ...f.inputs, packageLock: Buffer.from(JSON.stringify({ ...f.lock, packages })) })).toThrow();
});
it("rejects duplicate and escaped alias JSON keys before they disappear", () => {
  const f = npmFixture();
  for (const key of ['"lockfileVersion":3,"lockfileVersion":3', '"lockfileVersion":3,"lockfile\\u0056ersion":3']) {
    expect(() => PublicNpmPlan.create({ ...f.inputs, packageLock: Buffer.from("{" + key + ',"packages":{}}') })).toThrow();
  }
});
it("bounds original input before retaining a clone and rejects shared mutable buffers", () => {
  const f = npmFixture();
  expect(() => PublicNpmPlan.create({ ...f.inputs, packageLock: Buffer.alloc(PUBLIC_NPM_LIMITS.lockBytes + 1) })).toThrow();
  expect(() => PublicNpmPlan.create({ ...f.inputs, packageJson: Buffer.from(new SharedArrayBuffer(100)) })).toThrow();
});
it("accepts only declared copied workspace links, while public artifacts remain registry constrained", () => {
  const f = npmFixture(), pkg = { ...f.pkg, workspaces: ["packages/*"] };
  const lock = { ...f.lock, packages: { ...f.lock.packages, "packages/local": { name: "@fixture/local", version: "1.0.0" }, "node_modules/@fixture/local": { resolved: "packages/local", link: true } } };
  expect(publicNpmPlanData(PublicNpmPlan.create({ packageJson: Buffer.from(JSON.stringify(pkg)), packageLock: Buffer.from(JSON.stringify(lock)) })).workspaces).toHaveLength(1);
  lock.packages["node_modules/@fixture/local"].resolved = "../private";
  expect(() => PublicNpmPlan.create({ packageJson: Buffer.from(JSON.stringify(pkg)), packageLock: Buffer.from(JSON.stringify(lock)) })).toThrow();
});
it("binds one deterministic ASCII package order across source insertion orders and host locales", () => {
  const f = npmFixture(), packages = ["a.b", "a-b", "@scope/a"].map(name => ({ ...f.artifact, name, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-1.0.0.tgz` }));
  const pkg = Buffer.from(JSON.stringify({ ...f.pkg, dependencies: Object.fromEntries(packages.map(p => [p.name, p.version])) }));
  const plan = (entries: typeof packages) => PublicNpmPlan.create({ packageJson: pkg, packageLock: Buffer.from(JSON.stringify({ ...f.lock, packages: { "": {}, ...Object.fromEntries(entries.map(p => [`node_modules/${p.name}`, p])) } })) });
  const first = plan(packages), second = plan([...packages].reverse());
  expect(publicNpmPlanData(first).packages.map(p => p.name)).toEqual(["@scope/a", "a-b", "a.b"]);
  expect(first.summary.setSha256).toBe(second.summary.setSha256); expect(first.summary.lockSha256).not.toBe(second.summary.lockSha256);
});
