'use client';

import { SAMPLE_RATE } from '@/lib/gemini/wav';
import { SECTION_SPEC, type Play } from '@/lib/script/plan';
import type { Measurement, Section, TrackSettings } from '@/lib/types';

/**
 * Track assembly, in the browser.
 *
 * The original pipeline assembled with ffmpeg in a server process. That cannot be hosted:
 * serverless platforms have neither an ffmpeg binary nor a function budget that survives a
 * four-minute render. Doing it here also means the listener's script and finished audio
 * never touch a disk we control, which is what the local-first promise was always claiming.
 *
 * Equivalences and one honest downgrade, versus the ffmpeg chain:
 *   highpass 80 Hz              → BiquadFilter highpass, identical intent
 *   lowpass 10 kHz              → BiquadFilter lowpass, identical intent
 *   deesser                     → fixed high-shelf cut at 6.5 kHz. This is the downgrade:
 *                                 a shelf is static where a de-esser is dynamic. It removes
 *                                 the same sibilant band but also takes a little air out of
 *                                 everything else. At this level, into a dark room, that is
 *                                 the right trade — sibilance is what jolts people awake.
 *   loudnorm -23 LUFS           → BS.1770 gated measurement here + a single exact gain
 *   afade / volume taper        → sample-accurate gain curves applied directly
 */

export const ASSEMBLY_SAMPLE_RATE = SAMPLE_RATE;

/** Level of the noise bed relative to full scale, before normalisation. */
const BED_DEFAULT_DB = -34;
const FADE_SEC = 90;
const TAPER_START_SEC = 240;
const TAPER_DEPTH_DB = 6;
/** True-peak ceiling. Below the -3 dBTP requirement, not at it. */
const PEAK_CEILING_DB = -3.5;
/** Bed is generated once and looped. A full-length bed for an hour is 345 MB by itself. */
const BED_LOOP_SEC = 30;

/** Silence detection, matching the ffmpeg splitter's thresholds. */
const SILENCE_DB = -40;
const MIN_SILENCE_SEC = 0.35;
const EDGE_KEEP_SEC = 0.12;

export interface ChunkPcm {
  hashKey: string;
  /** Raw signed-16 LE mono 24 kHz, as delivered by /api/tts. */
  pcm: Int16Array;
  lineCount: number;
}

export interface AssembledTrack {
  samples: Float32Array;
  sampleRate: number;
  measurement: Measurement;
  splitFallbacks: number;
}

// ---------------------------------------------------------------------------
// Conversion and analysis
// ---------------------------------------------------------------------------

export function int16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/** RMS in dBFS over a whole buffer. */
export function rmsDb(x: Float32Array): number {
  if (x.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  const r = Math.sqrt(sum / x.length);
  return r === 0 ? -Infinity : 20 * Math.log10(r);
}

/**
 * Find the speech regions in a chunk, the same way the ffmpeg splitter did: anything
 * quieter than -40 dBFS for at least 350 ms is a gap, everything else is speech.
 */
export function findSpeechRegions(
  x: Float32Array,
  sampleRate = ASSEMBLY_SAMPLE_RATE,
): Array<{ start: number; end: number }> {
  const win = Math.round(sampleRate * 0.02); // 20 ms
  const threshold = 10 ** (SILENCE_DB / 20);
  const minSilenceWins = Math.ceil((MIN_SILENCE_SEC * sampleRate) / win);

  const loud: boolean[] = [];
  for (let i = 0; i < x.length; i += win) {
    let sum = 0;
    const end = Math.min(i + win, x.length);
    for (let j = i; j < end; j++) sum += x[j] * x[j];
    loud.push(Math.sqrt(sum / Math.max(1, end - i)) > threshold);
  }

  const regions: Array<{ start: number; end: number }> = [];
  let runStart: number | null = null;
  let quietRun = 0;

  for (let w = 0; w < loud.length; w++) {
    if (loud[w]) {
      if (runStart === null) runStart = w;
      quietRun = 0;
    } else if (runStart !== null) {
      quietRun++;
      if (quietRun >= minSilenceWins) {
        regions.push({ start: runStart * win, end: (w - quietRun + 1) * win });
        runStart = null;
        quietRun = 0;
      }
    }
  }
  if (runStart !== null) regions.push({ start: runStart * win, end: x.length });

  // Keep a little of the natural gap on each side so consonants are not clipped.
  const keep = Math.round(EDGE_KEEP_SEC * sampleRate);
  return regions.map((r) => ({
    start: Math.max(0, r.start - keep),
    end: Math.min(x.length, r.end + keep),
  }));
}

// ---------------------------------------------------------------------------
// ITU-R BS.1770 loudness
// ---------------------------------------------------------------------------

/** One biquad, direct form I. */
function biquad(x: Float32Array, b: number[], a: number[]): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/**
 * K-weighting filter coefficients for an arbitrary sample rate, derived by bilinear
 * transform of the BS.1770 reference filters (which are specified at 48 kHz). We run at
 * 24 kHz, so the published coefficients cannot be used directly.
 */
function kWeight(x: Float32Array, fs: number): Float32Array {
  // Stage 1: high-frequency shelving boost, ~+4 dB above 1.5 kHz.
  const db = 3.999843853973347;
  const f0 = 1681.974450955533;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (db / 20);
  const Vb = Vh ** 0.4996667741545416;
  const a0 = 1 + K / Q + K * K;
  const shelfB = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0];
  const shelfA = [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];

  // Stage 2: high-pass at ~38 Hz.
  const f0h = 38.13547087602444;
  const Qh = 0.5003270373238773;
  const Kh = Math.tan((Math.PI * f0h) / fs);
  const hpB = [1, -2, 1];
  const hpA = [
    1,
    (2 * (Kh * Kh - 1)) / (1 + Kh / Qh + Kh * Kh),
    (1 - Kh / Qh + Kh * Kh) / (1 + Kh / Qh + Kh * Kh),
  ];

  return biquad(biquad(x, shelfB, shelfA), hpB, hpA);
}

/**
 * Integrated loudness in LUFS, with BS.1770 absolute (-70 LUFS) and relative (-10 LU)
 * gating. Gating is not optional for this material: a track that is more than half silence
 * measures absurdly low without it.
 */
export function integratedLufs(x: Float32Array, fs = ASSEMBLY_SAMPLE_RATE): number {
  const weighted = kWeight(x, fs);
  const blockSec = 0.4;
  const stepSec = 0.1; // 75% overlap
  const block = Math.round(blockSec * fs);
  const step = Math.round(stepSec * fs);
  if (weighted.length < block) return -Infinity;

  const loudness: number[] = [];
  for (let i = 0; i + block <= weighted.length; i += step) {
    let sum = 0;
    for (let j = i; j < i + block; j++) sum += weighted[j] * weighted[j];
    const mean = sum / block;
    loudness.push(mean > 0 ? -0.691 + 10 * Math.log10(mean) : -Infinity);
  }

  const absGated = loudness.filter((l) => l > -70);
  if (absGated.length === 0) return -Infinity;

  const meanPower = (ls: number[]) =>
    ls.reduce((a, l) => a + 10 ** ((l + 0.691) / 10), 0) / ls.length;

  const relThreshold = -0.691 + 10 * Math.log10(meanPower(absGated)) - 10;
  const gated = absGated.filter((l) => l > relThreshold);
  if (gated.length === 0) return -Infinity;
  return -0.691 + 10 * Math.log10(meanPower(gated));
}

/**
 * True peak in dBTP, approximated by 4x linear oversampling. Real true-peak metering uses a
 * polyphase filter; 4x interpolation is close enough to catch inter-sample peaks at the
 * accuracy this needs, and errs low by a fraction of a dB — which is why the target has
 * margin.
 */
export function truePeakDb(x: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < x.length - 1; i++) {
    const a = x[i];
    const b = x[i + 1];
    peak = Math.max(peak, Math.abs(a));
    for (let k = 1; k < 4; k++) peak = Math.max(peak, Math.abs(a + ((b - a) * k) / 4));
  }
  if (x.length) peak = Math.max(peak, Math.abs(x[x.length - 1]));
  return peak === 0 ? -Infinity : 20 * Math.log10(peak);
}

/** Peak dBFS per window. The series the descent constraint is judged on. */
export function windowPeakDb(
  x: Float32Array,
  windowSec = 60,
  fs = ASSEMBLY_SAMPLE_RATE,
): number[] {
  const n = Math.round(windowSec * fs);
  const out: number[] = [];
  for (let i = 0; i < x.length; i += n) {
    let peak = 0;
    const end = Math.min(i + n, x.length);
    for (let j = i; j < end; j++) peak = Math.max(peak, Math.abs(x[j]));
    out.push(peak === 0 ? -Infinity : 20 * Math.log10(peak));
  }
  return out;
}

export function windowRmsDb(
  x: Float32Array,
  windowSec = 60,
  fs = ASSEMBLY_SAMPLE_RATE,
): number[] {
  const n = Math.round(windowSec * fs);
  const out: number[] = [];
  for (let i = 0; i < x.length; i += n) {
    const end = Math.min(i + n, x.length);
    let sum = 0;
    for (let j = i; j < end; j++) sum += x[j] * x[j];
    const r = Math.sqrt(sum / Math.max(1, end - i));
    out.push(r === 0 ? -Infinity : 20 * Math.log10(r));
  }
  return out;
}

export function isMonotonicAfter(series: number[], fromMinute = 4, toleranceDb = 0.5): boolean {
  for (let i = fromMinute + 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    if (cur > prev + toleranceDb) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Bed
// ---------------------------------------------------------------------------

/** Pink noise by the Voss-McCartney approximation, then band-shaped per bed type. */
function makeBed(kind: TrackSettings['bed'], samples: number): Float32Array {
  const out = new Float32Array(samples);
  const rows = 16;
  const state = new Float32Array(rows);
  let running = 0;
  let counter = 0;

  for (let i = 0; i < samples; i++) {
    counter++;
    let n = counter;
    let row = 0;
    while ((n & 1) === 0 && row < rows - 1) {
      n >>= 1;
      row++;
    }
    running -= state[row];
    state[row] = Math.random() * 2 - 1;
    running += state[row];
    out[i] = (running / rows) * 0.5;
  }

  if (kind === 'brown') {
    // Integrate once more for the steeper 1/f² slope.
    let last = 0;
    for (let i = 0; i < samples; i++) {
      last = (last + out[i] * 0.08) / 1.02;
      out[i] = last * 6;
    }
  } else if (kind === 'rain') {
    // Band-limit upward and add a very slow amplitude drift so it does not sit dead still.
    let prev = 0;
    for (let i = 0; i < samples; i++) {
      const hp = out[i] - prev;
      prev = out[i];
      const drift = 1 + 0.15 * Math.sin((2 * Math.PI * 0.15 * i) / ASSEMBLY_SAMPLE_RATE);
      out[i] = hp * drift * 1.6;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleArgs {
  plays: Play[];
  audio: Map<string, ChunkPcm>;
  settings: TrackSettings;
  onProgress?: (message: string) => void;
}

export async function assembleInBrowser(args: AssembleArgs): Promise<AssembledTrack> {
  const { plays, audio, settings } = args;
  const say = args.onProgress ?? (() => {});
  const fs = ASSEMBLY_SAMPLE_RATE;

  // ---- 1. split every unique chunk into its lines --------------------------------
  say('Finding the lines in each chunk…');
  const split = new Map<string, { segments: Float32Array[]; durations: number[] }>();
  const chunkRmsDb: number[] = [];
  const chunkWpm: number[] = [];
  let splitFallbacks = 0;

  for (const [key, chunk] of audio) {
    const float = int16ToFloat(chunk.pcm);
    chunkRmsDb.push(rmsDb(float));
    const regions = findSpeechRegions(float, fs);
    const fellBack = regions.length !== chunk.lineCount;
    if (fellBack) splitFallbacks++;
    const use = fellBack ? [{ start: 0, end: float.length }] : regions;
    split.set(key, {
      segments: use.map((r) => float.subarray(r.start, r.end)),
      durations: use.map((r) => (r.end - r.start) / fs),
    });
  }

  for (const play of plays) {
    const s = split.get(play.chunk.hashKey);
    const chunk = audio.get(play.chunk.hashKey);
    if (!s || !chunk) continue;
    const words = play.chunk.lines.reduce((a, l) => a + l.text.trim().split(/\s+/).length, 0);
    const sec = chunk.pcm.length / fs;
    if (sec > 0) chunkWpm.push((words / sec) * 60);
  }

  // ---- 2. re-time against measured speech -----------------------------------------
  // The plan sized pauses against an estimated speaking rate; now the audio exists and we
  // know the real one. Each section's pauses get one scale factor so the section lands on
  // its time budget. Without this the hour drifts by however much the model's pace differed.
  say('Re-timing against measured speech…');
  const scaleBySection = new Map<Section, number>();
  for (const spec of SECTION_SPEC.values()) {
    if (spec.section === 'fade') continue;
    const sectionPlays = plays.filter((p) => p.chunk.section === spec.section);
    if (!sectionPlays.length) continue;
    let speech = 0;
    let pause = 0;
    for (const p of sectionPlays) {
      speech += split.get(p.chunk.hashKey)?.durations.reduce((a, b) => a + b, 0) ?? 0;
      pause += p.pauses.reduce((a, b) => a + b, 0);
    }
    const budget = spec.share * settings.minutes * 60;
    scaleBySection.set(
      spec.section,
      pause > 0 ? Math.min(2.5, Math.max(0.4, (budget - speech) / pause)) : 1,
    );
  }

  // ---- 3. lay out the voice track --------------------------------------------------
  say('Laying out the hour…');
  const pieces: Array<{ data: Float32Array | null; samples: number }> = [];
  let totalSamples = 0;

  for (const play of plays) {
    const s = split.get(play.chunk.hashKey);
    if (!s || s.segments.length === 0) continue;
    const scale = scaleBySection.get(play.chunk.section) ?? 1;
    const matched = s.segments.length === play.chunk.lines.length;

    s.segments.forEach((seg, i) => {
      pieces.push({ data: seg, samples: seg.length });
      totalSamples += seg.length;
      const nominal = matched
        ? (play.pauses[i] ?? play.pauses[play.pauses.length - 1] ?? 4)
        : play.pauses.reduce((a, b) => a + b, 0) / Math.max(1, play.pauses.length);
      const gap = Math.round(nominal * scale * fs);
      pieces.push({ data: null, samples: gap });
      totalSamples += gap;
    });
  }

  // The fade section is silence under the bed.
  const fadeSamples = Math.round(SECTION_SPEC.get('fade')!.share * settings.minutes * 60 * fs);
  pieces.push({ data: null, samples: fadeSamples });
  totalSamples += fadeSamples;

  const voice = new Float32Array(totalSamples);
  let offset = 0;
  for (const p of pieces) {
    if (p.data) voice.set(p.data, offset);
    offset += p.samples;
  }

  // ---- 4. filter, taper, fade, mix --------------------------------------------------
  say('Conditioning and mixing…');
  const ctx = new OfflineAudioContext(1, totalSamples, fs);

  const voiceBuffer = ctx.createBuffer(1, totalSamples, fs);
  voiceBuffer.getChannelData(0).set(voice);
  // The context owns the samples now; let the staging copy go before we allocate more.
  pieces.length = 0;
  const voiceSrc = ctx.createBufferSource();
  voiceSrc.buffer = voiceBuffer;

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 80;

  // Standing in for the de-esser. Sibilance is what jolts people awake.
  const deEss = ctx.createBiquadFilter();
  deEss.type = 'highshelf';
  deEss.frequency.value = 6500;
  deEss.gain.value = -5;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 10000;

  const master = ctx.createGain();
  voiceSrc.connect(hp).connect(deEss).connect(lp).connect(master);

  const bedGain = ctx.createGain();
  if (settings.bed !== 'none') {
    const bedLoopSamples = Math.min(totalSamples, Math.round(BED_LOOP_SEC * fs));
    const bedBuffer = ctx.createBuffer(1, bedLoopSamples, fs);
    bedBuffer.getChannelData(0).set(makeBed(settings.bed, bedLoopSamples));
    const bedSrc = ctx.createBufferSource();
    bedSrc.buffer = bedBuffer;
    bedSrc.loop = true;
    bedGain.gain.value = 10 ** ((settings.bedLevelDb ?? BED_DEFAULT_DB) / 20);
    bedSrc.connect(bedGain).connect(master);
    bedSrc.start(0);
  }

  // Guaranteed descent: flat until 4:00, then linear-in-dB to -6 dB, then the 90 s fade to
  // silence. Applied as a sampled curve so it is exact rather than approximated by ramps.
  const durationSec = totalSamples / fs;
  const curvePoints = Math.max(2, Math.round(durationSec));
  const curve = new Float32Array(curvePoints);
  for (let i = 0; i < curvePoints; i++) {
    const t = (i / (curvePoints - 1)) * durationSec;
    let db = 0;
    if (t > TAPER_START_SEC && durationSec > TAPER_START_SEC) {
      db = (-TAPER_DEPTH_DB * (t - TAPER_START_SEC)) / (durationSec - TAPER_START_SEC);
    }
    let gain = 10 ** (db / 20);
    const fadeStart = durationSec - FADE_SEC;
    if (t > fadeStart) gain *= Math.max(0, 1 - (t - fadeStart) / FADE_SEC);
    curve[i] = gain;
  }
  master.gain.setValueCurveAtTime(curve, 0, durationSec);
  master.connect(ctx.destination);
  voiceSrc.start(0);

  const rendered = await ctx.startRendering();
  // Deliberately not copied. An hour is 86 million samples; a needless copy is 345 MB.
  const out = rendered.getChannelData(0);

  // ---- 5. normalise to -23 LUFS with true peak under -3 dBTP -------------------------
  say('Measuring loudness…');
  const measuredLufs = integratedLufs(out, fs);
  const measuredPeak = truePeakDb(out);
  let gainDb = Number.isFinite(measuredLufs) ? -23 - measuredLufs : 0;
  // Never let the gain push true peak past the ceiling; loudness yields to peak. The
  // ceiling is -3.5 rather than -3.0 so the result is strictly *under* -3 dBTP, and because
  // the 4x-oversampled peak estimate errs a fraction of a dB low.
  if (measuredPeak + gainDb > PEAK_CEILING_DB) gainDb = PEAK_CEILING_DB - measuredPeak;
  const gain = 10 ** (gainDb / 20);
  for (let i = 0; i < out.length; i++) out[i] *= gain;

  const finalLufs = integratedLufs(out, fs);
  const finalPeak = truePeakDb(out);
  const minutePeakDb = windowPeakDb(out, 60, fs);
  const minuteRmsDb = windowRmsDb(out, 60, fs);

  const finiteChunk = chunkRmsDb.filter(Number.isFinite);
  const mean = finiteChunk.reduce((a, b) => a + b, 0) / Math.max(1, finiteChunk.length);
  const std = Math.sqrt(
    finiteChunk.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, finiteChunk.length),
  );

  return {
    samples: out,
    sampleRate: fs,
    splitFallbacks,
    measurement: {
      durationSec: out.length / fs,
      integratedLufs: finalLufs,
      truePeakDb: finalPeak,
      lra: 0,
      chunkRmsDb,
      chunkRmsStdDb: std,
      chunkWpm,
      minuteRmsDb,
      minutePeakDb,
      monotonicAfterMin4: isMonotonicAfter(minutePeakDb, 4),
    },
  };
}
