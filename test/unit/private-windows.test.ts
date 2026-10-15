import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Perception } from "../../app/main/perception";
import type { AtspiSidecar } from "../../app/main/perception/sidecar";
import type { X11 } from "../../app/main/x11";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const win = (title: string, wmClass: string, x = 0) => ({ id: 1, pid: 1, title, wmClass, x, y: 0, width: 100, height: 50 });

function make(opts: { x11?: X11 | null; atspi?: () => Promise<{ windows: { app: string; name: string; bounds: { x: number; y: number; width: number; height: number } | null; pid: number | null; role: string; active: boolean }[] }> }) {
  const sidecar = { listWindows: opts.atspi ?? (async () => ({ windows: [] })) } as unknown as AtspiSidecar;
  return new Perception({ sidecar, x11: opts.x11 ?? null, neverLook: () => ["keepassxc"], screenBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), log: quiet });
}

describe("private windows", () => {
  it("masks never-look windows found by X11 even when accessibility doesn't list them", async () => {
    const x11 = { clientWindows: () => [win("Passwords.kdbx - KeePassXC", "keepassxc KeePassXC", 300), win("notes.txt", "gedit")] } as unknown as X11;
    const masks = await make({ x11 }).privateWindows();
    expect(masks).toEqual([{ x: 300, y: 0, width: 100, height: 50 }]);
  });

  it("adds what accessibility finds", async () => {
    const x11 = { clientWindows: () => [] } as unknown as X11;
    const masks = await make({ x11, atspi: async () => ({ windows: [{ app: "KeePassXC", name: "vault", bounds: { x: 5, y: 6, width: 7, height: 8 }, pid: 1, role: "frame", active: false }] }) }).privateWindows();
    expect(masks).toEqual([{ x: 5, y: 6, width: 7, height: 8 }]);
  });

  it("fails closed when neither source can list windows", async () => {
    const masks = await make({ x11: null, atspi: async () => { throw new Error("bus down"); } }).privateWindows();
    expect(masks).toBeNull();
  });
});

// The sidecar's window choice, with a stand-in pyatspi (runs without a desktop).
const python = ["python3", "/usr/libexec/platform-python"].find(p => spawnSync(p, ["-c", "1"]).status === 0);
describe.skipIf(!python)("sidecar find_window", () => {
  const run = (params: object) => {
    const script = `
import sys, types, json
fake = types.ModuleType("pyatspi")
fake.DESKTOP_COORDS = 0
fake.stateToString = lambda s: s
sys.modules["pyatspi"] = fake
sys.path.insert(0, ${JSON.stringify(path.resolve("sidecar/atspi"))})
import ember_atspi as e
class W:
    def __init__(self, name, states): self.name = name; self._s = states
class App: name = "app"
wins = [(App(), 10, W("Inbox - Mail", ["showing"])), (App(), 10, W("Compose - Mail", ["showing", "active"])), (App(), 20, W("notes.txt - Text Editor", ["showing"]))]
e.frames = lambda: iter(wins)
e.state_names = lambda w: w._s
found = e.find_window(json.loads(sys.argv[1]))
print(found[2].name if found else "none")
`;
    const r = spawnSync(python!, ["-c", script, JSON.stringify(params)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };

  it("prefers the active window among a process's windows", () => {
    expect(run({ pid: 10 })).toBe("Compose - Mail");
  });
  it("matches title and pid together", () => {
    expect(run({ pid: 10, title: "Inbox - Mail" })).toBe("Inbox - Mail");
    expect(run({ title: "notes" })).toBe("notes.txt - Text Editor");
  });
  it("finds nothing for an unknown process", () => {
    expect(run({ pid: 99 })).toBe("none");
  });
});

// Reading a window: deeply nested content (gedit 3.28 on RHEL 8 puts its text view 15 levels down).
describe.skipIf(!python)("sidecar walk", () => {
  it("reaches content nested deep under containers", () => {
    const script = `
import sys, types, json
fake = types.ModuleType("pyatspi")
fake.DESKTOP_COORDS = 0
fake.stateToString = lambda s: s
sys.modules["pyatspi"] = fake
sys.path.insert(0, ${JSON.stringify(path.resolve("sidecar/atspi"))})
import ember_atspi as e
class N:
    def __init__(self, role, name="", kids=()): self.role = role; self.name = name; self.kids = list(kids)
    def getRoleName(self): return self.role
    @property
    def childCount(self): return len(self.kids)
    def getChildAtIndex(self, i): return self.kids[i]
node = N("text", "")
for role in ["scroll pane", "filler", "panel", "panel", "filler", "page tab", "page tab list", "panel", "panel", "filler", "panel", "filler", "panel", "filler"]:
    node = N(role, "", [node])
root = N("frame", "notes.txt (/tmp) - gedit", [node])
e.state_names = lambda a: ["showing", "visible", "editable", "focused"]
e.extents = lambda a: {"x": 0, "y": 0, "width": 900, "height": 600}
e.actions = lambda a: []
e.text_of = lambda a, limit=200: "Standup notes" if a.role == "text" else None
e.selection_of = lambda a: None
e.value_of = lambda a: None
e.is_editable = lambda a, s: a.role == "text"
out = []
e.walk(root, 0, out, e.MAX_DEPTH, e.MAX_NODES, None)
print(json.dumps([[n["depth"], n["role"]] for n in out if n["role"] == "text"]))
`;
    const r = spawnSync(python!, ["-c", script], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    expect(JSON.parse(r.stdout)).toEqual([[15, "text"]]);
  });
});
