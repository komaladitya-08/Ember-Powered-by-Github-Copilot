/**
 * What Ember keeps of the extensions the user installed: `extensions.json` (0600) in `<userData>/extensions/` (0700),
 * beside each plugin's copied files (`plugins/<id>/`) and the run folder of revocable per-launch lease files.
 * Written whole and atomically; a file that doesn't read is moved aside (`.broken`), never overwritten in place.
 * Plain Node.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const Hints = z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(), openWorldHint: z.boolean().optional(), idempotentHint: z.boolean().optional() });
const Tool = z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown(), annotations: Hints, hash: z.string().regex(/^[0-9a-f]{64}$/), changed: z.boolean().optional() });
const Spec = z.union([
  z.object({ type: z.literal("stdio"), command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()) }),
  z.object({ type: z.enum(["http", "sse"]), url: z.string(), headers: z.record(z.string(), z.string()) }),
]);
const Server = z.object({
  /** The server's name in the model's tool names (`<key>-<tool>`): letters and digits only, unique across items. */
  key: z.string().regex(/^[a-z0-9]{1,24}$/),
  name: z.string(),
  spec: Spec.nullable(),
  status: z.enum(["ready", "needs-auth", "failed"]),
  detail: z.string().optional(),
  tools: z.array(Tool),
  /** Latest discovered tools shown for agreement; never usable until that exact list is agreed. */
  reviewTools: z.array(Tool).optional(),
});
const Item = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/),
  kind: z.literal("plugin"),
  name: z.string(),
  publisher: z.string().optional(),
  marketplace: z.string(),
  source: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean(),
  /** When the user agreed (install or reagree), ISO time; null: not agreed. */
  consentedAt: z.string().nullable(),
  servers: z.array(Server),
});
const File = z.object({ version: z.literal(1), items: z.array(Item) });

export type StoredItem = z.infer<typeof Item>;
export type StoredServer = z.infer<typeof Server>;

export class ExtensionStore {
  constructor(readonly dir: string) {}

  get file(): string { return path.join(this.dir, "extensions.json"); }
  get pluginsDir(): string { return path.join(this.dir, "plugins"); }
  get runDir(): string { return path.join(this.dir, "run"); }
  pluginDir(id: string): string { return path.join(this.pluginsDir, id); }

  /** Creates the folders (0700). */
  ensure(): void {
    for (const d of [this.dir, this.pluginsDir, this.runDir]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(d, 0o700); } catch { /* Windows keeps its own ACLs */ }
    }
  }

  read(): StoredItem[] {
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); } catch { return []; }
    try {
      return File.parse(JSON.parse(raw)).items;
    } catch {
      try { fs.renameSync(this.file, `${this.file}.broken`); } catch { /* left where it is: write() will replace it */ }
      return [];
    }
  }

  write(items: StoredItem[]): void {
    this.ensure();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/** Copy limits: a plugin bigger than this isn't installed. */
export const COPY_LIMITS = { files: 20_000, bytes: 300 * 1024 * 1024 };

/**
 * Copies the plugin folder `src` into `dst` (made 0700): regular files and folders only (no links, which could reach
 * outside it), without `.git`. Throws when it is bigger than COPY_LIMITS. Ember runs its own copy, so a marketplace
 * that changes later can't change what the user agreed to.
 */
export function copyPlugin(src: string, dst: string, limits = COPY_LIMITS, within?: string): void {
  // The plugin's own folder may not be a link either (it could point anywhere), and it must really lie inside its
  // marketplace's folder.
  if (fs.lstatSync(src).isSymbolicLink() || !fs.statSync(src).isDirectory()) throw new Error("not a folder");
  if (within) {
    const real = fs.realpathSync(src), root = fs.realpathSync(within);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error("outside its marketplace");
  }
  let files = 0, bytes = 0;
  const walk = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const a = path.join(from, e.name), b = path.join(to, e.name);
      if (e.isDirectory()) walk(a, b);
      else if (e.isFile()) {
        const st = fs.statSync(a);
        if (++files > limits.files || (bytes += st.size) > limits.bytes) throw new Error("too big");
        fs.copyFileSync(a, b);
        // Keep a program runnable as it was (servers are often scripts with a shebang); nothing becomes executable that wasn't.
        fs.chmodSync(b, st.mode & 0o700);
      }
    }
  };
  walk(src, dst);
}
