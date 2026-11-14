/**
 * A password said in a sign-in's own form, and a wallet's seed words, are never kept as a fact (memory-r12-1,
 * memory-c12-1, memory-c12-2): a sign-in thing and one word ("My Netflix is sunshine", "Netflix dragonfly"), a value
 * reused everywhere ("Uses Dragonfly88 everywhere"), a user and a value with only a space between them ("Amazon login:
 * ram@example.com Biscuit99"), and seed words however they are named. Memory's note promises it never keeps passwords,
 * codes or card numbers; the guard reads the saying's form and the value's shape, never a dictionary of passwords, and
 * everyday facts about the same services, networks and wallets are kept as before.
 */

import { describe, expect, it } from "vitest";
import { factRefusal } from "../../app/main/memory/fact-guard";

const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const refused = (facts: string[]) => facts.filter(f => !factRefusal(f));
const keptOnes = (facts: string[]) => facts.filter(f => factRefusal(f));

describe("the memory guard on a password said in a sign-in's own form", () => {
  it("refuses a sign-in thing with one word, a word used for it, and a value reused everywhere (memory-r12-1)", () => {
    expect(refused([
      "My Netflix is sunshine", "Their Spotify is bluebird", "Password manager is tangerine", "The Bitwarden one is tangerine",
      "Spotify: marmalade", "Netflix dragonfly", "Use dragonfly for Netflix", "Uses marmalade for Spotify", "Netflix account uses dragonfly",
      "Their Steam account uses marmalade", "Uses tangerine to unlock their password manager", "Logs in with Sunshine",
      "Remember Pinecone7 for the Wi-Fi", "Uses Pinecone7 for the Wi-Fi", "Uses Biscuit99 for PayPal", "Uses Biscuit99 for the NAS",
      "I use Summer2024 everywhere", "Summer2024 is what I use for everything", "Uses Summer2024 everywhere", "Reuses Summer2024 on every site",
      "Uses Dragonfly88 everywhere", "Uses Dragonfly88 for everything", "Uses the same Dragonfly88 for every account",
    ])).toEqual([]);
  });

  it("keeps everyday facts about the same services and networks (memory-r12-1)", () => {
    expect(keptOnes([
      "Likes Netflix and sunshine", "Their Wi-Fi is slow in the evenings", "The Wi-Fi is unreliable", "The Wi-Fi is mesh", "The Wi-Fi is BT",
      "My Netflix is shared with my sister", "Their Spotify is premium", "The office Wi-Fi is patchy", "Their Netflix is the family plan",
      "Their Slack is busy", "Their Jira is self-hosted", "Their bank is local", "Their bank is Barclays", "The VPN is mandatory",
      "The VPN is GlobalProtect", "The router is upstairs", "Their database is postgres", "Their database is atlas_prod_eu",
      "Their GitHub is octocat", "The GitHub login is octocat", "Bitwarden is their password manager", "Their password manager is Bitwarden",
      "The Bitwarden one is free", "Discord: mostly gaming", "Discord is where the team chats", "Their Gmail is mostly newsletters",
      "Uses Windows11 everywhere", "Uses Office365 for everything", "Uses Python3 for work", "Uses Chrome everywhere", "Uses Linux for everything",
      "Uses dark mode everywhere", "Uses vim on every machine", "Uses Firefox on every site", "Uses NordVPN for the VPN", "Uses an Eero for the Wi-Fi",
      "Uses Mullvad for the VPN", "Uses Figma2 for Slack", "Uses Bitwarden to keep their passwords", "Logs in with Google", "Logs in with Chrome", "Signs in with their phone",
      "Signs in to PayPal with Google", "Netflix account uses their work email", "Spotify uses their Google login", "The VPN uses WireGuard",
      "Their home Wi-Fi is called VirginMedia5G", "Their AWS account is called globex-prod-analytics",
    ])).toEqual([]);
  });

  it("refuses a user and a value said with only a space or “with” between them, and keeps a user said alone (memory-c12-1)", () => {
    expect(refused([
      "Their Amazon login is ram@example.com Biscuit99", "Their Amazon login is ram99 Biscuit99", "Their login is ram@example.com Biscuit99",
      "My Netflix login is ram@example.com Biscuit99", "Amazon login: ram@example.com Biscuit99", "Their Gmail login is ram@example.com Biscuit99",
      "Their work login is ram@globex.com Biscuit99", "Their Netflix is ram@example.com Biscuit99", "Their PayPal is ram@example.com with Biscuit99",
      "Signs in to PayPal as ram@example.com with Biscuit99", "Their Steam is ram99 Biscuit99", "The Jira login is ram marmalade",
    ])).toEqual([]);
    expect(keptOnes([
      "Their Amazon login is ram@example.com", "Their work login is rkumar@globex.com", "Their Amazon account is under their wife's name",
      "The Netflix login is shared with their parents", "Signs in to Slack as ram with SSO", "Their Netflix account is in their wife's name",
    ])).toEqual([]);
  });

  it("refuses a wallet's seed words however they are named, and keeps talk about keeping them (memory-c12-2)", () => {
    expect(refused([
      "Their seed phrase starts with abandon ability able about above absent", `Their wallet words are ${SEED}`,
      `Wrote down the 12 words ${SEED} for their wallet`, "Their Ledger's 24 words begin abandon ability able about",
      `Their bitcoin wallet backup is ${SEED}`, `Keeps ${SEED} safe`, "Their recovery phrase begins with zoo zone wrist wrong",
      "Wallet seed: abandon ability able about above absent",
    ])).toEqual([]);
    expect(keptOnes([
      "Keeps their bitcoin wallet backup in a safe", "The 24 words are stored offline somewhere safe", "Their crypto wallet holds mostly bitcoin and some ethereum",
      "Wrote down the 12 words for their wallet backup", "Their wallet words are written on paper in a safe", "Keeps the recovery phrase offline",
      "Their seed phrase is stored on a steel plate", "Bought a Ledger for their crypto wallet", "They hike camp fish swim and cycle most weekends",
      "Their favourite bands are blur oasis pulp suede and elastica", "Wrote down the 24 words on the card that came with the Ledger", "Their wallet is brown leather",
    ])).toEqual([]);
  });

  it("keeps a service named with what it holds or how it is, and a list said without commas, as speech writes it (r12-safety-x12-5)", () => {
    expect(keptOnes([
      "My Slack is noisy", "My Gmail is personal", "My Slack is chaotic", "My Gmail is temporary", "My Discord is noisy", "My Slack is messy",
      "Her Netflix is family", "My Zoom is basic", "Netflix documentaries", "Spotify podcasts", "Netflix shows", "Spotify playlists",
      "Slack huddles", "Netflix series", "Netflix tonight", "Steam games", "Slack channels", "Amazon orders", "Spotify songs", "Gmail filters",
      "Shopping list: milk eggs bread butter cheese apples bananas onions garlic carrots potatoes rice",
      "Remember my shopping list milk eggs bread butter cheese apples bananas onions garlic carrots potatoes and rice",
      "Weekly veg box: kale leeks onions carrots potatoes beets turnips celery garlic chard spinach lettuce",
      "Favourite words: hygge saudade wabi sabi ikigai fernweh komorebi tsundoku sisu lagom jayus gezellig",
      "Plants on the balcony: basil thyme mint sage rosemary chives parsley oregano dill lavender fennel lovage",
      "Daughter's spelling words: apple table chair water happy little window yellow garden pencil sister mother",
      "Her favourite fruits apples pears plums cherries grapes melons lemons limes figs dates kiwis mangoes",
      "Packing list socks shirts jumper coat boots hat scarf gloves charger passport tickets wallet",
    ])).toEqual([]);
    // The same forms with a password's word, or seed words unnamed or after a wallet's heading, are still refused.
    expect(refused([
      "My Netflix is dragonfly", "My Spotify is strawberry", "Netflix marmalade", "Spotify bluebird", "My Gmail is tangerine",
      `Remember ${SEED}`, `Their wallet: ${SEED}`, `Seed words ${SEED}`,
    ])).toEqual([]);
  });
});
