import { contextBridge, ipcRenderer } from "electron";
import { VOICE, type MicApi, type SpeakRequest, type SpeechAudio } from "../shared/voice";

// The audio port goes straight to the page's main world (MessagePorts can't cross contextBridge).
ipcRenderer.on(VOICE.port, e => { window.postMessage("ember-voice-port", "*", e.ports); });

const api: MicApi = {
  status: s => ipcRenderer.send(VOICE.status, s),
  speaking: on => ipcRenderer.send(VOICE.speaking, on),
  speech: ok => ipcRenderer.send(VOICE.speech, ok),
  onSpeak: fn => { ipcRenderer.on(VOICE.speak, (_e, r: SpeakRequest) => fn(r)); },
  onHush: fn => { ipcRenderer.on(VOICE.hush, () => fn()); },
  onAudio: fn => { ipcRenderer.on(VOICE.audio, (_e, a: SpeechAudio) => fn(a)); },
  onAudioDone: fn => { ipcRenderer.on(VOICE.audioDone, (_e, id: number) => fn(id)); },
};

contextBridge.exposeInMainWorld("emberMic", api);
