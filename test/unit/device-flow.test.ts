/**
 * The device-flow sign-in through a network blip (review #140): a failed request, a proxy's HTML error page or a 5xx
 * while Ember waits for the user's approval doesn't lose the code they are entering; it keeps waiting until the code
 * expires or the user cancels. A sign-in that does fail never promises a retry nothing makes.
 */

import { describe, expect, it } from "vitest";
import { pollDeviceFlow, type DeviceCode } from "../../app/main/agent/auth";
import { explainSignInError } from "../../app/main/agent/host";

const TOKEN = "gho_" + "d".repeat(36); // not a real token
const code: DeviceCode = { deviceCode: "dc", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 };
type Reply = { ok: boolean; status: number; json(): Promise<unknown> };
const json = (body: unknown, status = 200): Reply => ({ ok: status < 400, status, json: async () => body });
const html502: Reply = { ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"); } };

describe("waiting for the user's approval", () => {
  it("keeps waiting through a failed request, an HTML error page and a 5xx, then signs in", async () => {
    const replies: (Reply | Error)[] = [json({ error: "authorization_pending" }), new TypeError("fetch failed"), html502, json({ message: "oops" }, 503), json({ access_token: TOKEN })];
    const fetch = async () => { const r = replies.shift()!; if (r instanceof Error) throw r; return r; };
    const waits: number[] = [];
    expect(await pollDeviceFlow(fetch, "cid", code, { sleep: async ms => { waits.push(ms); } })).toBe(TOKEN);
    expect(replies).toHaveLength(0);
    expect(waits.every(ms => ms >= 5000)).toBe(true);
  });

  it("gives up only when the code expires", async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const fetch = async (): Promise<Reply> => { throw new TypeError("fetch failed"); };
      await expect(pollDeviceFlow(fetch, "cid", { ...code, expiresIn: 30 }, { sleep: async ms => { now += ms; } })).rejects.toThrow(/sign-in code expired/);
    } finally {
      Date.now = realNow;
    }
  });

  it("still stops at once when the user cancels during a blip", async () => {
    const ac = new AbortController();
    const fetch = async (): Promise<Reply> => { ac.abort(); throw new TypeError("fetch failed"); };
    await expect(pollDeviceFlow(fetch, "cid", code, { signal: ac.signal, sleep: async () => undefined })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("still ends on GitHub's own answers (denied, expired)", async () => {
    await expect(pollDeviceFlow(async () => json({ error: "access_denied" }), "cid", code, { sleep: async () => undefined })).rejects.toThrow(/cancelled on GitHub/);
    await expect(pollDeviceFlow(async () => json({ error: "expired_token" }), "cid", code, { sleep: async () => undefined })).rejects.toThrow(/code expired/);
  });
});

describe("a sign-in that failed", () => {
  it("says so without promising a retry, and never shows a raw parser error", () => {
    const offline = explainSignInError(new TypeError("fetch failed"), { online: true });
    expect(offline).toMatch(/can't reach GitHub/);
    expect(offline).not.toMatch(/try again when the network is back/);
    expect(offline).toMatch(/Sign in again|press .* again/i);
    const parse = explainSignInError(new SyntaxError("Unexpected token '<', \"<html>…\" is not valid JSON"), { online: true });
    expect(parse).not.toMatch(/Unexpected token/);
    expect(parse).toMatch(/GitHub/);
    expect(explainSignInError(new Error("The sign-in code expired. Start again."), {})).toBe("The sign-in code expired. Start again.");
    expect(explainSignInError(new Error("GitHub refused the sign-in request (401)"), {})).toMatch(/didn't accept Ember's sign-in request/);
  });
});
