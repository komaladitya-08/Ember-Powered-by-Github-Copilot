/** The evaluation dashboard: one self-contained HTML page (no scripts, no network). */

import type { EvalResults } from "./main";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const PILL: Record<string, string> = { pass: "Pass", fail: "Fail", skipped: "Skipped", "not-measured": "Not measured", info: "Tracked" };

export function renderReport(r: EvalResults): string {
  const ran = r.tasks.filter(t => t.status !== "skipped");
  const passed = ran.filter(t => t.status === "pass").length;
  const safety = r.gates.filter(g => g.blocking);
  const safetyOk = safety.every(g => g.status === "pass");
  const measured = r.gates.filter(g => g.status === "pass" || g.status === "fail");
  const gatesMet = measured.filter(g => g.status === "pass").length;
  const asked = ran.reduce((n, t) => n + t.attempts.reduce((m, a) => m + a.questions.length, 0), 0);

  const card = (label: string, value: string, sub: string, tone: string) =>
    `<div class="card ${tone}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;

  const gateRows = r.gates.map(g => `<tr>
      <td><span class="pill ${g.status}">${PILL[g.status]}</span>${g.blocking ? '<span class="tag">blocking</span>' : ""}</td>
      <td class="name">${esc(g.name)}</td><td class="mono">${esc(g.target)}</td><td class="mono strong">${esc(g.value)}</td><td class="note">${esc(g.note ?? "")}</td></tr>`).join("");

  const taskRows = r.tasks.map(t => {
    const a = t.attempts.at(-1);
    const problems = a ? [
      a.error, ...a.checks.filter(c => !c.ok).map(c => `${c.what} → ${c.got}`), ...a.changed.map(c => `changed: ${c}`),
      ...a.safety.outOfScope.map(x => `out of scope: ${x}`), ...a.safety.unconfirmed.map(x => `without confirmation: ${x}`), ...a.safety.notAsked.map(x => `didn't ask: ${x}`),
    ].filter(Boolean) : [];
    const checks = a ? a.checks.map(c => `<li class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"} ${esc(c.what)} <span class="got">${esc(c.got)}</span></li>`).join("") : "";
    const qs = a?.questions.length ? `<div class="qs">Asked: ${a.questions.map(q => `<q>${esc(q)}</q>`).join(" ")}</div>` : "";
    const answer = a?.result ? `<div class="answer">Ember: “${esc(a.result.summary)}”</div>` : "";
    return `<tr class="${t.status}">
      <td><span class="pill ${t.status}">${PILL[t.status]}</span></td>
      <td><div class="name">${esc(t.title)}</div><div class="id mono">${esc(t.id)}</div><div class="tags">${t.tags.map(x => `<span class="tag">${esc(x)}</span>`).join("")}</div></td>
      <td class="mono">${t.status === "skipped" ? "" : `${t.attempts.filter(x => x.ok).length}/${t.attempts.length}`}</td>
      <td class="mono">${a ? `${a.steps}` : ""}</td>
      <td class="mono">${a ? `${(a.ms / 1000).toFixed(1)} s` : ""}</td>
      <td class="detail">${t.status === "skipped" ? `<span class="note">${esc(t.reason)}</span>` : `${problems.length ? `<div class="problems">${problems.map(p => esc(p)).join("<br>")}</div>` : ""}<ul class="checks">${checks}</ul>${qs}${answer}`}</td></tr>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ember evaluation</title>
<style>
:root{--bg:#120d0b;--panel:#1d1512;--line:#33261f;--fg:#f6ece5;--muted:#b3a197;--ok:#7ccf8a;--warn:#f2c14e;--fail:#ff6b57;--accent:#ff8a3d;--info:#9fb6ff;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 Cantarell,"Segoe UI",system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 20px 48px}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:22px}
h1{margin:0;font-size:28px}h1 span{color:var(--accent)}h2{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:30px 0 10px}
.meta{color:var(--muted);font-size:13px;text-align:right}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.card .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.card .value{font-size:28px;font-weight:700;margin:2px 0}.card .sub{color:var(--muted);font-size:13px}
.card.good .value{color:var(--ok)}.card.bad .value{color:var(--fail)}.card.mid .value{color:var(--warn)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
th{text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:9px 12px;border-bottom:1px solid var(--line)}
td{padding:9px 12px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}
.pill.pass{background:rgba(124,207,138,.18);color:var(--ok)}.pill.fail{background:rgba(255,107,87,.18);color:var(--fail)}
.pill.skipped,.pill.not-measured{background:rgba(179,161,151,.15);color:var(--muted)}.pill.info{background:rgba(159,182,255,.15);color:var(--info)}
.tag{display:inline-block;margin:2px 4px 0 0;padding:0 7px;border-radius:999px;font-size:11px;border:1px solid var(--line);color:var(--muted)}
.mono{font-family:ui-monospace,"DejaVu Sans Mono",monospace;font-size:12.5px}.strong{color:var(--fg);font-weight:700}.note{color:var(--muted);font-size:12.5px}
.name{font-weight:700}.id{color:var(--muted)}.detail{font-size:12.5px;max-width:520px}
.checks{list-style:none;margin:0;padding:0}.checks li.ok{color:#cfe9d4}.checks li.bad{color:var(--fail)}.got{color:var(--muted)}
.problems{color:var(--fail);margin-bottom:4px}.qs{margin-top:4px;color:var(--warn)}.qs q{color:var(--fg)}.answer{margin-top:4px;color:var(--muted);font-style:italic}
tr.skipped td{opacity:.65}
footer{margin-top:26px;color:var(--muted);font-size:12.5px}
@media (max-width:760px){td.detail{max-width:none}.meta{text-align:left}}
</style></head><body><main>
<header><div><h1><span>Ember</span> evaluation</h1><div class="note">${esc(r.tier)} · ${esc(r.model)}${r.repeat > 1 ? ` · pass^${r.repeat}` : ""}</div></div>
<div class="meta">${esc(new Date(r.when).toUTCString())}<br>${esc(r.machine.os)} · display ${esc(r.machine.display || "none")}</div></header>
<div class="cards">
${card("Tasks", ran.length ? `${passed}/${ran.length}` : "—", `${r.tasks.length - ran.length} skipped on this machine`, ran.length && passed === ran.length ? "good" : passed / Math.max(1, ran.length) >= 0.7 ? "mid" : "bad")}
${card("Safety gates", safety.length ? (safetyOk ? "All met" : "Not met") : "—", "injection fixtures, unconfirmed actions", safetyOk ? "good" : "bad")}
${card("Release gates measured", `${gatesMet}/${measured.length}`, `${r.gates.length - measured.length} not measurable here`, gatesMet === measured.length ? "good" : "mid")}
${card("Questions asked", String(asked), "Ember asked before acting", "")}
</div>
<h2>Release gates (PLAN.md §6)</h2>
<table><thead><tr><th></th><th>Gate</th><th>Target</th><th>Measured</th><th>How</th></tr></thead><tbody>${gateRows}</tbody></table>
<h2>Task suite</h2>
<table><thead><tr><th></th><th>Task</th><th>Passed</th><th>Steps</th><th>Time</th><th>Checks</th></tr></thead><tbody>${taskRows}</tbody></table>
<footer>Every task runs through Ember's real worker, accessibility reader, policy engine, mouse and keyboard, and audit log, against real windows. Safety is judged from Ember's own audit log, not from what the model says. ${r.tier.startsWith("per-PR") ? "In this tier a scripted model replays each task's steps, so the numbers measure Ember's machinery; the nightly tier lets a real model work from the instruction alone." : ""}</footer>
</main></body></html>
`;
}
