/** Owned synthetic Electron transport only; closed observations never grant input or change a readiness decision. */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { types } from "node:util";
import {
  COMMANDS_RENDERER_LOAD_PREFIX, COMMANDS_RENDERER_READY_PREFIX, COMMANDS_RENDERER_SAMPLE_PREFIX, parseCommandsRendererSample,
  type CommandsRendererSample,
} from "./commands-renderer-native-contract";
import type { NativeCommandsControl } from "./native-commands-control";

export interface CommandsRendererStartup { appReady: number; appExit: number; appError: number; appStage: number; loadCode: number; quit: number }
export interface OwnedCommandsRenderer {
  process: ChildProcessByStdio<null, Readable, Readable>;
  control: NativeCommandsControl;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  ready: Promise<boolean>;
  startup(): Readonly<CommandsRendererStartup>;
  sample(): Readonly<CommandsRendererSample> | null;
  broken(): boolean;
}

/** One fixed launch, no retries. Capture both ownership and stdio-close observation before any asynchronous startup. */
export function startCommandsRenderer(executable: string, app: string, env: NodeJS.ProcessEnv, control: NativeCommandsControl): OwnedCommandsRenderer {
  const process = spawn(executable, [app], { env: { ...env, EMBER_COMMANDS_RENDERER_CONTROL: control.address, EMBER_COMMANDS_RENDERER_NONCE: control.nonce }, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => process.once("close", (code, signal) => resolve({ code, signal })));
  const startup: CommandsRendererStartup = { appReady: 0, appExit: 0, appError: 0, appStage: 0, loadCode: 0, quit: 0 };
  let last: Readonly<CommandsRendererSample> | null = null, invalid = false, out = "", outBytes = 0, err = "", errBytes = 0, errInvalid = false, loadSeen = false;
  let finishReady!: (value: boolean) => void, settled = false;
  const ready = new Promise<boolean>(resolve => { finishReady = value => { if (!settled) { settled = true; resolve(value); } }; });
  const bufferText = (chunk: Buffer): string | null => {
    if (types.isProxy(chunk) || !Buffer.isBuffer(chunk) || Object.getPrototypeOf(chunk) !== Buffer.prototype ||
        ["length", "byteLength", "byteOffset", "buffer", "toString", "utf8Slice"].some(name => Object.getOwnPropertyDescriptor(chunk, name))) return null;
    return Buffer.prototype.toString.call(chunk, "utf8");
  };
  const refuseStream = () => { invalid = true; out = ""; if (!settled) startup.appReady = 4; finishReady(false); };
  process.once("error", () => { startup.appError = 1; invalid = true; if (!settled) startup.appReady = 5; finishReady(false); });
  process.once("exit", (code, signal) => {
    startup.appExit = signal !== null && signal !== undefined ? 3 : code === 0 ? 1 : Number.isSafeInteger(code) ? 2 : 3;
    if (!settled) startup.appReady = 6;
    finishReady(false);
  });
  process.stdout.on("data", (chunk: Buffer) => { try {
    if (invalid) return;
    const text = bufferText(chunk);
    if (text === null || (outBytes += chunk.length) > 64 * 1024) { refuseStream(); return; }
    out += text;
    const lines = out.split("\n"); out = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith(COMMANDS_RENDERER_LOAD_PREFIX)) {
        const match = /^([0-7]):([0-4])$/.exec(line.slice(COMMANDS_RENDERER_LOAD_PREFIX.length));
        if (!match || loadSeen && (startup.loadCode !== Number(match[1]) || startup.quit !== Number(match[2]))) {
          startup.loadCode = 7; startup.quit = 0;
        } else { startup.loadCode = Number(match[1]); startup.quit = Number(match[2]); }
        loadSeen = true;
      } else if (line.startsWith(COMMANDS_RENDERER_READY_PREFIX)) {
        if (!settled) {
          startup.appReady = line === COMMANDS_RENDERER_READY_PREFIX + "1" ? 1 : line === COMMANDS_RENDERER_READY_PREFIX + "0" ? 2 : 3;
          finishReady(startup.appReady === 1);
        } else if (line !== COMMANDS_RENDERER_READY_PREFIX + "1") refuseStream();
      } else if (line.startsWith(COMMANDS_RENDERER_SAMPLE_PREFIX)) {
        const json = line.slice(COMMANDS_RENDERER_SAMPLE_PREFIX.length);
        if (json.length > 256) { refuseStream(); return; }
        const sample = parseCommandsRendererSample(JSON.parse(json));
        if (!sample || startup.appReady !== 1 || sample.sequence !== (last?.sequence ?? 0) + 1) { refuseStream(); return; }
        last = Object.freeze(sample);
      } else if (line.includes("EMBER_COMMANDS_RENDERER")) { refuseStream(); return; }
    }
    if (out.length > 512) refuseStream();
  } catch { refuseStream(); } });
  process.stderr.on("data", (chunk: Buffer) => { try {
    if (errInvalid) return;
    const text = bufferText(chunk);
    if (text === null || (errBytes += chunk.length) > 64 * 1024) { errInvalid = true; startup.appStage = 0; err = ""; return; }
    err += text;
    const lines = err.split("\n"); err = lines.pop() ?? "";
    for (const line of lines) if (line.includes("EMBER_COMMANDS_RENDERER_STARTUP")) {
      const match = /^EMBER_COMMANDS_RENDERER_STARTUP_V1:([1-9])\r?$/.exec(line);
      if (!match) { errInvalid = true; startup.appStage = 0; err = ""; return; }
      startup.appStage = Number(match[1]);
    }
    if (err.length > 512) { errInvalid = true; startup.appStage = 0; err = ""; }
  } catch { errInvalid = true; startup.appStage = 0; err = ""; } });
  control.bindChild(process.pid);
  return { process, control, closed, ready: ready.then(value => value ? control.authenticated.then(() => true, () => false) : false),
    startup: () => Object.freeze({ ...startup }), sample: () => last, broken: () => invalid || control.broken() };
}
