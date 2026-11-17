/** One owned local test-only pipe. It has no renderer, product IPC, arbitrary action or network authority. */
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

const refusal = () => new Error("The synthetic Electron control could not be verified.");
export interface NativeCommandsControl {
  readonly address: string;
  readonly nonce: string;
  readonly listening: Promise<void>;
  readonly authenticated: Promise<void>;
  bindChild(pid: number | undefined): void;
  broken(): boolean;
  sample(sequence: number): void;
  sampledSequence(): number;
  quit(): Promise<void>;
  close(): Promise<void>;
}

/** The caller captures this owner before awaiting listening or launching its single child. */
export function createNativeCommandsControl(directory: string): NativeCommandsControl {
  const stat = fs.lstatSync(directory);
  if (!path.isAbsolute(directory) || !stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(directory) !== directory) throw refusal();
  const name = randomBytes(16).toString("hex"), nonce = randomBytes(32).toString("hex");
  const address = process.platform === "win32" ? "\\\\.\\pipe\\ember-native-commands-" + name : path.join(directory, "c-" + name + ".sock");
  if (process.platform !== "win32" && Buffer.byteLength(address) > 100) throw refusal();
  let broken = false, accepted = false, authenticated = false, quitting = false, acknowledged = false, closing = false;
  let expectedPid = 0, socket: net.Socket | undefined, socketClosed = false, serverClosed = false;
  let requestedSample = 0, sampledSequence = 0;
  let authResolve!: () => void, authReject!: (error: Error) => void, byeResolve!: () => void, byeReject!: (error: Error) => void;
  const auth = new Promise<void>((resolve, reject) => { authResolve = resolve; authReject = reject; });
  const bye = new Promise<void>((resolve, reject) => { byeResolve = resolve; byeReject = reject; });
  void auth.catch(() => undefined); void bye.catch(() => undefined);
  let serverDone!: () => void, socketDone!: () => void;
  const serverClose = new Promise<void>(resolve => { serverDone = resolve; });
  const socketClose = new Promise<void>(resolve => { socketDone = resolve; });
  const fail = () => { broken = true; authReject(refusal()); byeReject(refusal()); };
  const server = net.createServer(incoming => {
    if (accepted || closing) { fail(); incoming.on("error", () => undefined); incoming.destroy(); return; }
    accepted = true; socket = incoming;
    // One connection only. close's event waits for this owned socket to close too.
    server.close();
    let buffer = "", total = 0;
    incoming.on("error", () => { fail(); incoming.destroy(); });
    incoming.on("end", () => { if (buffer || !quitting || !acknowledged) fail(); });
    incoming.on("close", hadError => {
      socketClosed = true; socketDone();
      if (hadError || !quitting || !acknowledged) fail();
    });
    incoming.on("data", (chunk: Buffer) => {
      if (broken) return;
      if (!Buffer.isBuffer(chunk) || (total += chunk.length) > 2048 || [...chunk].some(byte => byte !== 10 && (byte < 32 || byte > 126))) { fail(); incoming.destroy(); return; }
      buffer += chunk.toString("ascii");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.length > 128) { fail(); incoming.destroy(); return; }
        if (!authenticated && expectedPid > 0 && line === "HELLO " + nonce + " " + expectedPid) {
          authenticated = true;
          incoming.write("OK " + nonce + "\n", error => { if (error) { fail(); incoming.destroy(); } else authResolve(); });
        } else if (authenticated && !quitting && requestedSample > sampledSequence && line === "SAMPLED " + nonce + " " + expectedPid + " " + requestedSample) {
          sampledSequence = requestedSample;
        } else if (authenticated && quitting && !acknowledged && line === "BYE " + nonce + " " + expectedPid) {
          acknowledged = true; byeResolve();
        } else { fail(); incoming.destroy(); return; }
      }
      if (buffer.length > 128) { fail(); incoming.destroy(); }
    });
  });
  server.on("close", () => { serverClosed = true; serverDone(); });
  let listenResolve!: () => void, listenReject!: (error: Error) => void;
  const listening = new Promise<void>((resolve, reject) => { listenResolve = resolve; listenReject = reject; });
  void listening.catch(() => undefined);
  server.on("error", () => {
    fail(); listenReject(refusal());
    if (!server.listening) { serverClosed = true; serverDone(); }
  });
  server.once("listening", () => { listenResolve(); if (closing) server.close(); });
  try { server.listen(address); } catch { fail(); listenReject(refusal()); serverClosed = true; serverDone(); }
  return {
    address, nonce, listening, authenticated: auth,
    bindChild(pid) {
      if (broken || expectedPid || authenticated || closing || !Number.isSafeInteger(pid) || !pid || pid <= 0) { fail(); return; }
      expectedPid = pid;
    },
    broken: () => broken,
    sample(sequence) {
      if (broken || !authenticated || !socket || socketClosed || quitting || closing || requestedSample !== sampledSequence ||
          !Number.isInteger(sequence) || sequence !== requestedSample + 1 || sequence > 16) { fail(); return; }
      requestedSample = sequence;
      socket.write("SAMPLE " + nonce + " " + sequence + "\n", error => { if (error) { fail(); socket?.destroy(); } });
    },
    sampledSequence: () => sampledSequence,
    quit() {
      if (broken || !authenticated || !socket || socketClosed || quitting || closing || requestedSample !== sampledSequence) { fail(); return Promise.reject(refusal()); }
      quitting = true;
      socket.write("QUIT " + nonce + "\n", error => { if (error) { fail(); socket?.destroy(); } });
      return bye;
    },
    async close() {
      closing = true;
      if (!quitting || !acknowledged) fail();
      if (socket && !socketClosed && broken) socket.destroy();
      if (!accepted) { socketClosed = true; socketDone(); if (server.listening) server.close(); }
      await Promise.all([serverClose, socketClose]);
      if (broken || !quitting || !acknowledged || !socketClosed || !serverClosed) throw refusal();
    },
  };
}
