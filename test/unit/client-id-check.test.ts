/**
 * CI's check that the built-in GitHub App client id starts a sign-in (scripts/check-client-id.mjs, the last step of
 * ci.yml's checks job): it exists to catch a dead or misconfigured client id, so GitHub's own passing trouble is
 * tried again a few times and never fails the job by itself, and a refused client id fails at once.
 */

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { TRIES, checkClientId, deviceCodeVerdict } from "../../scripts/check-client-id.mjs";

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
const CODE = { device_code: "d-secret-code", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5 };

describe("the client id check's verdict on one answer from GitHub (product-platform-flaky-4)", () => {
  it("passes on a device code and a user code, and never repeats either", () => {
    const v = deviceCodeVerdict(json(200, CODE));
    expect(v).toEqual({ verdict: "pass", says: "GitHub answered 200: a device code (not shown)" });
  });

  it.each([
    ["the answer CI got once", json(400, { error: "request_failed", error_description: "The request failed to be processed, please try again" })],
    ["slow_down", json(400, { error: "slow_down" })],
    ["slow_down with 200", json(200, { error: "slow_down" })],
    ["a 500", json(500, { message: "Server Error" })],
    ["a 502 page", { status: 502, body: "<html>Bad Gateway</html>" }],
    ["a 503 with no body", { status: 503, body: "" }],
    ["a 200 that isn't JSON", { status: 200, body: "<html>unicorn</html>" }],
    ["a 400 that isn't JSON", { status: 400, body: "Bad request" }],
    ["JSON that isn't an object", { status: 200, body: "null" }],
    ["a network error", { failed: "fetch failed" }],
  ])("tries again after GitHub's own trouble: %s", (_name, answer) => {
    expect(deviceCodeVerdict(answer).verdict).toBe("retry");
  });

  it.each([
    ["incorrect_client_credentials", json(200, { error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." })],
    ["incorrect_client_credentials with 401", json(401, { error: "incorrect_client_credentials" })],
    ["device_flow_disabled", json(400, { error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" })],
    ["unsupported_grant_type", json(400, { error: "unsupported_grant_type" })],
    ["a 404", json(404, { error: "Not Found" })],
    ["a 422 with no error name", json(422, {})],
    ["a 403 it doesn't know", json(403, { error: "access_denied" })],
    ["a 200 with neither a code nor an error", json(200, { interval: 5 })],
    ["a 200 with a device code and no user code", json(200, { device_code: "d" })],
  ])("fails at once, with GitHub's answer shown, when the client id or the request is wrong: %s", (_name, answer) => {
    const v = deviceCodeVerdict(answer);
    expect(v.verdict).toBe("fail");
    expect(v.says).toContain(`GitHub answered ${answer.status}`);
    const error = (JSON.parse(answer.body) as { error?: string }).error;
    if (error) expect(v.says).toContain(error);
  });

  it("shows only the error and its description of an answer, never a code that came with it", () => {
    const v = deviceCodeVerdict(json(400, { error: "device_flow_disabled", error_description: "off", device_code: "d-secret-code", user_code: "ABCD-1234" }));
    expect(v.says).toBe('GitHub answered 400: {"error":"device_flow_disabled","error_description":"off"}');
    expect(deviceCodeVerdict({ status: 502, body: "<html>d-secret-code</html>" }).says).toBe("GitHub answered 502: not JSON");
  });
});

describe("the client id check (product-platform-flaky-4)", () => {
  const run = async (answers: ({ status: number; body: string } | Error)[], id = "Iv23abcdefghijklmnop") => {
    const lines: string[] = [], waits: number[] = [], bodies: string[] = [];
    let asked = 0;
    const code = await checkClientId({
      id,
      ask: async (body: URLSearchParams) => {
        bodies.push(body.toString());
        const a = answers[Math.min(asked++, answers.length - 1)];
        if (a instanceof Error) throw a;
        return a;
      },
      wait: async (ms: number) => { waits.push(ms); },
      log: (line: string) => lines.push(line),
    });
    return { code, lines, waits, asked, bodies };
  };
  const transient = json(400, { error: "request_failed", error_description: "The request failed to be processed, please try again" });

  it("passes after one transient answer, having waited some seconds, and asks with the client id and the read:user scope", async () => {
    const r = await run([transient, json(200, CODE)]);
    expect(r).toMatchObject({ code: 0, asked: 2, waits: [5_000] });
    expect(r.bodies[0]).toBe("client_id=Iv23abcdefghijklmnop&scope=read%3Auser");
    expect(r.lines.join("\n")).toContain("request_failed");
    expect(r.lines.at(-1)).toBe("GitHub answered 200: a device code (not shown)");
    expect(r.lines.join("\n")).not.toMatch(/d-secret-code|ABCD-1234/);
  });

  it("passes after a network error and a 502", async () => {
    expect(await run([new Error("fetch failed"), { status: 502, body: "" }, json(200, CODE)])).toMatchObject({ code: 0, asked: 3, waits: [5_000, 15_000] });
  });

  it("gives up after a few tries of GitHub's trouble, under a minute and a half of waiting, and fails with the last answer", async () => {
    const r = await run([transient]);
    expect(TRIES).toBe(4);
    expect(r).toMatchObject({ code: 1, asked: 4, waits: [5_000, 15_000, 30_000] });
    expect(r.lines.at(-1)).toMatch(/^GitHub's trouble lasted 4 tries: /);
  });

  it("fails at once on a client id GitHub refuses, without a second try", async () => {
    const r = await run([json(200, { error: "incorrect_client_credentials" }), json(200, CODE)]);
    expect(r).toMatchObject({ code: 1, asked: 1, waits: [] });
    expect(r.lines.at(-1)).toContain("incorrect_client_credentials");
  });

  it("fails at once on a refused client id that follows a transient answer", async () => {
    expect(await run([transient, json(400, { error: "device_flow_disabled" })])).toMatchObject({ code: 1, asked: 2 });
  });

  it("has nothing to check, and asks GitHub nothing, in a build without a client id (a fork)", async () => {
    const r = await run([json(200, CODE)], "");
    expect(r).toMatchObject({ code: 0, asked: 0 });
    expect(r.lines).toEqual(["no built-in client id (a fork or development build): nothing to check"]);
  });

  it("is what ci.yml's checks job runs last, reading the id that is built in", () => {
    const checks = fs.readFileSync(".github/workflows/ci.yml", "utf8").split("\n  checks:\n")[1].split(/\n {2}[\w-]+:\n {4}name:/)[0];
    expect(checks.trimEnd().split("\n").slice(-2).join("\n")).toBe([
      "      - name: The built-in GitHub App client id starts a sign-in (GitHub answers with a device code, never printed)",
      "        run: node scripts/check-client-id.mjs",
    ].join("\n"));
    const script = fs.readFileSync("scripts/check-client-id.mjs", "utf8");
    expect(script).toContain('"app/main/agent/github-app.ts"');
    expect(script).toContain("/export const GITHUB_CLIENT_ID = \"([^\"]*)\"/");
    expect(fs.readFileSync("app/main/agent/github-app.ts", "utf8")).toMatch(/export const GITHUB_CLIENT_ID = "([^"]*)"/);
  });
});
