/**
 * What an answer about a web page's control binds to (cause 3b of the investigation of the owner's report of
 * 2026-11-12). A question bound its answer to the window's whole accessibility tree, so on a page that changes on its
 * own while the user decides (a video's clock, comments arriving) every Allow was spent ("the page changed") and Ember
 * asked again, for ever. For a control of a web page, in no dialog, the answer binds instead to what the question was
 * about and what makes the step safe:
 *
 * - the window's title and the page's own name (its document's);
 * - every dialog and alert in the window, so one that appears over the page spends the yes;
 * - the control itself, read exactly (role, name, text, value, states), and the path of containers it sits in;
 * - everything in its own form, or else in the nearest container around it that holds another control, read exactly
 *   (the document itself where no smaller one does: then all of the page binds, as before);
 * - every field the window shows, wherever it is (text typed, an option chosen, a box ticked: a comment's words, an
 *   amount or a recipient beside a "Send", and the browser's own address bar, which says where the page is), and the
 *   page's own tabs with the one chosen.
 *
 * For a control whose name is risky (Delete, Send, Pay…) also all of the page's text outside its lists and feeds,
 * whatever element holds it (a heading, a paragraph, a plain block, a label), numbers kept: where the thing it acts on
 * is named ("Delete ana/scratch" beside "Delete this repository"; "ana/build-1"; "You are sending $50 to Bob"), so a
 * page that renames it or changes an amount while the user decides spends the yes (modes-x9s-4, modes-y9-3). Only what
 * a living page counts on its own is let through: a clock ("0:42 / 3:00"), a text that is nothing but a count of what
 * a page gathers ("12 comments", "5 minutes ago"; never one that names money, and never a count of anything else: "12
 * recipients"), comments arriving in a feed, and another control's own counter ("Like 10"). The names of the page's
 * other links, buttons, tabs and menu items outside its feeds bind too: a breadcrumb may be what names the thing
 * (modes-y9-x9-5).
 *
 * The rest of the page may change: pictures, lists, and for an ordinary control the text and buttons outside its own
 * group. Anything that
 * can't be read fails closed: no binding is made (the caller binds the whole tree, as before) where the control is in a
 * dialog, is secret, has no name (what it is called then comes from what stands around it), isn't in a page, has a
 * container that wasn't read, or the window's title speaks of money; and a later read in which the control can't be
 * found exactly once never equals the binding. Pure: no Electron, no DOM.
 */

import type { AxNode } from "../perception/sidecar";

/** A dialog, as a page or an app shows one (the worker's DIALOG_ROLE and QUESTION_ROLE together). */
const DIALOG = /^(dialog|alert|alert dialog|file chooser|color chooser|font chooser)$/;
/** What a click, a key or typing works: the "other control" that makes a container the control's own group. */
const CONTROL = /^(push button|push button menu|button|split button|toggle button|link|menu item|check menu item|radio menu item|check box|radio button|switch|combo box|entry|password text|spin button|slider|page tab)$/;
/** What holds something the user (or the page for them) entered or chose. */
const FIELD = /^(entry|password text|combo box|check box|radio button|switch|spin button|check menu item|radio menu item)$/;
/**
 * A window titled for money (wider than policy's PAYMENT_PAGE on purpose): there a total or a recipient shown outside
 * the control's own group matters too, so the whole tree binds, as before.
 */
const MONEY_PAGE = new RegExp("\\b(checkout|check out|pay|pays|paying|payment|payments|billing|purchase|order|cart|basket|bank|banking|transfer|wallet|invoice|donate|donation"
  // (modes-y9-3) The word itself, the sites people send money with, and a checkout in the languages policy reads.
  + "|money|paypal|venmo|revolut|wise|coinbase|metamask|stripe|klarna|kasse|zahlung|zahlungen|bezahlen|paiement|paiements|payer|pago|pagos|pagar|pagamento|pagamentos|betaling|betalen|betalning)\\b", "i");
/** The states that say what a control is or holds (the same the whole-tree binding keeps: worker.ts actionContext). */
const STATES = /^(editable|multi line|protected|read only|disabled|sensitive|enabled|selected|checked|pressed|expanded)$/;

/** What a page fills on its own as it lives (comments, a feed, a table of results): its text isn't bound. */
const FEED = /^(list|list item|feed|article|table|tree|tree table|log|marquee|timer)$/;
/** What moves on its own and names nothing: never bound as text. */
const MOVES = /^(progress bar|scroll bar|status bar|animation|video|audio)$/;
/** A clock: "0:42", "1:02:09". */
const CLOCK = /\b\d{1,3}(:\d{2}){1,2}\b/g;
/**
 * A text that is nothing but a count of what a page gathers on its own: "12 comments", "1.2K views", "3 stars", "5
 * minutes ago". A count of anything else binds: it may be what the control acts on ("12 recipients" beside Send, "3
 * shares" beside Sell; modes-y9-x9-7).
 */
const COUNT = /^[\d.,\s]+[KkMm]?\+?\s*(comments?|views?|viewers?|watching|likes?|stars?|repl(y|ies)|reactions?|followers?|subscribers?|upvotes?|reposts?|retweets?|claps?|forks?|notifications?|unread|new|online|((seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago))$/iu;
/** Another control's own counter: "Like 10", "Comments (3)". */
const COUNTER = /^\p{L}[\p{L}\s]{0,30}[\s(]+[\d.,]+[KkMm]?\+?\)?$/u;
/** …unless it names money: a currency's sign, code or word. Then the number is an amount, and binds. */
const MONEY = /\p{Sc}|\b(dollars?|euros?|pounds?|cents?|pence|yen|yuan|rupees?|francs?|pesos?|kronor|kroner|bitcoins?|btc|eth|usd|eur|gbp|chf|jpy)\b/iu;
const CURRENCY_CODE = /\b[A-Z]{3}\b/;

/**
 * A node's text as a risky control's binding keeps it: whole, numbers kept, but for a clock and a bare count. Another
 * control (a link, a button, a tab outside the control's own group) is kept by its name, which may be what names the
 * thing (a breadcrumb's "report.pdf"), but for its own counter (modes-y9-x9-5).
 */
function prose(n: AxNode): string {
  const control = CONTROL.test(n.role);
  const text = (control ? n.name : `${n.name} ${n.text ?? ""}`).trim().replace(CLOCK, "#:#");
  return (COUNT.test(text) || (control && COUNTER.test(text))) && !MONEY.test(text) && !CURRENCY_CODE.test(text) ? text.replace(/\d+/g, "#") : text;
}

/** Does `n` hold something entered or chosen? */
const isField = (n: AxNode) => FIELD.test(n.role) || !!n.editable || !!n.secret || n.states.includes("editable");

/** A node as the binding keeps it (as actionContext does). `clicked`: Ember's own click may collapse its selection. */
function said(n: AxNode, parent: number | "missing" | null | undefined, clicked = false) {
  return {
    ...(parent !== undefined ? { parent } : {}), role: n.role, name: n.name, text: n.text, value: n.value, selected: n.selected,
    selection: clicked ? undefined : n.selection, secret: !!n.secret, withheld: !!n.withheld, omitted: !!n.omitted, editable: !!n.editable, dialogBox: !!n.dialogBox,
    actions: n.actions, states: n.states.filter(s => STATES.test(s) && !(clicked && s === "selected")).sort(),
  };
}

/**
 * The binding for the control at `at` in `nodes` (one whole read of its window, in document order), or null where none
 * can be made (see the module's note): the caller then binds the whole tree. `title`: the window's. `clicked`: text
 * goes into the control after Ember's own click into it, which may collapse its selection (only that is excused).
 * `risky`: the control's name is risky, so the page's text outside its feeds binds too.
 */
export function pageBinding(nodes: readonly AxNode[], at: number, title: string, clicked = false, risky = false): string | null {
  const target = nodes[at];
  if (!target || !target.name.trim() || target.secret || target.withheld || DIALOG.test(target.role) || target.dialogBox || MONEY_PAGE.test(title)) return null;
  const index = new Map<number, number>();
  for (const [i, n] of nodes.entries()) {
    if (index.has(n.id)) return null; // two elements under one id: nothing can be told apart
    index.set(n.id, i);
  }
  // Its containers, nearest first, up to its page's document. One that wasn't read, or a dialog: no page binding.
  const chain: number[] = [];
  let doc = -1;
  for (let p = target.parent, hops = 0; p !== null; hops++) {
    const i = index.get(p);
    if (i === undefined || hops > 200) return null;
    const a = nodes[i];
    if (DIALOG.test(a.role) || a.dialogBox) return null;
    chain.push(i);
    if (a.role === "document web") { doc = i; break; }
    p = a.parent;
  }
  if (doc < 0) return null;
  /** Is the node at `i` inside the one at `top` (or that one itself)? */
  const within = (i: number, top: number): boolean => {
    for (let j: number | undefined = i, hops = 0; j !== undefined && hops <= 200; hops++) {
      if (j === top) return true;
      const p: number | null = nodes[j].parent;
      j = p === null ? undefined : index.get(p);
    }
    return false;
  };
  /** Is the node at `j` inside something the page fills on its own (FEED)? */
  const inFeed = (j: number): boolean => {
    for (let p = nodes[j].parent, hops = 0; p !== null && hops <= 200; hops++) {
      const i = index.get(p);
      if (i === undefined || i === doc) return false;
      if (FEED.test(nodes[i].role)) return true;
      p = nodes[i].parent;
    }
    return false;
  };
  // Its own group: its form, or the nearest container around it that holds another control; the document at most.
  const form = chain.find(i => i !== doc && nodes[i].role === "form");
  const group = form ?? chain.find(i => i === doc || nodes.some((n, j) => j !== at && (CONTROL.test(n.role) || isField(n)) && within(j, i)))!;
  // (What a reader left unlisted under one of them, offscreen or collapsed, is marked `omitted`, and the mark binds, as
  // it does in the whole tree: what isn't listed was never bound.)
  const inGroup = nodes.flatMap((_, j) => (within(j, group) ? [j] : []));
  const place = new Map(inGroup.map((j, k) => [j, k]));
  const parentIn = (j: number): number | "missing" | null => {
    if (j === group) return null;
    const p = nodes[j].parent;
    const i = p === null ? undefined : index.get(p);
    return i === undefined ? "missing" : place.get(i) ?? "missing";
  };
  return JSON.stringify({
    title,
    page: { role: nodes[doc].role, name: nodes[doc].name },
    dialogs: nodes.filter(n => DIALOG.test(n.role) || n.dialogBox).map(n => ({ role: n.role, name: n.name })),
    path: chain.map(i => ({ role: nodes[i].role, name: nodes[i].name })),
    target: said(target, undefined, clicked),
    group: inGroup.map(j => said(nodes[j], parentIn(j), clicked && j === at)),
    fields: nodes.flatMap((n, j) => (isField(n) ? [said(n, undefined, clicked && j === at)] : [])),
    // The page's own tabs (never the browser's, which are named after other pages and change with them).
    tabs: nodes.flatMap((n, j) => (n.role === "page tab" && within(j, doc) ? [{ name: n.name, states: n.states.filter(x => STATES.test(x)).sort() }] : [])),
    // (Fields aside: a field binds above, exactly. Another control binds by its name, its own counter let through.)
    ...(risky ? {
      prose: nodes.flatMap((n, j) => (j !== doc && j !== at && !isField(n) && !FEED.test(n.role) && !MOVES.test(n.role) && (n.name.trim() || n.text?.trim()) && within(j, doc) && !inFeed(j)
        ? [`${n.role}: ${prose(n)}`] : [])),
    } : {}),
  });
}

/**
 * The binding for the control called `role` and `name` in a later read of the same window: found there exactly once
 * (never by position), or a string that equals no binding (the yes is spent: the control is gone, renamed or has a twin,
 * or its binding can no longer be made).
 */
export function pageBindingOf(nodes: readonly AxNode[], who: { role: string; name: string }, title: string, clicked = false, risky = false): string {
  const found = nodes.flatMap((n, i) => (n.role === who.role && n.name === who.name ? [i] : []));
  if (found.length !== 1) return `unbound: ${found.length} such controls`;
  return pageBinding(nodes, found[0], title, clicked, risky) ?? "unbound: the page's control can't be bound";
}
