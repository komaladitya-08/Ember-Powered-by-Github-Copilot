/**
 * Customise › Plugins, on this computer: the installed plugins (client `plugins.list`), each turned on and off
 * (`plugins.enable`/`disable`), updated (`plugins.update`, `plugins.updateAll`) and uninstalled (`plugins.uninstall`,
 * confirmed); installing by its spec (`plugins.install`); and the marketplaces (`plugins.marketplaces.list`, `add`,
 * `remove` confirmed, `browse` with Install beside each plugin, `refresh`). A plugin managed by the organisation shows
 * its switch held; a direct install can't be turned off (the SDK says so), only uninstalled.
 */
import {
  BROWSE_NONE, MARKETPLACES, MARKETPLACES_NONE, MARKET_ADD, MARKET_ADD_HINT, MARKET_ADD_LABEL, MARKET_DEFAULT, MARKET_REFRESH,
  PLUGINS_HINT, PLUGINS_INSTALLED, PLUGINS_NONE, PLUGIN_INSTALL, PLUGIN_INSTALL_HINT, PLUGIN_INSTALL_LABEL, PLUGIN_UNINSTALL, PLUGIN_UPDATE,
  PLUGIN_UPDATE_ALL, REMOVE, UPDATED_ALL, browseLabel, installLabel, marketAdded, marketHeld, pluginInstalledWords, pluginMeta, pluginUpdatedWords,
  refreshedWords, removeQuestion, removed, turnedOn, uninstallQuestion, uninstalled,
} from "./copy-customise";
import { marketplaceSourceError, pluginSourceError } from "./customise-forms";
import { action, confirmed, defineSection, disclosure, field, input, list, load, part, row, toggle, workingDir } from "./customise-kit";
import { marketplacePlugins, marketplaceRemoved, marketplaceRows, pluginInstalled, pluginRows, pluginSpec, pluginUpdated, refreshFailures, type PluginRow } from "./customise-read";
import { el, idPart } from "./dom";

defineSection("Plugins", "client", ctx => {
  let installedHost: HTMLElement | null = null;
  let marketsHost: HTMLElement | null = null;
  const reloadInstalled = () => { if (installedHost) void load(installedHost, () => ctx.call("client", "plugins.list"), v => list(PLUGINS_INSTALLED, pluginRows(v).map(pluginRow), PLUGINS_NONE)); };
  const reloadMarkets = () => { if (marketsHost) void load(marketsHost, () => ctx.call("client", "plugins.marketplaces.list"), v => list(MARKETPLACES, marketplaceRows(v).map(marketRow), MARKETPLACES_NONE)); };

  async function install(spec: string): Promise<string | null> {
    const r = await ctx.call("client", "plugins.install", { source: spec, ...workingDir(ctx) });
    if (!r.ok) return r.reason;
    const out = pluginInstalled(r.value);
    ctx.say(pluginInstalledWords(out.name ?? spec, out.skills, out.deprecated));
    reloadInstalled();
    return null;
  }

  function pluginRow(p: PluginRow): HTMLLIElement {
    const spec = pluginSpec(p);
    const id = `cz-plugin-${idPart(spec)}`;
    const sw = p.marketplace ? toggle({
      labelledBy: id, on: p.enabled, disabled: p.managed, ctx,
      change: on => ctx.call("client", on ? "plugins.enable" : "plugins.disable", { names: [spec], ...workingDir(ctx) }),
      done: on => ctx.say(turnedOn(p.name, on)),
    }) : null;
    const update = p.builtin ? null : action(PLUGIN_UPDATE, async () => {
      const r = await ctx.call("client", "plugins.update", { name: spec });
      ctx.say(r.ok ? pluginUpdatedWords(p.name, pluginUpdated(r.value)) : r.reason);
      if (r.ok) reloadInstalled();
    }, { aria: `${PLUGIN_UPDATE} “${p.name}”` });
    const uninstall = p.builtin || p.managed ? null : confirmed(PLUGIN_UNINSTALL, uninstallQuestion(p.name), PLUGIN_UNINSTALL, async () => {
      const r = await ctx.call("client", "plugins.uninstall", { name: spec, ...(p.directSourceId ? { directSourceId: p.directSourceId } : {}) });
      ctx.say(r.ok ? uninstalled(p.name) : r.reason);
      if (r.ok) reloadInstalled();
    }, { aria: `${PLUGIN_UNINSTALL} “${p.name}”` });
    return row({ name: p.name, id, lines: [pluginMeta(p)], actions: [sw, update, uninstall] });
  }

  function marketRow(m: { name: string; source: string; isDefault: boolean; managed: boolean; available: boolean }): HTMLLIElement {
    const browse = disclosure(browseLabel(m.name), into => void load(into, () => ctx.call("client", "plugins.marketplaces.browse", { name: m.name }), v => {
      const items = marketplacePlugins(v);
      return items.length ? el("ul", { className: "cz-list nested", attrs: { "aria-label": browseLabel(m.name) } }, ...items.map(p => {
        const err = el("p", { className: "cz-err" });
        const go = action(PLUGIN_INSTALL, async () => { const why = await install(`${p.name}@${m.name}`); err.textContent = why ?? ""; }, { aria: installLabel(p.name) });
        return row({ name: p.name, lines: [p.description], actions: [go], more: [err] });
      })) : el("p", { className: "cz-line", textContent: BROWSE_NONE });
    }));
    const remove = m.isDefault || m.managed ? null : confirmed(REMOVE, removeQuestion(m.name), REMOVE, async () => {
      const r = await ctx.call("client", "plugins.marketplaces.remove", { name: m.name });
      if (!r.ok) { ctx.say(r.reason); return; }
      const out = marketplaceRemoved(r.value);
      ctx.say(out.removed ? removed(m.name) : marketHeld(m.name, out.dependents));
      if (out.removed) reloadMarkets();
    }, { aria: `${REMOVE} “${m.name}”` });
    return row({ name: m.name, lines: [m.source], tags: [m.isDefault ? MARKET_DEFAULT : ""], actions: [remove], more: [browse] });
  }

  /** A one-line form: a field, its check, and the call it makes. */
  function oneLine(id: string, label: string, hint: string, button: string, check: (s: string) => string | null, run: (s: string) => Promise<string | null>): HTMLElement {
    const box = input();
    const f = field(id, label, box, hint);
    const go = el("button", { type: "submit", className: "btn quiet small", textContent: button });
    const form = el("form", { className: "cz-form cz-one-line", noValidate: true }, f.root, go);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      if (go.disabled) return;
      const why = check(box.value);
      f.error(why ?? "");
      if (why) { box.focus(); return; }
      go.disabled = true;
      const refused = await run(box.value.trim());
      go.disabled = false;
      f.error(refused ?? "");
      if (refused) box.focus(); else box.value = "";
    });
    return form;
  }

  return {
    draw(body) {
      const updateAll = action(PLUGIN_UPDATE_ALL, async () => {
        const r = await ctx.call("client", "plugins.updateAll");
        ctx.say(r.ok ? UPDATED_ALL : r.reason);
        if (r.ok) reloadInstalled();
      });
      const installed = part(PLUGINS_INSTALLED, { lead: PLUGINS_HINT, actions: [updateAll] });
      installedHost = installed.body;
      installed.root.append(oneLine("cz-plugin-source", PLUGIN_INSTALL_LABEL, PLUGIN_INSTALL_HINT, PLUGIN_INSTALL, pluginSourceError, install));
      const refresh = action(MARKET_REFRESH, async () => {
        const r = await ctx.call("client", "plugins.marketplaces.refresh", {});
        ctx.say(r.ok ? refreshedWords(refreshFailures(r.value)) : r.reason);
      });
      const markets = part(MARKETPLACES, { actions: [refresh] });
      marketsHost = markets.body;
      markets.root.append(oneLine("cz-market-source", MARKET_ADD_LABEL, MARKET_ADD_HINT, MARKET_ADD, marketplaceSourceError, async src => {
        const r = await ctx.call("client", "plugins.marketplaces.add", { source: src, ...workingDir(ctx) });
        if (!r.ok) return r.reason;
        const name = typeof (r.value as { name?: unknown })?.name === "string" ? (r.value as { name: string }).name : src;
        ctx.say(marketAdded(name));
        reloadMarkets();
        return null;
      }));
      body.replaceChildren(installed.root, markets.root);
      reloadInstalled();
      reloadMarkets();
    },
  };
});
