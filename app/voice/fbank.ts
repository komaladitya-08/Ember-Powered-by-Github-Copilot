/**
 * Kaldi's log mel filterbank, as sherpa-onnx computes it for speaker models: 25 ms frames every 10 ms, centred
 * (edges not snipped: the first frame is reflected at the start), DC removed, pre-emphasis 0.97, a Povey window, a
 * 512-point power spectrum, and 80 triangular bins on Kaldi's mel scale from 20 Hz to 7.6 kHz, logged with a floor at
 * FLT_EPSILON. No dither: the same audio gives the same features. Matches kaldi-native-fbank with those options (to
 * 1e-4); the speaker model's embeddings match sherpa-onnx's own to a cosine of 0.98.
 */

const RATE = 16_000;
const FRAME = 400;
const SHIFT = 160;
const FFT = 512;
const PREEMPH = 0.97;
const EPS = 1.1920928955078125e-7;

const mel = (hz: number) => 1127 * Math.log(1 + hz / 700);

/** For each bin: the first FFT bin it covers and its weights from there. */
function melBanks(bins: number, low = 20, high = RATE / 2 - 400): { first: number; weights: Float32Array }[] {
  const lo = mel(low), hi = mel(high), delta = (hi - lo) / (bins + 1), fftBins = FFT / 2;
  const out: { first: number; weights: Float32Array }[] = [];
  for (let b = 0; b < bins; b++) {
    const left = lo + b * delta, centre = left + delta, right = centre + delta;
    let first = -1, last = -1;
    const w = new Float32Array(fftBins);
    for (let i = 0; i < fftBins; i++) {
      const m = mel((RATE * i) / FFT);
      if (m > left && m < right) {
        w[i] = m <= centre ? (m - left) / (centre - left) : (right - m) / (right - centre);
        if (first < 0) first = i;
        last = i;
      }
    }
    out.push({ first, weights: w.slice(first, last + 1) });
  }
  return out;
}

const POVEY = Float32Array.from({ length: FRAME }, (_, i) => Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)), 0.85));
const BANKS = new Map<number, ReturnType<typeof melBanks>>();
const COS = Float64Array.from({ length: FFT / 2 }, (_, i) => Math.cos((-2 * Math.PI * i) / FFT));
const SIN = Float64Array.from({ length: FFT / 2 }, (_, i) => Math.sin((-2 * Math.PI * i) / FFT));
const REV = Uint16Array.from({ length: FFT }, (_, i) => { let r = 0; for (let b = 0, x = i; b < 9; b++, x >>= 1) r = (r << 1) | (x & 1); return r; });

/** In-place radix-2 FFT of a 512-point real signal (`re`, with `im` zeroed). */
function fft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < FFT; i++) { const j = REV[i]; if (j > i) { const t = re[i]; re[i] = re[j]; re[j] = t; } }
  for (let size = 2; size <= FFT; size <<= 1) {
    const half = size >> 1, step = FFT / size;
    for (let start = 0; start < FFT; start += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step], s = SIN[k * step], a = start + k, b = a + half;
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** Log mel filterbank features of 16 kHz `samples`, one row of `bins` per 10 ms frame. */
export function fbank(samples: Float32Array, bins = 80): Float32Array[] {
  const n = samples.length;
  const frames = Math.floor((n + SHIFT / 2) / SHIFT);
  // Sample `i` of the signal, reflected at its ends (Kaldi's snip_edges = false).
  const at = (i: number) => samples[i < 0 ? -i - 1 : i >= n ? 2 * n - 1 - i : i] ?? 0;
  let banks = BANKS.get(bins);
  if (!banks) { banks = melBanks(bins); BANKS.set(bins, banks); }
  const re = new Float64Array(FFT), im = new Float64Array(FFT), power = new Float64Array(FFT / 2 + 1);
  const out: Float32Array[] = [];
  for (let f = 0; f < frames; f++) {
    const start = f * SHIFT + SHIFT / 2 - FRAME / 2;
    for (let i = 0; i < FRAME; i++) re[i] = at(start + i);
    let mean = 0;
    for (let i = 0; i < FRAME; i++) mean += re[i];
    mean /= FRAME;
    for (let i = 0; i < FRAME; i++) re[i] -= mean;
    for (let i = FRAME - 1; i > 0; i--) re[i] -= PREEMPH * re[i - 1];
    re[0] -= PREEMPH * re[0];
    for (let i = 0; i < FRAME; i++) re[i] *= POVEY[i];
    re.fill(0, FRAME);
    im.fill(0);
    fft(re, im);
    for (let i = 0; i <= FFT / 2; i++) power[i] = re[i] * re[i] + im[i] * im[i];
    const row = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      const { first, weights } = banks[b];
      let e = 0;
      for (let i = 0; i < weights.length; i++) e += weights[i] * power[first + i];
      row[b] = Math.log(Math.max(e, EPS));
    }
    out.push(row);
  }
  return out;
}
