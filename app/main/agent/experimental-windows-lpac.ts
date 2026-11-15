/**
 * Disposable native-fixture LPAC launcher. This is not a Copilot/runtime boundary and never opens the coding gate.
 * No credentials, source-project ACL changes, inherited handles, network capabilities or compatibility grants.
 * A stop lease witnesses only processes contained in this job; escaped service/broker processes remain unproven.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ExperimentalWindowsCreateUncertain, loadExperimentalWindowsLpacApi, type WindowsHandle, type WindowsLpacApi, type WindowsLpacProfile, type WindowsSuspendedProcess } from "./experimental-windows-lpac-api";

export interface WindowsFixturePaths { root: string; tools: string; work: string; state: string; program: string }
let uncertainExperiment = false;
const leaseIssuer = Symbol("experimental Windows stop observation");
const SID = /^S-\d+(?:-\d+)+$/;
/** Protected ACLs are applied only when creating brand-new scratch objects, never to a supplied existing tree. */
export function experimentalWindowsSddl(owner: string, packageSid: string, access: "read" | "modify", directory: boolean): string {
  if (!SID.test(owner) || !SID.test(packageSid) || !packageSid.startsWith("S-1-15-2-")) throw new Error("Invalid fixture security identity.");
  const inherit = directory ? "OICI" : "";
  return `D:P(A;${inherit};FA;;;${owner})(A;${inherit};FA;;;SY)(A;${inherit};${access === "read" ? "0x1200a9" : "0x1301bf"};;;${packageSid})S:(ML;${inherit};NW;;;LW)`;
}

/** Fixed clean environment; it never copies the host's environment or accepts arbitrary credential variable names. */
export function experimentalWindowsEnvironment(paths: WindowsFixturePaths, windows: string): Buffer {
  const values = { SystemRoot: windows, WINDIR: windows, PATH: paths.tools, TEMP: paths.state, TMP: paths.state,
    EMBER_LPAC_WORK: paths.work, EMBER_LPAC_STATE: paths.state, EMBER_LPAC_TOOLS: paths.tools };
  for (const value of Object.values(values)) if (!/^[A-Za-z]:\\/.test(value) || /[\0\r\n]/.test(value)) throw new Error("The fixture environment requires ordinary absolute Windows paths.");
  return Buffer.from(Object.entries(values).sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase(), "en")).map(([key, value]) => `${key}=${value}\0`).join("") + "\0", "utf16le");
}

function commandLine(program: string, args: readonly string[]): Buffer {
  const quote = (value: string) => `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
  const text = [program, ...args].map(quote).join(" ");
  if (text.length >= 32767 || /\0/.test(text)) throw new Error("Invalid native fixture arguments.");
  return Buffer.from(text + "\0", "utf16le");
}

/** A receipt is minted only by observing the root handle and both job counters after all contained writers exit. */
export class ExperimentalWindowsStopLease {
  private constructor(issuer: symbol, private readonly check: () => void) { if (issuer !== leaseIssuer) throw new Error("Invalid stop lease issuer."); }
  static observe(issuer: symbol, api: WindowsLpacApi, job: WindowsHandle, process: WindowsHandle, available: () => boolean): ExperimentalWindowsStopLease {
    if (issuer !== leaseIssuer) throw new Error("Invalid stop lease issuer.");
    const check = () => {
      if (!available() || !api.exited(process)) throw new Error("The fixture root process has not stopped.");
      const state = api.jobState(job);
      if (state.active !== 0 || state.listed !== 0) throw new Error("Fixture descendants have not stopped.");
    };
    check();
    return new ExperimentalWindowsStopLease(issuer, check);
  }
  requireStopped(): void { this.check(); }
}

/** One host-owned session; failed observation blocks further launch and never releases a result lease. */
export class ExperimentalWindowsLpacFixture {
  private process: WindowsSuspendedProcess | null = null;
  private job: WindowsHandle | null = null;
  private closed = false;
  private uncertain = false;
  private launched = false;
  private threadOpen = false;
  private launching: Promise<number> | null = null;
  private stopping: Promise<ExperimentalWindowsStopLease> | null = null;
  private closing: Promise<void> | null = null;
  private constructor(private readonly api: WindowsLpacApi, private readonly profile: WindowsLpacProfile, readonly paths: WindowsFixturePaths, private readonly directories: WindowsHandle[]) {}

  /**
   * Fixture assets are supplied as host-selected bytes and created with CREATE_NEW and their final protected ACL.
   * This deliberately does not implement recursive project capture, arbitrary toolchain grants or result traversal.
   */
  static prepare(parent: string, executable: Buffer, api: WindowsLpacApi = loadExperimentalWindowsLpacApi()): ExperimentalWindowsLpacFixture {
    if (uncertainExperiment) throw new Error("An earlier fixture shutdown is unverified. New LPAC experiments are blocked in this host process.");
    if (!Buffer.isBuffer(executable) || executable.length < 2 || executable.length > 16 * 1024 * 1024 || executable.toString("ascii", 0, 2) !== "MZ") throw new Error("Supply a small native fixture executable, not a project path.");
    const selected = parent.replace(/\//g, "\\");
    if (!/^[A-Za-z]:\\/.test(selected) || /[\0\r\n]/.test(selected)) throw new Error("The fixture needs a local Windows scratch parent.");
    const parts = selected.slice(path.win32.parse(selected).root.length).split("\\").filter(Boolean);
    if (parts.some(part => part === "." || part === ".." || /[. :<>"|?*]$|[:<>"|?*]/.test(part))) throw new Error("The fixture parent contains an unsupported path component.");
    const directories: WindowsHandle[] = [];
    let profile: WindowsLpacProfile | null = null;
    try {
      // Pin every ancestor without FILE_SHARE_DELETE, and reject reparse objects before creating package-granted data.
      const parsed = path.win32.parse(selected);
      if (api.volumeFileSystem(parsed.root).toUpperCase() !== "NTFS") throw new Error("The fixture experiment requires local NTFS.");
      let ancestor = parsed.root;
      directories.push(api.pinDirectory(ancestor));
      for (const component of parts) {
        ancestor = path.win32.join(ancestor, component);
        directories.push(api.pinDirectory(ancestor));
      }
      // Resolve case/8.3 names only after the original ancestry is pinned and each original component passed checks.
      const base = fs.realpathSync.native(selected);
      if (!/^[A-Za-z]:\\/.test(base) || path.win32.parse(base).root.toLowerCase() !== parsed.root.toLowerCase()) throw new Error("The fixture parent identity changed.");
      profile = api.createProfile(`Ember.Experimental.${randomUUID()}`);
      const root = path.win32.join(base, `ember-lpac-${randomUUID()}`);
      const paths = { root, tools: path.win32.join(root, "tools"), work: path.win32.join(root, "work"), state: path.win32.join(root, "state"), program: path.win32.join(root, "tools", "fixture.exe") };
      const owner = api.ownerSid(), read = experimentalWindowsSddl(owner, profile.sidText, "read", true), modify = experimentalWindowsSddl(owner, profile.sidText, "modify", true);
      for (const [directory, security] of [[paths.root, read], [paths.tools, read], [paths.work, modify], [paths.state, modify]]) {
        api.createDirectory(directory, security);
        directories.push(api.pinDirectory(directory));
      }
      api.writeNewFile(paths.program, executable, experimentalWindowsSddl(owner, profile.sidText, "read", false));
      return new ExperimentalWindowsLpacFixture(api, profile, paths, directories);
    } catch (err) {
      for (const directory of directories.reverse()) { try { api.close(directory); } catch { /* Preserve the setup error. */ } }
      if (profile) { try { api.deleteProfile(profile); } catch { /* A failed profile cleanup remains an explicit experimental limitation. */ } }
      // Never recursively remove a path after a failed identity/setup check. The caller can inspect disposable scratch.
      throw err;
    }
  }

  launch(args: readonly string[] = []): Promise<number> {
    if (this.launched) return Promise.reject(new Error("This fixture cannot launch again."));
    this.launching = this.launchOnce(args);
    return this.launching;
  }

  private async launchOnce(args: readonly string[]): Promise<number> {
    if (this.closed || this.uncertain || this.launched) throw new Error("This fixture cannot launch again.");
    this.launched = true;
    try {
      this.job = this.api.createJob();
      this.process = this.api.createSuspended(this.profile, this.paths.program, commandLine(this.paths.program, args), this.paths.work,
        experimentalWindowsEnvironment(this.paths, this.api.windowsDirectory()));
      this.threadOpen = true;
      this.api.assign(this.job, this.process.process);
      this.api.verifyToken(this.profile, this.process.process);
      this.api.resume(this.process.thread);
      this.api.close(this.process.thread);
      this.threadOpen = false;
      return this.process.pid;
    } catch (err) {
      if (err instanceof ExperimentalWindowsCreateUncertain) { this.uncertain = true; uncertainExperiment = true; throw err; }
      // Even a failed assignment leaves a suspended process. Kill it explicitly; never resume on any setup failure.
      try {
        if (this.process) this.api.terminateProcess(this.process.process);
        if (this.job) this.api.terminateJob(this.job);
        if (this.process && this.job) await this.waitStopped(3000);
        this.disposeStopped();
      } catch {
        this.uncertain = true; uncertainExperiment = true;
        throw new Error("LPAC setup failed and its process shutdown could not be verified. Keep its scratch data for diagnosis.");
      }
      throw err;
    }
  }

  private observe(): ExperimentalWindowsStopLease {
    if (!this.process || !this.job || this.closed || this.uncertain) throw new Error("No verified fixture stop lease is available.");
    return ExperimentalWindowsStopLease.observe(leaseIssuer, this.api, this.job, this.process.process, () => !this.closed && !this.uncertain);
  }

  /** Root-handle observation alone is diagnostic; it never authorises reading results while descendants remain. */
  async waitRootExited(timeoutMs = 3000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error("Invalid fixture root-exit deadline.");
    if (this.launching) await this.launching;
    const until = performance.now() + timeoutMs;
    for (;;) {
      if (this.closed || this.uncertain || !this.process) throw new Error("The fixture root process cannot be observed.");
      if (this.api.exited(this.process.process)) return;
      if (performance.now() >= until) throw new Error("The fixture root process has not exited.");
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }

  async waitStopped(timeoutMs = 3000): Promise<ExperimentalWindowsStopLease> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error("Invalid fixture stop deadline.");
    const until = performance.now() + timeoutMs;
    for (;;) {
      try { return this.observe(); }
      catch (err) {
        if (this.closed || this.uncertain || !this.process || !this.job || performance.now() >= until) throw err;
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
    }
  }

  stop(timeoutMs = 3000): Promise<ExperimentalWindowsStopLease> {
    if (this.stopping) return this.stopping;
    if (!this.launching && !this.process) return Promise.reject(new Error("No fixture job has been launched."));
    this.stopping = this.stopOnce(timeoutMs);
    return this.stopping;
  }

  private async stopOnce(timeoutMs: number): Promise<ExperimentalWindowsStopLease> {
    if (this.launching) await this.launching;
    if (!this.job || !this.process || this.closed || this.uncertain) throw new Error("No fixture job can be stopped safely.");
    try {
      this.api.terminateJob(this.job);
      return await this.waitStopped(timeoutMs);
    } catch (err) { this.uncertain = true; uncertainExperiment = true; throw err; }
  }

  exitCode(): number {
    this.observe();
    return this.api.exitCode(this.process!.process);
  }

  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    if (this.launching) await this.launching.catch(() => undefined);
    if (this.closed) return;
    if (this.process) {
      if (this.uncertain) throw new Error("Fixture shutdown is unverified. Keep the scratch directory and profile for diagnosis.");
      const lease = await this.stop();
      lease.requireStopped();
    }
    this.disposeStopped();
  }

  private disposeStopped(): void {
    // Invalidate leases before closing handles; cleanup failure must not leave a usable receipt or hide other leaks.
    this.closed = true;
    const errors: unknown[] = [];
    const attempt = (action: () => void) => { try { action(); } catch (err) { errors.push(err); } };
    if (this.process && this.threadOpen) { attempt(() => this.api.close(this.process!.thread)); this.threadOpen = false; }
    if (this.process) attempt(() => this.api.close(this.process!.process));
    if (this.job) attempt(() => this.api.close(this.job!));
    for (const directory of this.directories.slice().reverse()) attempt(() => this.api.close(directory));
    attempt(() => this.api.deleteProfile(this.profile));
    if (errors.length) { this.uncertain = true; uncertainExperiment = true; throw errors[0]; }
  }
}
