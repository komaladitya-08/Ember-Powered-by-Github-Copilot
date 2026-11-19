/** Direct-path checks for native SDK tools. These are defence in depth, not a filesystem sandbox. */
import fs from "node:fs/promises";
import path from "node:path";
import { classifyCommand } from "../commands/classify";
import type { ClassifyContext, ShellId } from "../commands/types";
import type { OS } from "../../shared/shortcuts";
import type { PreToolUseHookInput } from "./session-config";

export interface CodingSafetyOptions {
  workspace: string;
  home: string;
  os: OS;
  ember: ClassifyContext["ember"];
}

/** Resolve existing ancestors too, so a new file reached through a symlink has its physical parent checked. */
async function physical(file: string): Promise<string> {
  let current = file;
  const tail: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...tail.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function inside(target: string, root: string, os: OS): boolean {
  const normal = (s: string) => os === "win32" ? s.toLowerCase() : s;
  const rel = path.relative(normal(root), normal(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** Check obvious direct access and named shell targets. Shell programs can access other paths indirectly. */
export function createCodingSafety(o: CodingSafetyOptions): (input: PreToolUseHookInput) => Promise<string | null> {
  return async input => {
    let raw = input.toolArgs;
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw) as unknown; } catch { return "The tool's arguments could not be checked."; }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "The tool's arguments could not be checked.";
    const args = raw as Record<string, unknown>;
    const name = input.toolName.replace(/^builtin:/, "");
    if (name === "bash" || name === "powershell") {
      if (typeof args.command !== "string") return "The command could not be checked.";
      const shell: ShellId = name === "powershell" ? "powershell" : "bash";
      const cls = classifyCommand(args.command, shell, { os: o.os, home: o.home, cwd: input.workingDirectory || o.workspace,
        ember: o.ember, downloaded: new Set() });
      return cls.refuse ? "This command targets Ember's protected data or controls." : null;
    }
    // These built-ins name a file or a search root in `path`. Missing search roots mean the working directory.
    if (name !== "view" && name !== "edit" && name !== "create" && name !== "grep" && name !== "glob") return null;
    const value = args.path ?? ((name === "grep" || name === "glob") ? input.workingDirectory || o.workspace : undefined);
    if (typeof value !== "string" || !value) return "The file or search path could not be checked.";
    const absolute = path.resolve(input.workingDirectory || o.workspace, value);
    try {
      const resolved = await physical(absolute);
      for (const protectedPath of o.ember.paths) {
        const root = path.resolve(protectedPath);
        const realRoot = await physical(root);
        if (inside(absolute, root, o.os) || inside(resolved, realRoot, o.os) ||
            ((name === "grep" || name === "glob") && (inside(root, absolute, o.os) || inside(realRoot, resolved, o.os)))) {
          return "This path reaches Ember's protected data.";
        }
      }
    } catch { return "The file or search path could not be checked."; }
    return null;
  };
}
