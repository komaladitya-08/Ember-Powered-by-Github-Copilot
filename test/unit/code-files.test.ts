/**
 * The Files tab's model (app/renderer/code/files-model.ts) and how it hands files to the composer (attach-event.ts):
 * which files the window knows of and from where, the tree the keyboard walks, the filter, the viewer's text, and that
 * an attachment's path is only ever built from a listed one inside the session's folder.
 */
import { describe, expect, it } from "vitest";
import type { CodeSdkEvent } from "../../app/shared/code";
import { attachmentsOf } from "../../app/renderer/code/attach-event";
import {
  VIEW_LINES, binaryByName, buildTree, completionPaths, diffFiles, fileView, filterTree, joinPath, looksBinary, mergeFiles, relativeTo, rootId,
  seenFiles, treeKey, typeAhead, visibleRows, workspaceFiles, type KnownFile,
} from "../../app/renderer/code/files-model";
import { EMPTY_TRANSCRIPT, reduceEvent, type Transcript } from "../../app/renderer/code/transcript";

let n = 0;
const ev = (type: string, data: unknown): CodeSdkEvent => ({ id: `f${++n}`, timestamp: "2026-11-27T10:00:00Z", type, data });
const play = (...events: CodeSdkEvent[]): Transcript => events.reduce(reduceEvent, EMPTY_TRANSCRIPT);
const names = { folder: "app", session: "Copilot's session files" } as const;

describe("the files the Files tab knows of", () => {
  it("reads workspaces.diff's changes, leaving out a file outside the folder (../ or absolute)", () => {
    const files = diffFiles({ changes: [
      { path: "src/a.ts", changeType: "modified", diff: "" },
      { path: "img/b.png", changeType: "added", diff: "", contents: { after: "x" }, isTruncated: true },
      { path: "../outside.txt", changeType: "modified", diff: "" },
      { path: "/etc/passwd", changeType: "modified", diff: "" },
      { path: "C:\\x.txt", changeType: "modified", diff: "" },
      { path: "c.txt", changeType: "strange", diff: "" },
    ] });
    expect(files).toEqual([
      { path: "src/a.ts", change: "modified", cut: false },
      { path: "img/b.png", change: "added", after: "x", cut: true },
      { path: "c.txt", change: "modified", cut: false },
    ]);
    expect(diffFiles(null)).toEqual([]);
  });

  it("reads workspaces.listFiles' relative paths only", () => {
    expect(workspaceFiles({ files: ["plan.md", "./notes/a.txt", "../x", 3, "/abs"] })).toEqual(["plan.md", "notes/a.txt"]);
  });

  it("takes the working folder's files the session's tools named or edited, inside the folder only", () => {
    const t = play(
      ev("tool.execution_start", { toolCallId: "v", toolName: "view", arguments: { path: "/w/app/src/a.ts" } }),
      ev("tool.execution_start", { toolCallId: "o", toolName: "view", arguments: { path: "/w/other/x.ts" } }),
      ev("tool.execution_start", { toolCallId: "e", toolName: "edit", arguments: { path: "/w/app/src/b.ts" } }),
      ev("tool.execution_complete", { toolCallId: "e", success: true, fileEdits: [{ path: "/w/app/src/b.ts", kind: "edit" }, { path: "/w/app/../evil", kind: "edit" }] }),
    );
    expect(seenFiles(t, "/w/app")).toEqual([{ root: "folder", path: "src/a.ts" }, { root: "folder", path: "src/b.ts", change: "edited" }]);
  });

  it("knows when the session's own workspace files change (session.workspace_file_changed)", () => {
    const t = play(ev("session.workspace_file_changed", { operation: "create", path: "plan.md" }));
    expect(t.workspaceFiles).toEqual({ "plan.md": "create" });
  });

  it("tells whether a path is in a folder, case-blind only for a Windows folder", () => {
    expect(relativeTo("/w/app", "/w/app/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo("/w/app", "/w/application/a.ts")).toBeNull();
    expect(relativeTo("/w/app", "/W/APP/a.ts")).toBeNull();
    expect(relativeTo("C:\\Users\\me\\app", "c:\\users\\me\\app\\src\\a.ts")).toBe("src/a.ts");
    expect(relativeTo("/w/app", "/w/app/../x")).toBeNull();
    expect(joinPath("/w/app/", "src/a.ts")).toBe("/w/app/src/a.ts");
    expect(joinPath("C:\\me\\app", "src/a.ts")).toBe("C:\\me\\app\\src\\a.ts");
  });

  it("keeps the strongest mark of a file named twice: the diff's, then a tool's edit, then none", () => {
    const f = mergeFiles([{ root: "folder", path: "a" }], [{ root: "folder", path: "a", change: "edited" }], [{ root: "folder", path: "a", change: "added" }], [{ root: "folder", path: "a", change: "edited" }]);
    expect(f).toEqual([{ root: "folder", path: "a", change: "added" }]);
  });

  it("reads completions.request's file paths, never a folder, an absolute path or one going up", () => {
    expect(completionPaths({ items: [
      { insertText: "@src/a.ts", label: "src/a.ts", kind: "document" },
      { insertText: "@src/", label: "src/", kind: "directory" },
      { insertText: "@/etc/hosts", kind: "document" },
      { insertText: "@../x", kind: "document" },
      { insertText: "@main", kind: "branch" },
    ] })).toEqual([{ path: "src/a.ts", dir: false }, { path: "src", dir: true }]);
  });
});

describe("the tree the keyboard walks", () => {
  const files: KnownFile[] = [
    { root: "folder", path: "src/b.ts" }, { root: "folder", path: "src/a.ts", change: "modified" }, { root: "folder", path: "README.md" },
    { root: "session", path: "plan.md" },
  ];
  const tree = buildTree(files, names);
  const open = new Set([rootId("folder"), rootId("session")]);

  it("lists folders before files, each by name, and marks a folder that holds a change", () => {
    expect(tree.map(r => r.name)).toEqual(["app", "Copilot's session files"]);
    expect(tree[0].children.map(c => `${c.name}${c.dir ? "/" : ""}`)).toEqual(["src/", "README.md"]);
    expect(tree[0].children[0].change).toBe("edited");
    expect(tree[0].children[0].children.map(c => [c.name, c.change])).toEqual([["a.ts", "modified"], ["b.ts", undefined]]);
  });

  it("draws only what is open, with each row's level and place for screen readers", () => {
    const rows = visibleRows(tree, open);
    expect(rows.map(r => [r.node.name, r.level, r.posInSet, r.setSize])).toEqual([
      ["app", 1, 1, 2], ["src", 2, 1, 2], ["README.md", 2, 2, 2], ["Copilot's session files", 1, 2, 2], ["plan.md", 2, 1, 1],
    ]);
    expect(rows[1].expanded).toBe(false);
  });

  it("moves by the tree pattern's keys: down, up, Home, End, right opens then enters, left closes then goes up", () => {
    let o = new Set(open);
    let rows = visibleRows(tree, o);
    const src = rows[1].node.id;
    expect(treeKey(rows, rootId("folder"), "ArrowDown")).toEqual({ focus: src });
    expect(treeKey(rows, src, "ArrowRight")).toEqual({ focus: src, toggle: { id: src, open: true } });
    o = new Set([...o, src]);
    rows = visibleRows(tree, o);
    expect(treeKey(rows, src, "ArrowRight")).toEqual({ focus: "folder:src/a.ts" });
    expect(treeKey(rows, "folder:src/a.ts", "ArrowLeft")).toEqual({ focus: src });
    expect(treeKey(rows, src, "ArrowLeft")).toEqual({ focus: src, toggle: { id: src, open: false } });
    expect(treeKey(rows, src, "Home")).toEqual({ focus: rootId("folder") });
    expect(treeKey(rows, src, "End")).toEqual({ focus: "session:plan.md" });
    expect(treeKey(rows, "folder:src/a.ts", "ArrowRight")).toBeNull();
    expect(typeAhead(rows, rootId("folder"), "r")).toBe("folder:README.md");
  });

  it("filters to the files whose path holds the words, opening the folders on the way and keeping both roots", () => {
    const f = filterTree(tree, "A.TS");
    expect(f.tree[0].children[0].children.map(c => c.name)).toEqual(["a.ts"]);
    expect(f.tree[1].children).toEqual([]);
    expect(f.open.has("folder:src/")).toBe(true);
    expect(filterTree(tree, "  ").tree).toEqual(tree);
  });
});

describe("the viewer", () => {
  it("shows text as lines, bounded, and says when only the start is shown", () => {
    expect(fileView("a.ts", "one\r\ntwo\n")).toEqual({ kind: "text", lines: ["one", "two"], cut: false });
    const long = Array.from({ length: VIEW_LINES + 5 }, (_x, i) => `l${i}`).join("\n");
    const v = fileView("a.txt", long);
    expect(v.kind === "text" && v.lines.length).toBe(VIEW_LINES);
    expect(v.kind === "text" && v.cut).toBe(true);
    expect(fileView("a.txt", "")).toEqual({ kind: "empty" });
  });

  it("names a binary file and never shows it: by its name, a NUL, or mostly control characters", () => {
    expect(binaryByName("x/logo.PNG")).toBe(true);
    expect(binaryByName("x/logo.ts")).toBe(false);
    expect(fileView("data.txt", "ab\u0000cd")).toEqual({ kind: "binary" });
    expect(fileView("img.png", "text")).toEqual({ kind: "binary" });
    expect(looksBinary("\u0001\u0002\u0003abc")).toBe(true);
    expect(looksBinary("tabs\tand\nlines\r\n")).toBe(false);
  });
});

describe("attaching a file from the panel", () => {
  it("takes file attachments for the composer's own session only, with nothing but a type, a path and a name", () => {
    const detail = { sessionId: "s1", attachments: [{ type: "file", path: "/w/app/a.ts", displayName: "a.ts", extra: 1 }, { type: "directory", path: "/w" }, { type: "file", path: "" }, "x"] };
    expect(attachmentsOf(detail, "s1")).toEqual([{ type: "file", path: "/w/app/a.ts", displayName: "a.ts" }]);
    expect(attachmentsOf(detail, "s2")).toBeNull();
    expect(attachmentsOf(null, "s1")).toBeNull();
  });
});
