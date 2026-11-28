/**
 * Customise › MCP servers: the servers set up on this computer (client `mcp.config.list`, with whether each is on from
 * `mcp.discover`), added and edited through a form (`mcp.config.add`/`update`: a program with its arguments and
 * variables, or a remote address with its headers), removed (confirmed), turned on and off (`mcp.config.enable`/
 * `disable`) and read again (`mcp.config.reload`); and, for the open session, each server's status (`mcp.list`, kept
 * current by `session.mcp_server_status_changed`), its tools, resources and prompts, start, stop, restart, and sign-in
 * where a server needs it (`mcp.oauth.login`: the runtime runs the whole sign-in and gives an https address, which
 * opens in the person's browser through main's `openLink` or can be copied; the server's status after it is followed
 * from `session.mcp_server_status_changed` and `mcp.oauth_completed`).
 *
 * Secrets: a variable's or a header's value is never drawn. Its field is a masked, write-only box, empty on an edit (the
 * value Copilot holds is kept unless a new one is typed: customise-forms.ts), and the form's boxes are gone from the
 * page once it closes.
 */
import { CANCEL, E_FORM, EDIT, FAILED, F_ADDED, F_ADD_ENV, F_ADD_HEADER, F_ARGS, F_ARGS_HINT, F_COMMAND, F_COMMAND_HINT, F_CWD, F_ENV, F_ENV_HINT, F_HEADERS, F_HEADERS_HINT, F_KEPT, F_KIND, F_KIND_HTTP, F_KIND_SSE, F_KIND_STDIO, F_NAME, F_NAME_HINT, F_SAVE, F_SAVED, F_URL, F_URL_HINT, MCP_ADD, MCP_ALSO, MCP_ALSO_LEAD, MCP_CONFIGURED, MCP_EVENTS_NOTE, MCP_FIND, MCP_LIVE, MCP_LIVE_NONE, MCP_NONE, MCP_PROMPTS, MCP_RELOAD, MCP_RESOURCES, MCP_RESTART, MCP_SIGN_IN, MCP_START, MCP_STOP, MCP_TOOLS, REMOVE, RELOADED, SESSION_PART_NONE, SIGNED_IN, SIGN_IN_COPIED, SIGN_IN_COPY, SIGN_IN_LINK, SIGN_IN_OPEN, SIGN_IN_OPENED, SIGN_IN_UNUSABLE, SIGN_IN_WINDOW, envNamesLine, fieldLabel, fromPlugin, headerNamesLine, mcpDetails, mcpFormTitle, mcpItemsNone, mcpKind, mcpStartLabel, mcpStarted, mcpStatusWords, removeField, removeQuestion, removed, sourceWords, turnedOn } from "./copy-customise";
import { action, confirmed, defineSection, disclosure, field, input, list, load, part, problem, row, toggle, workingDir } from "./customise-kit";
import { EMPTY_MCP_FORM, checkMcpForm, formFromConfig, mergedConfig, type McpField, type McpForm, type Pair } from "./customise-forms";
import { mcpConfigured, mcpDiscovered, mcpItems, mcpLive, mcpStatusChanged, oauthLogin, type McpConfigured, type McpLive } from "./customise-read";
import { copyText, el, idPart, setText } from "./dom";
import { str } from "./sdk";

defineSection("MCP servers", "both", ctx => {
  let configured: McpConfigured[] = [];
  let raw: Record<string, Record<string, unknown>> = {};
  let live: McpLive[] = [];
  let liveHost: HTMLElement | null = null;
  let formHost: HTMLElement | null = null;
  let addBtn: HTMLButtonElement | null = null;
  let confBody: HTMLElement | null = null;

  /** The server whose sign-in this page started, and the line under it, until it connects. */
  let signing: { server: string; out: HTMLElement } | null = null;

  ctx.onEvent(e => {
    const signedIn = (name: string | undefined) => {
      if (!signing || name !== signing.server) return;
      signing.out.replaceChildren();
      signing = null;
      ctx.say(SIGNED_IN);
    };
    if (e.type === "mcp.oauth_completed") { signedIn(str(e.data, "serverName")); return; }
    if (e.type !== "session.mcp_server_status_changed" || !liveHost) return;
    live = mcpStatusChanged(live, e.data);
    if (str(e.data, "status") === "connected") signedIn(str(e.data, "serverName"));
    drawLive(liveHost);
  });

  return {
    draw(body) {
      addBtn = el("button", { type: "button", className: "btn quiet small", textContent: MCP_ADD });
      addBtn.addEventListener("click", () => openForm(null));
      const reload = action(MCP_RELOAD, async () => {
        const r = await ctx.call("client", "mcp.config.reload");
        ctx.say(r.ok ? RELOADED : r.reason);
        if (r.ok) loadConfigured(conf.body);
      });
      const conf = part(MCP_CONFIGURED, { scope: "client", actions: [addBtn, reload] });
      confBody = conf.body;
      formHost = el("div", { className: "cz-form-host" });
      conf.root.insertBefore(formHost, conf.body);
      const sess = part(MCP_LIVE, { scope: "session", session: ctx.session(), lead: MCP_EVENTS_NOTE });
      liveHost = sess.body;
      body.replaceChildren(conf.root, el("p", { className: "hint cz-after", textContent: MCP_FIND }), sess.root);
      loadConfigured(conf.body);
      if (ctx.session()) void loadLive(sess.body); else sess.body.replaceChildren(problem({ reason: SESSION_PART_NONE }));
    },
  };

  function loadConfigured(host: HTMLElement): void {
    void load(host, async () => {
      const [cfg, found] = await Promise.all([ctx.call("client", "mcp.config.list"), ctx.call("client", "mcp.discover", workingDir(ctx))]);
      return cfg.ok ? { ok: true, value: { cfg: cfg.value, found: found.ok ? found.value : null } } : cfg;
    }, v => {
      const { cfg, found } = v as { cfg: unknown; found: unknown };
      ({ rows: configured, raw } = mcpConfigured(cfg));
      const discovered = found ? mcpDiscovered(found) : [];
      const enabled = new Map(discovered.map(d => [d.name, d.enabled]));
      const mine = list(MCP_CONFIGURED, configured.map(s => serverRow(s, enabled.get(s.name) ?? true, host)), MCP_NONE);
      const others = discovered.filter(d => !raw[d.name]);
      const also = others.length ? el("div", { className: "cz-also" },
        el("h4", { textContent: MCP_ALSO }), el("p", { className: "hint", textContent: MCP_ALSO_LEAD }),
        list(MCP_ALSO, others.map(d => row({ name: d.name, lines: [d.plugin ? fromPlugin(d.plugin) : sourceWords(d.source)], tags: [d.enabled ? "" : mcpStatusWords("disabled")] })), "")) : null;
      return [mine, also];
    });
  }

  function serverRow(s: McpConfigured, on: boolean, host: HTMLElement): HTMLLIElement {
    const nameId = `cz-mcp-${idPart(s.name)}`;
    const sw = toggle({
      labelledBy: nameId, on, ctx,
      change: want => ctx.call("client", want ? "mcp.config.enable" : "mcp.config.disable", { names: [s.name] }),
      done: want => ctx.say(turnedOn(s.name, want)),
    });
    const edit = el("button", { type: "button", className: "btn quiet small", textContent: EDIT, attrs: { "aria-label": `${EDIT.replace("…", "")} “${s.name}”…` } });
    edit.addEventListener("click", () => openForm(s.name, edit));
    const remove = confirmed(REMOVE, removeQuestion(s.name), REMOVE, async () => {
      const r = await ctx.call("client", "mcp.config.remove", { name: s.name });
      ctx.say(r.ok ? removed(s.name) : r.reason);
      if (r.ok) loadConfigured(host);
    }, { aria: `${REMOVE} “${s.name}”` });
    return row({
      name: s.name, id: nameId,
      lines: [mcpKind(s.kind), envNamesLine(s.envNames), headerNamesLine(s.headerNames), ...s.warnings.slice(0, 2)],
      mono: s.kind === "stdio" ? [s.command, ...s.args].join(" ") : s.url,
      tags: [s.plugin ? fromPlugin(s.plugin) : s.source && s.source !== "user" ? sourceWords(s.source) : ""],
      actions: [sw, edit, remove],
    });
  }

  // ───── The form ─────

  function openForm(editing: string | null, back: HTMLElement | null = addBtn): void {
    if (!formHost) return;
    const f: McpForm = editing && raw[editing] ? formFromConfig(editing, raw[editing]) : { ...EMPTY_MCP_FORM, env: [], headers: [] };
    const keptEnv = editing ? (raw[editing]?.env as Record<string, unknown> | undefined) : undefined;
    const keptHeaders = editing ? (raw[editing]?.headers as Record<string, unknown> | undefined) : undefined;
    const fields = new Map<McpField, (t: string) => void>();
    const form = el("form", { className: "cz-form cz-mcp-form", noValidate: true, attrs: { "aria-labelledby": "cz-mcp-form-h" } });
    const title = el("h4", { id: "cz-mcp-form-h", textContent: mcpFormTitle(editing), tabIndex: -1 });
    const name = input({ value: f.name });
    const nameF = field("cz-mcp-name", F_NAME, name, F_NAME_HINT);
    fields.set("name", nameF.error);
    const kind = el("select", {}, ...([["stdio", F_KIND_STDIO], ["http", F_KIND_HTTP], ["sse", F_KIND_SSE]] as const).map(([v, t]) => el("option", { value: v, textContent: t, selected: f.kind === v })));
    const kindF = field("cz-mcp-kind", F_KIND, kind);
    const command = input({ value: f.command });
    const commandF = field("cz-mcp-command", F_COMMAND, command, F_COMMAND_HINT);
    fields.set("command", commandF.error);
    const args = el("textarea", { rows: 3, value: f.args, spellcheck: false });
    const argsF = field("cz-mcp-args", F_ARGS, args, F_ARGS_HINT);
    const cwd = input({ value: f.cwd });
    const cwdF = field("cz-mcp-cwd", F_CWD, cwd);
    fields.set("cwd", cwdF.error);
    const url = input({ value: f.url, type: "url" });
    const urlF = field("cz-mcp-url", F_URL, url, F_URL_HINT);
    fields.set("url", urlF.error);
    const env = pairsEditor("env", f.env, keptEnv, fields);
    const headers = pairsEditor("header", f.headers, keptHeaders, fields);
    const envGroup = el("fieldset", { className: "cz-pairs" }, el("legend", { textContent: F_ENV }), el("p", { className: "hint", textContent: F_ENV_HINT }), env.root);
    const headerGroup = el("fieldset", { className: "cz-pairs" }, el("legend", { textContent: F_HEADERS }), el("p", { className: "hint", textContent: F_HEADERS_HINT }), headers.root);
    const local = el("div", { className: "cz-form" }, commandF.root, argsF.root, cwdF.root, envGroup);
    const remote = el("div", { className: "cz-form" }, urlF.root, headerGroup);
    const showKind = () => { local.hidden = kind.value !== "stdio"; remote.hidden = kind.value === "stdio"; };
    kind.addEventListener("change", showKind);
    showKind();
    const formErr = el("p", { className: "cz-err cz-form-err", attrs: { role: "alert" } });
    const save = el("button", { type: "submit", className: "btn small", textContent: F_SAVE });
    const cancel = el("button", { type: "button", className: "btn quiet small", textContent: CANCEL });
    const close = () => { formHost?.replaceChildren(); back?.focus(); };
    cancel.addEventListener("click", close);
    form.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); close(); } });
    form.addEventListener("submit", async e => {
      e.preventDefault();
      if (save.disabled) return;
      const now: McpForm = { name: name.value, kind: kind.value as McpForm["kind"], command: command.value, args: args.value, cwd: cwd.value, env: env.read(), url: url.value, headers: headers.read() };
      const checked = checkMcpForm(now, configured.map(c => c.name), editing, { env: keptEnv, headers: keptHeaders });
      for (const [k, set] of fields) set(checked.errors[k] ?? "");
      if (!checked.config) {
        setText(formErr, E_FORM);
        const first = (Object.keys(checked.errors) as McpField[]).map(k => form.querySelector<HTMLElement>(`#${fieldId(k)}`)).find(Boolean);
        first?.focus();
        return;
      }
      setText(formErr, "");
      save.disabled = true;
      const nm = now.name.trim();
      const r = editing
        ? await ctx.call("client", "mcp.config.update", { name: editing, config: mergedConfig(raw[editing] ?? {}, checked.config) })
        : await ctx.call("client", "mcp.config.add", { name: nm, config: checked.config });
      save.disabled = false;
      if (!r.ok) { setText(formErr, r.reason); return; }
      formHost?.replaceChildren();
      ctx.say(editing ? F_SAVED(nm) : F_ADDED(nm));
      if (confBody) loadConfigured(confBody);
      addBtn?.focus();
    });
    if (editing) { name.readOnly = true; }
    form.append(title, nameF.root, kindF.root, local, remote, formErr, el("div", { className: "cz-form-actions" }, save, cancel));
    formHost.replaceChildren(form);
    (editing ? title : name).focus();
  }

  function pairsEditor(kind: "env" | "header", start: Pair[], kept: Record<string, unknown> | undefined, fields: Map<McpField, (t: string) => void>): { root: HTMLElement; read(): Pair[] } {
    const root = el("div", { className: "cz-pair-list" });
    const rows: { name: HTMLInputElement; value: HTMLInputElement; li: HTMLElement }[] = [];
    const add = el("button", { type: "button", className: "btn quiet small", textContent: kind === "env" ? F_ADD_ENV : F_ADD_HEADER });
    const relabel = () => rows.forEach((r, i) => {
      r.name.id = fieldId(`${kind}.${i}.name` as McpField);
      r.value.id = fieldId(`${kind}.${i}.value` as McpField);
      r.name.setAttribute("aria-label", fieldLabel(kind, "name", i + 1));
      r.value.setAttribute("aria-label", fieldLabel(kind, "value", i + 1));
      r.name.setAttribute("aria-describedby", `${r.name.id}-err`);
      r.value.setAttribute("aria-describedby", `${r.value.id}-err`);
      const errs = r.li.querySelectorAll<HTMLElement>(".cz-err");
      errs[0].id = `${r.name.id}-err`; errs[1].id = `${r.value.id}-err`;
      r.li.querySelector(".cz-x")?.setAttribute("aria-label", removeField(kind, i + 1));
      fields.set(`${kind}.${i}.name` as McpField, t => { setText(errs[0], t); if (t) r.name.setAttribute("aria-invalid", "true"); else r.name.removeAttribute("aria-invalid"); });
      fields.set(`${kind}.${i}.value` as McpField, t => { setText(errs[1], t); if (t) r.value.setAttribute("aria-invalid", "true"); else r.value.removeAttribute("aria-invalid"); });
    });
    const addRow = (p: Pair, focus = false) => {
      const name = input({ value: p.name });
      // Write-only and masked: a value is never put back in the page, so its box starts empty.
      const value = input({ type: "password", placeholder: p.name && typeof kept?.[p.name] === "string" ? F_KEPT : "" });
      value.autocomplete = "new-password";
      const x = el("button", { type: "button", className: "btn quiet small cz-x", textContent: REMOVE });
      const li = el("div", { className: "cz-pair" }, el("div", { className: "cz-pair-cell" }, name, el("p", { className: "cz-err" })), el("div", { className: "cz-pair-cell" }, value, el("p", { className: "cz-err" })), x);
      const entry = { name, value, li };
      x.addEventListener("click", () => {
        const i = rows.indexOf(entry);
        rows.splice(i, 1);
        li.remove();
        for (const k of [...fields.keys()]) if (k.startsWith(`${kind}.`)) fields.delete(k);
        relabel();
        (rows[i]?.name ?? add).focus();
      });
      rows.push(entry);
      root.insertBefore(li, add);
      relabel();
      if (focus) name.focus();
    };
    root.append(add);
    add.addEventListener("click", () => addRow({ name: "", value: "" }, true));
    for (const p of start) addRow(p);
    return { root, read: () => rows.map(r => ({ name: r.name.value, value: r.value.value })) };
  }

  // ───── The session's servers ─────

  async function loadLive(host: HTMLElement): Promise<void> {
    const v = await load(host, () => ctx.call("session", "mcp.list"), v => { live = mcpLive(v); return []; });
    if (v !== null) drawLive(host);
  }

  function drawLive(host: HTMLElement): void {
    // Disclosures kept open across a redraw for a status change.
    const open = new Set([...host.querySelectorAll<HTMLDetailsElement>("details[open]")].map(d => d.dataset.server ?? ""));
    host.replaceChildren(list(MCP_LIVE, live.map(s => liveRow(s, host, open.has(s.name))), MCP_LIVE_NONE));
  }

  function liveRow(s: McpLive, host: HTMLElement, opened: boolean): HTMLLIElement {
    const signOut = el("div", { className: "cz-sub" });
    const verb = (v: "start" | "stop" | "restart", label: string, method: string) => action(label, async () => {
      const r = await ctx.call("session", method, { serverName: s.name });
      ctx.say(r.ok ? mcpStarted(s.name, v) : r.reason);
      if (r.ok) await loadLive(host);
    }, { aria: mcpStartLabel(label, s.name) });
    const running = s.status === "connected" || s.status === "pending" || s.status === "needs-auth";
    const actions = [
      s.status === "needs-auth" ? action(MCP_SIGN_IN, () => signIn(s.name, signOut), { aria: mcpStartLabel(MCP_SIGN_IN, s.name) }) : null,
      running ? verb("restart", MCP_RESTART, "mcp.restartServer") : null,
      running ? verb("stop", MCP_STOP, "mcp.stopServer") : verb("start", MCP_START, "mcp.startServer"),
    ];
    const details = disclosure(mcpDetails(s.displayName ?? s.name), into => drawOffers(s.name, into));
    details.dataset.server = s.name;
    if (opened) details.open = true;
    return row({ name: s.displayName ?? s.name, id: `cz-live-${idPart(s.name)}`, lines: [[mcpStatusWords(s.status, s.failed), s.plugin ? fromPlugin(s.plugin) : s.source ? sourceWords(s.source) : ""].filter(Boolean).join(" · ")], mono: s.url, actions, more: [signOut, s.status === "connected" ? details : null] });
  }

  function drawOffers(server: string, into: HTMLElement): void {
    const parts = ([["tools", MCP_TOOLS, "mcp.listTools"], ["resources", MCP_RESOURCES, "mcp.resources.list"], ["prompts", MCP_PROMPTS, "mcp.prompts.list"]] as const).map(([kind, label, method]) => {
      const box = el("div", { className: "cz-offer" });
      void load(box, () => ctx.call("session", method, { serverName: server }), v => {
        const items = mcpItems(v, kind);
        return items.length ? el("ul", { className: "cz-plain", attrs: { "aria-label": `${label}: ${server}` } }, ...items.map(i => el("li", {}, el("span", { className: "cz-mono", textContent: i.title ?? i.name }), i.description ? el("span", { className: "cz-line", textContent: i.description }) : null, i.detail ? el("span", { className: "cz-line", textContent: i.detail }) : null))) : el("p", { className: "cz-line", textContent: mcpItemsNone(kind) });
      });
      return el("div", { className: "cz-offers-part" }, el("h4", { textContent: label }), box);
    });
    into.replaceChildren(...parts);
  }

  async function signIn(server: string, out: HTMLElement): Promise<void> {
    const r = await ctx.call("session", "mcp.oauth.login", { serverName: server });
    if (!r.ok) { out.replaceChildren(problem(r, () => { void signIn(server, out); })); return; }
    const login = oauthLogin(r.value);
    if (!login.url) {
      if (login.connected) { out.replaceChildren(); ctx.say(SIGNED_IN); } else out.replaceChildren(problem({ reason: SIGN_IN_UNUSABLE }, () => { void signIn(server, out); }));
      return;
    }
    const copied = el("span", { className: "cz-line", attrs: { role: "status" } });
    const openIt = el("button", { type: "button", className: "btn small", textContent: SIGN_IN_OPEN });
    const copy = el("button", { type: "button", className: "btn quiet small", textContent: SIGN_IN_COPY });
    const url = login.url;
    signing = { server, out };
    openIt.addEventListener("click", async () => {
      // Main opens it (https only, as `oauthLogin` kept it): the window never navigates.
      let r: { ok: boolean; reason?: string };
      try { r = await ctx.app.api.openLink(url); } catch { r = { ok: false, reason: FAILED }; }
      setText(copied, r.ok ? SIGN_IN_OPENED : r.reason || FAILED);
    });
    copy.addEventListener("click", async () => { if (await copyText(url)) setText(copied, SIGN_IN_COPIED); });
    out.replaceChildren(el("p", { className: "cz-line", textContent: SIGN_IN_WINDOW }), el("p", { className: "cz-line", textContent: SIGN_IN_LINK }), el("p", { className: "cz-mono cz-url", textContent: url }), el("div", { className: "cz-form-actions" }, openIt, copy, copied));
    openIt.focus();
  }
});

/** The element id of a form field, from its check's key ("env.0.name" is "cz-mcp-env-0-name"). */
const fieldId = (k: McpField) => `cz-mcp-${k.replace(/\./g, "-")}`;
