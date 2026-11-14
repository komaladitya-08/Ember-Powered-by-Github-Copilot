/**
 * A fact is judged by its value, not by the shape of its sentence (memory-r11-1, memory-c11-1): a value is refused
 * when it is a credential, wherever its name stands. A password named "secret" after what it is for ("My AWS secret is
 * Summer2024"), a password said with no password's name beside a sign-in thing ("Remember Summer2024 for the VPN",
 * "Gmail: ram99 / sunshine"), and a key or a token shaped like one, said with or without "is" ("API key 9b2f…",
 * "Bearer token 3f9a…") are never kept. Memory's note promises "Ember never keeps passwords, codes or card numbers",
 * and memory outlives the conversation and goes with later requests to the model.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { factRefusal, saidSecret } from "../../app/main/memory/fact-guard";
import { MemoryGraph } from "../../app/main/memory/graph";
import { MemoryService } from "../../app/main/memory/service";

const quiet = { info: () => undefined, warn: () => undefined };
const USER = [{ name: "User", kind: "person" as const }];

/** The re-rater's kept examples, then neighbours of each that neither report named. */
const PASSWORDS = [
  // A password named "secret" after what it is for.
  "My AWS secret is Summer2024", "The router secret is Summer2024", "My Wi-Fi secret is Summer2024", "Our RADIUS secret is Summer2024",
  "My VPN secret is sunshine", "The LDAP secret was bluebird", "Our Jenkins secret: tangerine", "His Azure secret = Rex1999",
  // A password with no password's name beside a sign-in thing.
  "My Netflix account: ram@example.com, Summer2024", "Gmail: ram99 / sunshine", "Remember Summer2024 for the VPN", "For the VPN it's Summer2024",
  "Netflix - Summer2024", "My Bitwarden is Summer2024", "The router admin is admin and Summer2024", "Remember hunter2 for the VPN",
  "Spotify — Bluebird77", "The Wi-Fi at Mum's is Garden2023", "Steam account ram_99, Winter2024", "Outlook: priya.k / tangerine",
  "My Gmail login is ram99 / sunshine", "The login for Netflix is sunshine", "Netflix: sunshine", "Netflix password. sunshine",
  "I log into Netflix with sunshine", "Netflix uses sunshine", "Signs in to Jira with bluebird", "Spotify: tangerine",
  "I always use my birthday 0412 for everything", "Uses 1998 everywhere", "Remember 0412 everywhere", "Wi-Fi at the cabin — Pinecone7",
  "Our Okta secret's Maple2025", "The Postgres pw: river", "MySQL root secret is Kettle88", "Disney+: Rex1999", "PayPal = ram99, Lantern44",
  "The Netflix login is bluebird", "Zoom password. tulip", "Logs into Gmail using marmalade", "Got the Spotify secret: violet",
  // An NHS number, which PLAN §10 left in round ten.
  "My NHS number is 943 476 5919", "NHS no. 9434765919",
];

const KEYS = [
  // The challenger's kept examples.
  "API key 9b2f4e1a-7c3d-4e8b-a1f2-6d5c4b3a2e10", "Access token 9b2f4e1a-7c3d-4e8b-a1f2-6d5c4b3a2e10", "Bearer token 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
  "Personal access token 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c", "OpenWeather key " + "3f9a8b7c6d5e4f3a" + "2b1c0d9e8f7a6b5c",
  "My OpenWeather key is " + "3f9a8b7c6d5e4f3a" + "2b1c0d9e8f7a6b5c", "Mailgun key 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c", "Session cookie 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
  "The key for the weather API is 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c", "API key sk-proj-a8f7d6s5a4d3f2g1h0j9k8l7",
  // Neighbours: other nouns, no noun, other shapes.
  "Stripe key rk_live_51H8xYz2eZvKYlo2C0abcd", "The deploy hook is 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c", "Uses 9b2f4e1a-7c3d-4e8b-a1f2-6d5c4b3a2e10 for the weather app",
  "Remember AKIAIOSFODNN7EXAMPLE for staging", "Credentials 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c", "The Slack bot uses xoxb-2048-4096-a1b2c3d4e5f6g7h8",
  "Auth 9b2f4e1a7c3d4e8ba1f26d5c4b3a2e10", "Weather API 3f9a8b7c6d5e4f3a",
];

/** A password that ends in "-ly" or "-ed", or is a plan's or a state's word, in each new shape (r11-memory-x11-2), then neighbours. */
const LY_ED = [
  "Netflix: butterfly", "Netflix: dragonfly", "Netflix: Butterfly", "Netflix — dragonfly", "Gmail: ram99 / butterfly", "Spotify login is butterfly",
  "The login for Netflix is kimberly", "My VPN secret is blessed", "My VPN secret is butterfly", "My AWS secret is Beverly", "Our Okta secret's butterfly",
  "Netflix password. butterfly", "I log into Netflix with butterfly", "Netflix uses butterfly", "Wi-Fi: blessed", "Wi-Fi: Butterfly",
  "My AWS secret is family", "My AWS secret is secure", "My AWS secret is premium", "My AWS secret is everywhere",
  // Neighbours.
  "Spotify: lovely", "Our Jenkins secret: wicked", "My Okta secret is holly", "Zoom password. sacred", "Gmail: ram99, shelly", "Disney+: firefly",
];

/** A key named without "is" or ":", with few digits in its runs, and a token alone by its shape (r11-memory-x11-3), then neighbours. */
const FEW_DIGIT_KEYS = [
  "OpenAI key sk-AbCdEfGhIjKlMnOpQrStUvWxYz", "API key AbCdEfGhIjKlMnOpQrStUvWxYz", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc",
  // Neighbours.
  "Stripe key pk_live_AbCdEfGhIjKlMnOpQrSt", "Access token QwErTyUiOpAsDfGhJkLz", "Session token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig",
  "The bot uses token XyZaBcDeFgHiJkLmNoPq", "Weather API kEyKeYkEyKeYkEyKeY", "Use eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhIn0.c2ln for staging",
];

/** Ordinary facts beside those values, which memory still keeps. */
const ORDINARY = [
  "The secret is patience", "My secret is that I dislike meetings", "The shared secret is rotated monthly", "The client secret is configured in Azure",
  "Our family secret is cinnamon", "Organises the office secret Santa", "Top secret: the launch date", "Victoria's Secret is my favourite shop",
  "Uses Windows11 on the laptop", "Uses WPA3 for the Wi-Fi", "Wi-Fi: HomeNet / WPA2-PSK", "The Wi-Fi is WPA3-only", "The Wi-Fi is 300Mbps",
  "Uses iPhone15 for Instagram", "The VPN is NordVPN2", "Logs in with OAuth2", "Signs in with SSO", "Signs in to GitHub with a passkey",
  "Signs in with Face ID", "Logs in with 2FA", "Unlocks the phone with a fingerprint", "Login is through Okta", "The login page is new",
  "Twitter handle is @ram_42", "Email is ram42@example.com", "Netflix: family plan", "Netflix: premium", "Jira: ram's board",
  "Forgot the password. Again", "Reset my PIN. Done", "My Netflix account is shared with Mum", "Netflix is expensive",
  "The access token is short-lived", "The token count is 4096", "The API key is in 1Password", "Rotates the API keys every 90 days",
  "The key is under the mat", "Session cookies expire after a day", "Bought a Netflix gift card", "Moved from Spotify to Tidal in 2024",
  "Works at Globex", "Prefers short answers", "Was born in 1990", "Flight BA2490 leaves on Friday", "Likes to be called Ram",
  "Uses VS2022 for C++", "Loves C++17", "The router is AX6000", "Uses Python3 for scripting", "Bank uses 3DSecure2",
  "The user's GitHub login is octocat", "The user's GitHub: octocat2", "GitHub: ram-k", "The admin login is admin@localhost.",
  "Wi-Fi: HomeNet / band: 5GHz", "Wi-Fi: HomeNet, 802.11ac", "The credentials are base64", "Logs into Gmail using Chrome",
  "Commit 3f9a8b7 fixed the build", "The Zoom room is 845 2231 9087", "The secret ingredient is cumin", "Uses Okta for single sign-on",
  "Netflix: shared with Mum", "The AWS bill was £120 in March", "Our app uses Kubernetes on AWS",
  // Words joined in camel case beside a key's name, which are no key (r11-memory-x11-3).
  "The API key is in HashiCorpVaultCluster", "Uses the GitHubActionsRunner token", "Session cookie name is JSESSIONIDCookie",
  "The auth flow uses OpenIDConnectProvider",
];

describe("a credential's value in a fact, wherever its name stands", () => {
  it.each(PASSWORDS.map(s => [s]))("refuses %j, a password said without the words the guard read (memory-r11-1)", text => {
    expect(factRefusal(text)).not.toBeNull();
    expect(new MemoryGraph().add({ text, about: USER, source: "user" }).kind).toBe("refused");
  });

  it.each(KEYS.map(s => [s]))("refuses %j, a key or a token by its shape, with or without \"is\" (memory-c11-1)", text => {
    expect(factRefusal(text)).not.toBeNull();
    expect(new MemoryGraph().add({ text, about: USER, source: "user" }).kind).toBe("refused");
  });

  it.each(LY_ED.map(s => [s]))("refuses %j, a password whatever its ending (r11-memory-x11-2)", text => {
    expect(factRefusal(text)).not.toBeNull();
  });

  it.each(FEW_DIGIT_KEYS.map(s => [s]))("refuses %j, a key by its shape whatever its digits (r11-memory-x11-3)", text => {
    expect(factRefusal(text)).not.toBeNull();
  });

  it.each(ORDINARY.map(s => [s]))("keeps the ordinary fact %j beside those values (memory-r11-1, memory-c11-1)", text => {
    expect(saidSecret(text)).toBeNull();
  });

  it("keeps none of them in memory.json, through the remember tool (memory-r11-1, memory-c11-1)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-credval-"));
    const s = new MemoryService({ dir, log: quiet });
    for (const text of ["My AWS secret is Summer2024", "Gmail: ram99 / sunshine", "API key 9b2f4e1a-7c3d-4e8b-a1f2-6d5c4b3a2e10"]) {
      expect(s.remember(text, USER, text)).toMatch(/^Not remembered/);
    }
    expect(s.remember("Works at Globex", USER, "I work at Globex")).toMatch(/^Remembered/);
    s.flush();
    expect(fs.readFileSync(path.join(dir, "memory.json"), "utf8")).not.toMatch(/Summer2024|sunshine|9b2f4e1a/);
    s.stop();
  });
});
