import { contextBridge, ipcRenderer } from "electron";
import { VOICE, type MicApi, type SpeakRequest, type SpeechAudio, type SpeechPlayed } from "../shared/voice";

// The audio port goes straight to the page's main world (MessagePorts can't cross contextBridge).
ipcRenderer.on(VOICE.port, e => { window.postMessage("ember-voice-port", "*", e.ports); });

const api: MicApi = {
  status: s => ipcRenderer.send(VOICE.status, s),
  speaking: (on, generation) => ipcRenderer.send(VOICE.speaking, on, generation),
  speech: ok => ipcRenderer.send(VOICE.speech, ok),
  onSpeak: fn => { ipcRenderer.on(VOICE.speak, (_e, r: SpeakRequest) => fn(r)); },
  onHush: fn => { ipcRenderer.on(VOICE.hush, (_e, generation: unknown) => { if (typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0) fn(generation); }); },
  onAudio: fn => { ipcRenderer.on(VOICE.audio, (_e, a: SpeechAudio) => fn(a)); },
  onAudioDone: fn => { ipcRenderer.on(VOICE.audioDone, (_e, id: number) => fn(id)); },
  played: (p: SpeechPlayed) => ipcRenderer.send(VOICE.played, p),
  level: l => ipcRenderer.send(VOICE.level, l),
  onLevelOn: fn => { ipcRenderer.on(VOICE.levelOn, (_e, on: boolean) => fn(on === true)); },
};

contextBridge.exposeInMainWorld("emberMic", api);
