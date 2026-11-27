/**
 * The Files tab's words, as pure functions: sentence case, British spelling, curly quotes round names, and plain
 * sentences in place of anything the SDK said. Pinned in test/unit/code-files-copy.test.ts.
 */
import type { FileChange } from "./files-model";

export const FILES_TREE_LABEL = "Files";
export const FILTER_LABEL = "Filter files";
export const FILTER_PLACEHOLDER = "Filter";
export const SESSION_FILES = "Copilot's session files";
export const ATTACH_FILE = "Attach to message";
export const REFRESH_FILES = "Refresh";
export const VIEWER_LABEL = "File contents";
export const LOADING_FILES = "Reading the session's files…";
export const READING_FILE = "Opening…";
export const FILES_LIST_FAILED = "The session's files couldn't be listed. Try again.";

/** What the tab says about what it can list, under the tree. */
export const FOLDER_SCOPE = "The working folder shows the files this session changed or opened. Copilot's own files are listed whole.";

/** The working folder's root, by its name. */
export const folderRoot = (name: string): string => name || "Working folder";

/** Nothing in a root, or nothing matching the filter. */
export function rootEmpty(root: "folder" | "session", query: string): string {
  if (query.trim()) return `Nothing here matches “${query.trim()}”.`;
  return root === "folder" ? "No files from this folder yet." : "Copilot hasn't kept any files for this session.";
}

/** A change's words beside a file (its mark is a symbol; these are what a screen reader hears). */
export function changeWords(change: FileChange | undefined): string {
  switch (change) {
    case "added": return "Added";
    case "modified": return "Changed";
    case "deleted": return "Deleted";
    case "renamed": return "Renamed";
    case "edited": return "Changed by Copilot";
    default: return "";
  }
}
/** A folder that holds changed files. */
export const FOLDER_CHANGED = "Has changes";

/** A tree row's name for screen readers: its name, and its change. */
export function rowLabel(name: string, change: FileChange | undefined, dir: boolean): string {
  const c = dir ? (change ? FOLDER_CHANGED : "") : changeWords(change);
  return c ? `${name}, ${c.charAt(0).toLocaleLowerCase()}${c.slice(1)}` : name;
}

/** The viewer's heading line about a file. */
export function fileFacts(lines: number, cut: boolean, size?: number): string {
  const parts = [`${lines.toLocaleString("en-GB")} ${lines === 1 ? "line" : "lines"}`];
  if (size !== undefined) parts.push(sizeWords(size));
  return cut ? `${parts.join(", ")}. Only the start is shown.` : `${parts.join(", ")}.`;
}

/** A size in bytes as people say it. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const BINARY_FILE = "This file isn't text, so it isn't shown.";
export const EMPTY_FILE = "This file is empty.";
export const TOO_BIG = (size: number): string => `This file is ${sizeWords(size)}, too large to show here.`;
export const DELETED_FILE = "Copilot deleted this file in this session.";
export const CANT_READ = "This file couldn't be read. Try again.";
/** A working-folder file the SDK gives no text for (only the files the session changed have theirs). */
export const NOT_READABLE = "Ember can show a working-folder file only once this session has changed it. You can still attach it to a message.";
export const NO_SELECTION = "Choose a file to see it here.";
export const SESSION_NOT_ATTACHABLE = "Only files in the session's folder can be attached to a message.";

/** Said once a file was added to the message. */
export const attached = (name: string): string => `“${name}” will go with your next message.`;
/** An Attach button's full name. */
export const attachLabel = (name: string): string => `Attach “${name}” to the message`;
