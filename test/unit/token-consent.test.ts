/** Consent loss fences queued grant reads and renewal replies, without changing account-generation ownership. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrantKeeper, type Grant, type TokenStore } from "../../app/main/agent/auth";

const now = 1_000_000;
const grant: Grant = { token: `ghu_${"a".repeat(36)}`, refreshToken: "fixture-refresh", clientId: "fixture-client", expiresAt: now + 1, refreshExpiresAt: now + 10_000_000 };
const renewed = () => new Response(JSON.stringify({ access_token: `ghu_${"b".repeat(36)}`, refresh_token: "fixture-next", expires_in: 28_800, refresh_token_expires_in: 1_000_000 }));
afterEach(() => { vi.useRealTimers(); });

describe("grant renewal requires current agreement", () => {
  it("reads or renews nothing while blocked and works again after agreement (extensions-consent-review-2)", async () => {
    let allowed = false;
    const store = { generation: 0, loadGrant: vi.fn(async () => grant), saveAsync: vi.fn(async () => "saved") };
    const fetch = vi.fn(async () => renewed());
    const keeper = new GrantKeeper({ allowed: () => allowed, store: () => store as unknown as TokenStore, fetch,
      inUse: () => grant.token, idle: () => true, reconnect: async () => undefined, now: () => now });
    await keeper.freshen();
    expect(store.loadGrant).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    allowed = true;
    await keeper.freshen();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.saveAsync).toHaveBeenCalledTimes(1);
    keeper.stop();
  });

  it("drops a stored read that crosses stop and re-agreement (extensions-consent-review-2)", async () => {
    let allowed = true;
    let finish!: (grant: Grant) => void;
    const store = { generation: 0, loadGrant: vi.fn(() => new Promise<Grant>(resolve => { finish = resolve; })), saveAsync: vi.fn(async () => "saved") };
    const fetch = vi.fn(async () => renewed());
    const keeper = new GrantKeeper({ allowed: () => allowed, store: () => store as unknown as TokenStore, fetch,
      inUse: () => grant.token, idle: () => true, reconnect: async () => undefined, now: () => now });
    const pending = keeper.freshen();
    allowed = false; keeper.stop(); allowed = true;
    finish(grant);
    await pending;
    expect(fetch).not.toHaveBeenCalled();
    expect(store.saveAsync).not.toHaveBeenCalled();
    keeper.stop();
  });

  it("does not save or reconnect from a renewal completing after revocation (extensions-consent-review-2)", async () => {
    let allowed = true;
    let finish!: (response: Response) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const store = { generation: 0, loadGrant: vi.fn(async () => grant), saveAsync: vi.fn(async () => "saved") };
    const reconnect = vi.fn(async () => undefined);
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; began(); }));
    const keeper = new GrantKeeper({ allowed: () => allowed, store: () => store as unknown as TokenStore, fetch,
      inUse: () => grant.token, idle: () => true, reconnect, now: () => now });
    const pending = keeper.freshen();
    await started;
    allowed = false; keeper.stop();
    finish(renewed());
    await pending;
    expect(store.saveAsync).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
    keeper.stop();
  });
});
