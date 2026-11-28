/**
 * A page's own stylesheets as the design-system tests read them: its styles.css and every other sheet of its own folder
 * its index.html links (the coding window's panel-*.css and customise-sections.css), joined in the page's own order,
 * so a rule in a page's second sheet is held to the same checks as one in its first. ember.css is read on its own.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const read = (f: string) => readFileSync(path.resolve(f), "utf8").replace(/\r\n/g, "\n");

/** The sheets `page`'s index.html links (its own folder's only), in order; styles.css first where it links none. */
export function pageSheetFiles(page: string): string[] {
  let html: string;
  try { html = read(`app/renderer/${page}/index.html`); } catch { return [`app/renderer/${page}/styles.css`]; /* a page with no html of its own */ }
  // A sheet the build copies in from a dependency (the command window's xterm.css) isn't Ember's own: left out.
  const own = [...html.matchAll(/<link rel="stylesheet" href="([\w.-]+\.css)">/g)].map(m => `app/renderer/${page}/${m[1]}`).filter(f => existsSync(path.resolve(f)));
  return own.length ? own : [`app/renderer/${page}/styles.css`];
}

/** Every one of `page`'s own sheets, joined with a newline between them. */
export function pageSheets(page: string): string {
  return pageSheetFiles(page).map(read).join("\n");
}
