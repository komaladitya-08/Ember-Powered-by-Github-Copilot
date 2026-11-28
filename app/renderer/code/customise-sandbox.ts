/**
 * Customise › Sandbox, read-only: whether this computer can run Copilot's tools in a sandbox and each capability that
 * varies between hosts (client `sandbox.getHostSupport`: network inside the sandbox, a proxy), with the SDK's remedy
 * for what is missing quoted as its own words; and for the open session, what its row says (on, without the network,
 * off) and whether the organisation requires the sandbox or it was lost (`sandbox.getEnforcementStatus`). The window
 * can't change the sandbox (main refuses any call that would: app/main/code/guards.ts), and it says where that is
 * decided.
 */
import {
  ENFORCE_BLOCKED, ENFORCE_REQUIRED, SANDBOX_CAPS_NONE, SANDBOX_HOST, SANDBOX_NO, SANDBOX_SESSION, SANDBOX_WHERE, SANDBOX_YES, SESSION_PART_NONE,
  WHAT_IS_MISSING, capabilityLine, sandboxRow,
} from "./copy-customise";
import { defineSection, list, load, part, problem, row } from "./customise-kit";
import { enforcement, hostSupport } from "./customise-read";
import { el } from "./dom";

defineSection("Sandbox", "both", ctx => ({
  draw(body) {
    const host = part(SANDBOX_HOST, { scope: "client" });
    const session = part(SANDBOX_SESSION, { scope: "session", session: ctx.session() });
    body.replaceChildren(el("p", { className: "cz-callout", textContent: SANDBOX_WHERE }), host.root, session.root);
    void load(host.body, () => ctx.call("client", "sandbox.getHostSupport"), v => {
      const h = hostSupport(v);
      const missing = (reason?: string) => (reason ? el("p", { className: "cz-line cz-quoted" }, el("span", { className: "cz-quote-label", textContent: `${WHAT_IS_MISSING}: ` }), el("span", { textContent: reason })) : null);
      return [
        el("p", { className: "cz-status", data: { state: h.supported ? "on" : "off" }, textContent: h.supported ? SANDBOX_YES : SANDBOX_NO }),
        h.supported ? null : missing(h.reason),
        h.supported ? list(SANDBOX_HOST, h.capabilities.map(c => row({ name: capabilityLine(c), more: [c.supported ? null : missing(c.reason)] })), SANDBOX_CAPS_NONE) : null,
      ];
    });
    const r = ctx.session();
    if (!r) { session.body.replaceChildren(problem({ reason: SESSION_PART_NONE })); return; }
    const rowLine = el("p", { className: "cz-status", data: { state: r.sandbox ?? "unknown" }, textContent: sandboxRow(r.sandbox) });
    const enforced = el("div");
    session.body.replaceChildren(rowLine, enforced);
    void load(enforced, () => ctx.call("session", "sandbox.getEnforcementStatus"), v => {
      const e = enforcement(v);
      return [e.required ? el("p", { className: "cz-line", textContent: ENFORCE_REQUIRED }) : null, e.blocked ? el("p", { className: "cz-line cz-bad", textContent: ENFORCE_BLOCKED }) : null];
    });
  },
}));
