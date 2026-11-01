/**
 * The system voice Ember speaks with when its own voice isn't there (not downloaded yet, or failed): the most natural
 * one installed for the language. Windows 11's natural voices, macOS's Premium and Enhanced (Siri-like) voices and
 * neural voices rank first; only voices that run on this computer are used (an online voice would send Ember's
 * words elsewhere). Pure: the mic page gives it speechSynthesis.getVoices().
 */

export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

/** How natural a voice is likely to sound, by its name (higher is better). */
function quality(name: string): number {
  if (/\b(natural|neural)\b/i.test(name)) return 4;
  if (/\(premium\)|\bpremium\b/i.test(name)) return 3;
  if (/\(enhanced\)|\benhanced\b/i.test(name)) return 2;
  // espeak's voices are the robotic ones: anything else first.
  if (/espeak|\bmbrola\b/i.test(name)) return -1;
  return 0;
}

export function bestVoice<V extends VoiceInfo>(voices: readonly V[], lang: string): V | null {
  const want = lang.replace("_", "-").toLowerCase(), base = want.split("-")[0];
  const local = voices.filter(v => v.localService);
  const same = local.filter(v => v.lang.replace("_", "-").toLowerCase().split("-")[0] === base);
  if (!same.length) return null;
  const score = (v: V) => quality(v.name) * 10 + (v.lang.replace("_", "-").toLowerCase() === want ? 2 : 0) + (v.default ? 1 : 0);
  return same.reduce((best, v) => (score(v) > score(best) ? v : best));
}
