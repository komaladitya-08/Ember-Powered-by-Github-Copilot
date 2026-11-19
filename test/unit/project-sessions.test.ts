import { describe, expect, it } from "vitest";
import { MAX_PROJECT_SESSIONS, ProjectSessionBook } from "../../app/main/agent/project-sessions";

const make = (book: ProjectSessionBook, name: string) => book.apply({ action: "create", name, goal: `Finish ${name}` }).selectedProjectId!;
const task = (id: string, status = "running") => ({ id, title: `Task ${id}`, status, started: 10, detail: "Working in the browser" });

describe("this run's project sessions", () => {
  it("groups sessions by captured project and never lets a later selection retarget them", () => {
    const book = new ProjectSessionBook(() => 20);
    const first = make(book, "Release"), captured = book.destination();
    const second = make(book, "Research");
    book.attach(captured, task("browser"), "desktop", "Check the release notes");
    expect(book.state().selectedProjectId).toBe(second);
    expect(book.state().projects[0].sessions[0]).toMatchObject({ taskId: "browser", title: "Check the release notes", kind: "desktop", status: "running", startedAt: 10 });
    expect(book.state().projects[1].sessions).toEqual([]);
    expect(book.destination(first)).toBe(first);
    expect(book.destination(null)).toBeNull();
  });

  it("records observed failures, waiting, stops and terminal outcomes after recent task history expires", () => {
    let now = 20;
    const book = new ProjectSessionBook(() => now), id = make(book, "Release");
    book.attach(id, task("one"), "desktop");
    book.refresh([{ id: "one", status: "waiting", detail: "Waiting for you" }]);
    expect(book.state().projects[0].sessions[0]).toMatchObject({ status: "waiting", detail: "Waiting for you" });
    expect(() => book.apply({ action: "forget", id })).toThrow("Stop or finish");
    now = 30;
    book.refresh([{ id: "one", status: "failed", summary: "The service did not answer." }]);
    now = 40;
    book.refresh([]);
    expect(book.state().projects[0].sessions[0]).toMatchObject({ status: "failed", summary: "The service did not answer.", finishedAt: 30, detail: "" });
    book.apply({ action: "forget", id });
    expect(book.state()).toEqual({ selectedProjectId: null, projects: [] });
    expect(() => book.destination(id)).toThrow("no longer available");
  });

  it("bounds retained sessions without dropping unfinished work or recording one task twice", () => {
    const book = new ProjectSessionBook(), id = make(book, "Release");
    book.attach(id, task("live"), "desktop");
    book.attach(id, task("live"), "desktop");
    for (let i = 0; i < MAX_PROJECT_SESSIONS; i++) book.attach(id, task(`done-${i}`, "done"), "desktop");
    const sessions = book.state().projects[0].sessions;
    expect(sessions).toHaveLength(MAX_PROJECT_SESSIONS);
    expect(sessions[0].taskId).toBe("live");
    expect(sessions.some(s => s.taskId === "done-0")).toBe(false);
    const busy = new ProjectSessionBook(), full = make(busy, "Busy");
    for (let i = 0; i < MAX_PROJECT_SESSIONS; i++) busy.attach(full, task(String(i)), "desktop");
    expect(() => busy.destination(full)).toThrow("too many sessions");
    expect(() => busy.attach(full, task("extra"), "desktop")).toThrow("too many sessions");
  });

  it("validates metadata and returns independent snapshots with no executable folder or permission fields", () => {
    const book = new ProjectSessionBook(), id = make(book, "Release");
    expect(() => make(book, "release")).toThrow("already exists");
    expect(() => make(book, "bad\nname")).toThrow("Check the project name");
    expect(() => book.apply({ action: "create", name: "Other", folder: "/etc" })).toThrow("Check the project name");
    expect(() => book.apply({ action: "select", id: "../fake" })).toThrow("Check the project name");
    const state = book.state();
    state.projects[0].name = "Mutated";
    expect(book.state().projects[0].name).toBe("Release");
    book.attach(id, task("one"), "desktop");
    book.clear();
    expect(book.state()).toEqual({ projects: [], selectedProjectId: null });
    expect(new ProjectSessionBook().state().projects).toEqual([]);
  });
});

it("opens checkpoints only as inert validated history, preserving current live work", () => {
  const saved = new ProjectSessionBook(), id = make(saved, "Release");
  saved.attach(id, task("earlier", "done"), "desktop");
  const snapshot = saved.state();
  const current = new ProjectSessionBook(), liveId = make(current, "Live");
  current.attach(liveId, task("current"), "desktop");
  expect(() => current.restore(snapshot)).toThrow("Stop or finish");
  expect(current.state().projects[0].sessions[0].taskId).toBe("current");
  current.clear();
  expect(() => current.restore(snapshot)).toThrow("live task references");
  snapshot.projects[0].sessions[0].taskId = "";
  expect(current.restore(snapshot)).toEqual(snapshot);
  snapshot.projects[0].goal = "Changed";
  expect(current.state().projects[0].goal).toBe("Finish Release");
  const bad = current.state();
  bad.projects[0].sessions[0].status = "running";
  expect(() => current.restore(bad)).toThrow("live task references");
  bad.projects[0].sessions[0].status = "done";
  bad.projects[0].sessions.push({ ...bad.projects[0].sessions[0] });
  expect(() => current.restore(bad)).toThrow("invalid");
  expect(() => current.restore({ ...snapshot, selectedProjectId: "not-an-id" })).toThrow("invalid");
});


it("keeps newer unsaved metadata when a checkpoint opens after a slow keyring read", () => {
  const book = new ProjectSessionBook();
  make(book, "Original");
  const before = book.state();
  const saved = { projects: [], selectedProjectId: null };
  make(book, "Created while opening");
  expect(() => book.restore(saved, before)).toThrow("Projects changed while opening");
  expect(book.state().projects.map(p => p.name)).toEqual(["Original", "Created while opening"]);
  const retry = book.state();
  expect(book.restore(saved, retry)).toEqual(saved);
});
