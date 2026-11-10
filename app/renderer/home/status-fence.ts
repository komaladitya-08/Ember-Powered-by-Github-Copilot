/**
 * Home's ordering contract between the startup snapshot (IPC.getStatus) and the pushes that carry the same state
 * (IPC.settingsChanged, IPC.settingsNotice). A snapshot answers a request made at some moment and can arrive after a
 * push that is newer than it (main awaits the environment checks first); the page's own copy of a field is the
 * authority once a push has set it, so a late snapshot must not put the older value back. Pure: no DOM, no IPC.
 */
import type { Status } from "../../shared/ipc";

type Settings = Status["settings"];

/** What had been pushed when a snapshot was requested. */
export interface StatusTicket { settings: number; notice: number }

export class StatusFence {
  private settingsSeq = 0;
  private noticeSeq = 0;
  private latestSettings: Settings | null = null;
  private latestNotice: string | null = null;

  /** Call as the request leaves, before any await. */
  begin(): StatusTicket { return { settings: this.settingsSeq, notice: this.noticeSeq }; }
  /** A settings push arrived (every push, in the order it arrived). */
  pushedSettings(s: Settings): void { this.settingsSeq++; this.latestSettings = s; }
  /** A settings-notice push arrived. */
  pushedNotice(notice: string | null): void { this.noticeSeq++; this.latestNotice = notice; }
  /**
   * The snapshot, with each field a push has set since its request replaced by the pushed value. A snapshot with
   * no push in between is returned as it is (the normal first load), and one that failed never reaches here, so it
   * cannot blank anything.
   */
  apply(ticket: StatusTicket, status: Status): Status {
    const settings = ticket.settings !== this.settingsSeq && this.latestSettings ? this.latestSettings : status.settings;
    const settingsNotice = ticket.notice !== this.noticeSeq ? this.latestNotice : status.settingsNotice;
    return settings === status.settings && settingsNotice === status.settingsNotice ? status : { ...status, settings, settingsNotice };
  }
}

/** The one fence every startup status consumer in Home goes through (main.ts and project.ts share it). */
export const statusFence = new StatusFence();

/** How many times Home asks again after the first status failed, and the pause before attempt n (n × this). */
export const STATUS_RETRIES = 4;
export const STATUS_RETRY_MS = 1000;
