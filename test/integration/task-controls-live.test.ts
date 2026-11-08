/** Production Home task renderer connected to the real TaskManager through sender-checked IPC. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { _electron } from "playwright-core";
import { expect, it } from "vitest";
import type { TaskEntry } from "../../app/shared/activity";

interface LifecycleFixture {
  reads: number; controls: number;
  push(rows: TaskEntry[]): void; forget(): void; ready(): void;
  resolveRead(index: number, rows: TaskEntry[]): void;
  rejectRead(index: number): void;
  resolveControl(index: number, accepted: boolean): void;
}

it.skipIf(process.env.EMBER_TASK_CONTROLS_TEST !== "1")("stops one of two tasks, focuses its result, and disables expired retry", async () => {
  const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-task-controls-"));
  const requireCjs = createRequire(import.meta.url);
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const main = path.join(dir, "main.cjs"), preload = path.join(dir, "preload.cjs"), renderer = path.join(dir, "renderer.js");
    await build({ stdin: { contents: 'import {startTasks} from "./app/renderer/home/tasks"; startTasks();', resolveDir: root, loader: "ts" }, outfile: renderer, bundle: true, platform: "browser" });
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('ember',{tasks:()=>ipcRenderer.invoke('tasks:activity'),onTasks:fn=>{ipcRenderer.on('tasks:activity-changed',(_,v)=>fn(v));return()=>{}},taskControl:(id,action)=>ipcRenderer.invoke('tasks:control',{id,action})});`);
    fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><body><h1>Task activity</h1><p id="tasks-asking" hidden></p><div id="task-filter"></div><div id="tasks"></div><p id="tasks-live" role="status"></p><script src="renderer.js"></script></body></html>');
    const source = `
      import {app,BrowserWindow,ipcMain} from 'electron';
      import {TaskManager} from './app/main/agent/tasks';
      import {taskControl} from './app/main/agent/task-controls';
      const log={info(){},debug(){},warn(){},error(){},child(){return this}},stopped=[];
      app.whenReady().then(()=>{
        const win=new BrowserWindow({width:800,height:800,webPreferences:{contextIsolation:true,sandbox:true,preload:${JSON.stringify(preload)}}});
        const tm=new TaskManager({log,currentWindow:()=>null,deleteSession:async()=>{},setCards(){win.webContents.send('tasks:activity-changed',tm.activities())},
          makeWorker:spec=>({sessionId:null,dispose:async()=>{},steer:async()=>false,run:signal=>spec.goal==='Result'?Promise.resolve({success:false,summary:'The exact result.'}):new Promise(resolve=>signal.addEventListener('abort',()=>{stopped.push(spec.goal);resolve({success:false,stopped:true,summary:'Stopped.'})}))})});
        const host={tasks:tm,retryTask:id=>!!tm.retry(id)};
        ipcMain.handle('tasks:activity',e=>e.sender===win.webContents?tm.activities():[]);
        ipcMain.handle('tasks:control',(e,raw)=>e.sender===win.webContents&&taskControl(host,raw));
        const a=tm.start('One'),b=tm.start('Two'),result=tm.start('Result');
        globalThis.__tasks={stopped,ids:{a:a.id,b:b.id,result:result.id},expire(){tm.dismiss(result.id);win.webContents.send('tasks:activity-changed',tm.activities())}};
        win.loadFile(${JSON.stringify(path.join(dir, "index.html"))});
      });`;
    await build({ stdin: { contents: source, resolveDir: root, loader: "ts" }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
    app = await _electron.launch({ executablePath: requireCjs("electron") as string, args: [main, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])] });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Stop task: One", exact: true }).click();
    await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { __tasks: { stopped: string[] } }).__tasks.stopped)).toEqual(["One"]);
    expect(await page.getByRole("button", { name: "Stop task: Two", exact: true }).isEnabled()).toBe(true);
    const resultId = await app.evaluate(() => (globalThis as unknown as { __tasks: { ids: { result: string } } }).__tasks.ids.result);
    const result = page.locator(`[aria-labelledby="task-${resultId}-t"]`);
    await result.locator("summary").first().click();
    const retry = result.getByRole("button", { name: "Try again: Result", exact: true });
    expect(await retry.isEnabled()).toBe(true);
    await result.getByRole("button", { name: "View result: Result", exact: true }).click();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Result: Result");
    await app.evaluate(() => (globalThis as unknown as { __tasks: { expire(): void } }).__tasks.expire());
    await expect.poll(() => result.getByRole("button", { name: "Try again: Result", exact: true }).isDisabled()).toBe(true);
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 90_000);

it.skipIf(process.env.EMBER_TASK_CONTROLS_TEST !== "1")("offers Try again in Home for a task whose question went unanswered, and it starts a new attempt (tasks-approvals-c1-2)", async () => {
  const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-task-expired-"));
  const requireCjs = createRequire(import.meta.url);
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const main = path.join(dir, "main.cjs"), preload = path.join(dir, "preload.cjs"), renderer = path.join(dir, "renderer.js");
    await build({ stdin: { contents: 'import {startTasks} from "./app/renderer/home/tasks"; startTasks();', resolveDir: root, loader: "ts" }, outfile: renderer, bundle: true, platform: "browser" });
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('ember',{tasks:()=>ipcRenderer.invoke('tasks:activity'),onTasks:fn=>{ipcRenderer.on('tasks:activity-changed',(_,v)=>fn(v));return()=>{}},taskControl:(id,action)=>ipcRenderer.invoke('tasks:control',{id,action})});`);
    fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><body><h1>Task activity</h1><p id="tasks-asking" hidden></p><div id="task-filter"></div><div id="tasks"></div><p id="tasks-live" role="status"></p><script src="renderer.js"></script></body></html>');
    const source = `
      import {app,BrowserWindow,ipcMain} from 'electron';
      import {TaskManager} from './app/main/agent/tasks';
      import {taskControl} from './app/main/agent/task-controls';
      const log={info(){},debug(){},warn(){},error(){},child(){return this}},runs=[];
      app.whenReady().then(()=>{
        const win=new BrowserWindow({width:800,height:800,webPreferences:{contextIsolation:true,sandbox:true,preload:${JSON.stringify(preload)}}});
        const tm=new TaskManager({log,currentWindow:()=>null,deleteSession:async()=>{},setCards(){win.webContents.send('tasks:activity-changed',tm.activities())},
          makeWorker:spec=>({sessionId:null,dispose:async()=>{},steer:async()=>false,run:()=>{runs.push(spec.userWords);return runs.length===1?Promise.resolve({success:false,stopped:true,expired:true,summary:'My question ran out of time with no answer, so I didn\\'t do it.'}):new Promise(()=>{})}})});
        const host={tasks:tm,retryTask:id=>!!tm.retry(id)};
        ipcMain.handle('tasks:activity',e=>e.sender===win.webContents?tm.activities():[]);
        ipcMain.handle('tasks:control',(e,raw)=>e.sender===win.webContents&&taskControl(host,raw));
        const t=tm.start('Send the report',{userWords:'send the report to Priya'});
        globalThis.__tasks={runs,id:t.id};
        win.loadFile(${JSON.stringify(path.join(dir, "index.html"))});
      });`;
    await build({ stdin: { contents: source, resolveDir: root, loader: "ts" }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
    app = await _electron.launch({ executablePath: requireCjs("electron") as string, args: [main, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])] });
    const page = await app.firstWindow();
    const id = await app.evaluate(() => (globalThis as unknown as { __tasks: { id: string } }).__tasks.id);
    const row = page.locator(`[aria-labelledby="task-${id}-t"]`);
    // Said for what it was, never "Stopped: Stopped".
    await expect.poll(() => page.locator(`#task-${id}-t`).textContent()).toBe("No answer in time: Send the report");
    expect(await row.locator(".task-meta").textContent()).toMatch(/^No answer in time · /);
    await row.locator("summary").first().click();
    expect(await row.locator(".timeline li").last().textContent()).toMatch(/No answer in time/);
    const retry = row.getByRole("button", { name: "Try again: Send the report", exact: true });
    expect(await retry.isEnabled()).toBe(true);
    await retry.click();
    // A new attempt, in the user's own words again: every question is asked again.
    await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { __tasks: { runs: string[] } }).__tasks.runs)).toEqual(["send the report to Priya", "send the report to Priya"]);
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 90_000);

it.skipIf(process.env.EMBER_TASK_CONTROLS_TEST !== "1")("keeps newer task views and retires old-account reads, actions and teardown pushes", async () => {
  const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-task-lifecycle-"));
  const requireCjs = createRequire(import.meta.url);
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  const task = (id: string, title: string, status: TaskEntry["status"] = "running"): TaskEntry => ({
    id, title, status, controls: { stop: status === "running", retry: status === "failed", window: false },
    activity: { startedAt: Date.now(), items: [], dropped: 0, steps: 0, failedSteps: 0, counts: {}, questions: 0, approvals: 0, asking: false, retry: 0, slow: false, nearLimit: false, live: "" },
  });
  const current = task("2-22222222", "Current task"), privateTask = { ...task("3-33333333", "PRIVATE old task"), summary: "PRIVATE old result" };
  try {
    const main = path.join(dir, "main.cjs"), preload = path.join(dir, "preload.cjs"), renderer = path.join(dir, "renderer.js");
    await build({ stdin: { contents: 'import {startTasks} from "./app/renderer/home/tasks"; startTasks();', resolveDir: root, loader: "ts" }, outfile: renderer, bundle: true, platform: "browser" });
    fs.writeFileSync(preload, `
      const {contextBridge,ipcRenderer}=require('electron'); let readDone=0,controlDone=0;
      const listen=(channel,fn)=>{const handler=(_,value)=>fn(value);ipcRenderer.on(channel,handler);return()=>ipcRenderer.removeListener(channel,handler)};
      contextBridge.exposeInMainWorld('ember',{
        tasks:()=>ipcRenderer.invoke('tasks:activity').then(value=>{readDone++;return value},error=>{readDone++;throw error}),
        onTasks:fn=>listen('tasks:changed',fn),onConversationForgotten:fn=>listen('conversation:forgotten',fn),onAgentStatus:fn=>listen('agent:status',fn),
        taskControl:(id,action)=>ipcRenderer.invoke('tasks:control',{id,action}).then(value=>{controlDone++;return value}),
      });
      contextBridge.exposeInMainWorld('taskFixture',{settled:()=>({reads:readDone,controls:controlDone})});
    `);
    fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><body><h2 id="tasks-h" tabindex="-1">Task activity</h2><label>Other control<input id="other"></label><p id="tasks-asking" hidden></p><div id="task-filter"></div><div id="tasks"></div><p id="tasks-live" role="status"></p><script src="renderer.js"></script></body></html>');
    const source = `
      import {app,BrowserWindow,ipcMain} from 'electron';
      app.whenReady().then(()=>{
        const win=new BrowserWindow({width:800,height:800,webPreferences:{contextIsolation:true,sandbox:true,preload:${JSON.stringify(preload)}}});
        const reads=[],controls=[];
        ipcMain.handle('tasks:activity',e=>e.sender===win.webContents?new Promise((resolve,reject)=>reads.push({resolve,reject})):[]);
        ipcMain.handle('tasks:control',(e,raw)=>e.sender===win.webContents?new Promise(resolve=>controls.push(resolve)):false);
        globalThis.__taskLifecycle={get reads(){return reads.length},get controls(){return controls.length},
          push:rows=>win.webContents.send('tasks:changed',rows),forget:()=>win.webContents.send('conversation:forgotten'),ready:()=>win.webContents.send('agent:status',{phase:'ready'}),
          resolveRead:(i,rows)=>reads[i].resolve(rows),rejectRead:i=>reads[i].reject(new Error('Test late read failure')),resolveControl:(i,accepted)=>controls[i](accepted)};
        win.loadFile(${JSON.stringify(path.join(dir, "index.html"))});
      });`;
    await build({ stdin: { contents: source, resolveDir: root, loader: "ts" }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
    app = await _electron.launch({ executablePath: requireCjs("electron") as string, args: [main, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])] });
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    const counts = () => app!.evaluate(() => { const h = (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle; return { reads: h.reads, controls: h.controls }; });
    const settled = () => page.evaluate(() => (window as unknown as { taskFixture: { settled(): { reads: number; controls: number } } }).taskFixture.settled());
    await expect.poll(counts).toEqual({ reads: 1, controls: 0 });
    await app.evaluate((_e, rows) => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.push(rows), [current]);
    await expect.poll(() => page.getByRole("button", { name: "Stop task: Current task", exact: true }).count()).toBe(1);
    await app.evaluate((_e, rows) => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.resolveRead(0, rows), [privateTask]);
    await expect.poll(settled).toEqual({ reads: 1, controls: 0 });
    expect(await page.locator("#tasks").innerText()).not.toContain("PRIVATE");

    await page.getByRole("button", { name: "Stop task: Current task", exact: true }).click();
    await expect.poll(counts).toEqual({ reads: 1, controls: 1 });
    await app.evaluate(() => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.resolveControl(0, true));
    await expect.poll(counts).toEqual({ reads: 2, controls: 1 });
    await app.evaluate((_e, rows) => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.push(rows), [{ ...current, status: "stopped" as const }]);
    await expect.poll(() => page.locator('.task-group[data-status="stopped"]').count()).toBe(1);
    await app.evaluate(() => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.rejectRead(1));
    await expect.poll(settled).toEqual({ reads: 2, controls: 1 });
    expect(await page.locator("#tasks").innerText()).not.toContain("PRIVATE");

    // A pending action may settle after erasure, but cannot request or repaint the next account's tasks.
    await app.evaluate((_e, rows) => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.push(rows), [privateTask]);
    await page.getByRole("button", { name: "Stop task: PRIVATE old task", exact: true }).click();
    await expect.poll(counts).toEqual({ reads: 2, controls: 2 });
    await app.evaluate(() => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.forget());
    await expect.poll(() => page.locator("#tasks").innerText()).not.toContain("PRIVATE");
    expect(await page.locator("#tasks-live").innerText()).toBe("");
    expect(await page.locator("#tasks-h").evaluate(e => document.activeElement === e)).toBe(true);
    await page.locator("#other").fill("Keep this focus");
    await app.evaluate(() => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.resolveControl(1, true));
    await expect.poll(settled).toEqual({ reads: 2, controls: 2 });
    expect(await counts()).toEqual({ reads: 2, controls: 2 });
    expect(await page.locator("#other").evaluate(e => document.activeElement === e)).toBe(true);

    // Teardown pushes are ignored until a fresh ready connection can supply its own task manager.
    await app.evaluate((_e, rows) => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.push(rows), [privateTask]);
    await app.evaluate(() => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.ready());
    await expect.poll(counts).toEqual({ reads: 3, controls: 2 });
    expect(await page.locator("#tasks").innerText()).not.toContain("PRIVATE");
    const next = task("4-44444444", "Next account task");
    await app.evaluate((_e, rows) => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.resolveRead(2, rows), [next]);
    await expect.poll(() => page.getByRole("button", { name: "Stop task: Next account task", exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: "Stop task: Next account task", exact: true }).click();
    await expect.poll(counts).toEqual({ reads: 3, controls: 3 });
    await app.evaluate(() => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.resolveControl(2, true));
    await expect.poll(counts).toEqual({ reads: 4, controls: 3 });
    await app.evaluate(() => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.forget());
    await page.locator("#other").focus();
    await app.evaluate((_e, rows) => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.resolveRead(3, rows), [privateTask]);
    await expect.poll(settled).toEqual({ reads: 4, controls: 3 });
    expect(await page.locator("#tasks").innerText()).not.toContain("PRIVATE");
    expect(await page.locator("#other").evaluate(e => document.activeElement === e)).toBe(true);
    // An initial read's late rejection must not run an unguarded empty fallback over a newer pushed view.
    await page.reload();
    await expect.poll(counts).toEqual({ reads: 5, controls: 3 });
    await app.evaluate((_e, rows) => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.push(rows), [current]);
    await expect.poll(() => page.getByRole("button", { name: "Stop task: Current task", exact: true }).count()).toBe(1);
    await app.evaluate(() => (globalThis as unknown as { __taskLifecycle: LifecycleFixture }).__taskLifecycle.rejectRead(4));
    await expect.poll(settled).toEqual({ reads: 1, controls: 0 });
    expect(await page.getByRole("button", { name: "Stop task: Current task", exact: true }).count()).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 90_000);
