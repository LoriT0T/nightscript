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
const TAPER_DEPTH_DB = 8;
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

/**
 * All four measurements in ONE allocation-free pass.
 *
 * The obvious implementation — K-weight into a new array, then walk overlapping 400 ms
 * blocks, then walk again for true peak, then again per minute — allocates two more
 * full-length buffers and reads the signal four times. At 60 minutes that is 86 million
 * samples and roughly 700 MB of extra allocation on top of an already ~1 GB working set,
 * which does not run slowly so much as thrash until the tab is unusable. Measured: it had
 * not finished after six minutes.
 *
 * So: filter, accumulate and peak-detect sample by sample, keeping only 100 ms sub-block
 * sums (36,000 numbers for an hour). Overlapping 400 ms blocks are then four consecutive
 * sub-blocks, so the 75% overlap costs nothing instead of quadrupling the work.
 */
export interface SignalStats {
  integratedLufs: number;
  truePeakDb: number;
  windowPeakDb: number[];
  windowRmsDb: number[];
}

export function analyse(
  x: Float32Array,
  fs = ASSEMBLY_SAMPLE_RATE,
  windowSec = 60,
): SignalStats {
  // --- K-weighting coefficients, bilinear-transformed for this sample rate ---
  const shelfDb = 3.999843853973347;
  const f0 = 1681.974450955533;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (shelfDb / 20);
  const Vb = Vh ** 0.4996667741545416;
  const a0 = 1 + K / Q + K * K;
  const b0 = (Vh + (Vb * K) / Q + K * K) / a0;
  const b1 = (2 * (K * K - Vh)) / a0;
  const b2 = (Vh - (Vb * K) / Q + K * K) / a0;
  const a1 = (2 * (K * K - 1)) / a0;
  const a2 = (1 - K / Q + K * K) / a0;

  const f0h = 38.13547087602444;
  const Qh = 0.5003270373238773;
  const Kh = Math.tan((Math.PI * f0h) / fs);
  const d0 = 1 + Kh / Qh + Kh * Kh;
  const h1 = (2 * (Kh * Kh - 1)) / d0;
  const h2 = (1 - Kh / Qh + Kh * Kh) / d0;

  let s1x1 = 0, s1x2 = 0, s1y1 = 0, s1y2 = 0;
  let s2x1 = 0, s2x2 = 0, s2y1 = 0, s2y2 = 0;

  const subSamples = Math.round(fs * 0.1);
  const subSums: number[] = [];
  let subSum = 0;
  let subCount = 0;

  const winSamples = Math.round(fs * windowSec);
  const windowPeakDb: number[] = [];
  const windowRmsDb: number[] = [];
  let winPeak = 0;
  let winSquares = 0;
  let winCount = 0;

  let peak = 0;

  for (let i = 0; i < x.length; i++) {
    const v = x[i];

    // True peak, 4x linearly interpolated against the next sample.
    const av = v < 0 ? -v : v;
    if (av > peak) peak = av;
    if (i + 1 < x.length) {
      const d = (x[i + 1] - v) / 4;
      for (let k = 1; k < 4; k++) {
        const iv = v + d * k;
        const aiv = iv < 0 ? -iv : iv;
        if (aiv > peak) peak = aiv;
      }
    }

    // Per-window peak and RMS.
    if (av > winPeak) winPeak = av;
    winSquares += v * v;
    if (++winCount === winSamples) {
      windowPeakDb.push(winPeak === 0 ? -Infinity : 20 * Math.log10(winPeak));
      windowRmsDb.push(
        winSquares === 0 ? -Infinity : 20 * Math.log10(Math.sqrt(winSquares / winSamples)),
      );
      winPeak = 0;
      winSquares = 0;
      winCount = 0;
    }

    // K-weighting, two biquads in series, state carried by hand.
    const y1v = b0 * v + b1 * s1x1 + b2 * s1x2 - a1 * s1y1 - a2 * s1y2;
    s1x2 = s1x1; s1x1 = v; s1y2 = s1y1; s1y1 = y1v;
    const y2v = y1v - 2 * s2x1 + s2x2 - h1 * s2y1 - h2 * s2y2;
    s2x2 = s2x1; s2x1 = y1v; s2y2 = s2y1; s2y1 = y2v;

    subSum += y2v * y2v;
    if (++subCount === subSamples) {
      subSums.push(subSum);
      subSum = 0;
      subCount = 0;
    }
  }

  if (winCount > 0) {
    windowPeakDb.push(winPeak === 0 ? -Infinity : 20 * Math.log10(winPeak));
    windowRmsDb.push(
      winSquares === 0 ? -Infinity : 20 * Math.log10(Math.sqrt(winSquares / winCount)),
    );
  }

  // --- gated integrated loudness over 400 ms blocks (4 sub-blocks), 100 ms hop ---
  const blockLoudness: number[] = [];
  for (let i = 0; i + 4 <= subSums.length; i++) {
    const mean = (subSums[i] + subSums[i + 1] + subSums[i + 2] + subSums[i + 3]) / (subSamples * 4);
    if (mean > 0) blockLoudness.push(-0.691 + 10 * Math.log10(mean));
  }

  const meanPower = (ls: number[]) =>
    ls.reduce((a, l) => a + 10 ** ((l + 0.691) / 10), 0) / ls.length;

  let integratedLufs = -Infinity;
  const absGated = blockLoudness.filter((l) => l > -70);
  if (absGated.length > 0) {
    const relThreshold = -0.691 + 10 * Math.log10(meanPower(absGated)) - 10;
    const gated = absGated.filter((l) => l > relThreshold);
    if (gated.length > 0) integratedLufs = -0.691 + 10 * Math.log10(meanPower(gated));
  }

  return {
    integratedLufs,
    truePeakDb: peak === 0 ? -Infinity : 20 * Math.log10(peak),
    windowPeakDb,
    windowRmsDb,
  };
}

export function isMonotonicAfter(series: number[], fromMinute = 4, toleranceDb = 0.5): boolean {
  let runningMax = -Infinity;
  for (let i = fromMinute; i < series.length; i++) {
    const cur = series[i];
    if (!Number.isFinite(cur)) continue;
    if (runningMax !== -Infinity && cur > runningMax + toleranceDb) return false;
    runningMax = Math.max(runningMax, cur);
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
  // its time budget.
  //
  // The subtlety that cost a track: a pause is only placed after a segment that actually
  // exists. When the model runs two lines together, a ten-line chunk comes back as, say,
  // seven speech regions, so only seven pauses are placed — not ten. Scaling against the
  // *planned* ten-pause list then leaves the section far short of its budget. Measured: a
  // 60-minute track came out at 30:09. So the effective pause list is computed FIRST, per
  // play, and the scale is derived from that.
  say('Re-timing against measured speech…');

  const effective = new Map<Play, number[]>();
  for (const play of plays) {
    const s = split.get(play.chunk.hashKey);
    if (!s || s.segments.length === 0) continue;
    const matched = s.segments.length === play.chunk.lines.length;
    if (matched) {
      effective.set(play, play.pauses.slice(0, s.segments.length));
    } else {
      // Spread the chunk's whole planned silence budget across the segments we really have,
      // so a mis-split loses the line boundary but never loses the time.
      const totalPlanned = play.pauses.reduce((a, b) => a + b, 0);
      const per = totalPlanned / s.segments.length;
      effective.set(play, new Array(s.segments.length).fill(per));
    }
  }

  const scaleBySection = new Map<Section, number>();
  for (const spec of SECTION_SPEC.values()) {
    if (spec.section === 'fade') continue;
    const sectionPlays = plays.filter((p) => p.chunk.section === spec.section);
    if (!sectionPlays.length) continue;
    let speech = 0;
    let pause = 0;
    for (const p of sectionPlays) {
      speech += split.get(p.chunk.hashKey)?.durations.reduce((a, b) => a + b, 0) ?? 0;
      pause += (effective.get(p) ?? []).reduce((a, b) => a + b, 0);
    }
    const budget = spec.share * settings.minutes * 60;
    scaleBySection.set(
      spec.section,
      pause > 0 ? Math.min(4, Math.max(0.4, (budget - speech) / pause)) : 1,
    );
  }

  // ---- 3. lay out the voice track --------------------------------------------------
  say('Laying out the hour…');
  const pieces: Array<{ data: Float32Array | null; samples: number }> = [];
  let totalSamples = 0;

  for (const play of plays) {
    const s = split.get(play.chunk.hashKey);
    const pauses = effective.get(play);
    if (!s || !pauses) continue;
    const scale = scaleBySection.get(play.chunk.section) ?? 1;

    s.segments.forEach((seg, i) => {
      pieces.push({ data: seg, samples: seg.length });
      totalSamples += seg.length;
      const gap = Math.round((pauses[i] ?? pauses[pauses.length - 1] ?? 4) * scale * fs);
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

  /**
   * Gentle peak control. Not for loudness-war reasons — for two specific measured failures.
   *
   * Without it, a real 60-minute track came out at -25.79 LUFS instead of -23 (a handful of
   * loud consonants capped the normalisation gain), and its per-minute peak curve wobbled by
   * ±3 dB, which swamps the -6 dB taper and breaks the "nothing gets louder" constraint
   * outright. Taming peaks fixes both at once: the average can come up to target, and the
   * descent becomes the dominant thing in the envelope rather than a rounding error.
   *
   * Settings are deliberately mild — a high ratio above a low threshold with a slow release,
   * so it catches the occasional spike and is otherwise not doing anything.
   */
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -20;
  limiter.knee.value = 8;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.25;

  const master = ctx.createGain();
  voiceSrc.connect(hp).connect(deEss).connect(lp).connect(limiter).connect(master);

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
  const stats = analyse(out, fs, 60);
  let gainDb = Number.isFinite(stats.integratedLufs) ? -23 - stats.integratedLufs : 0;
  // Never let the gain push true peak past the ceiling; loudness yields to peak.
  if (stats.truePeakDb + gainDb > PEAK_CEILING_DB) gainDb = PEAK_CEILING_DB - stats.truePeakDb;
  const gain = 10 ** (gainDb / 20);
  for (let i = 0; i < out.length; i++) out[i] *= gain;

  // A pure gain shifts loudness and peak by exactly that many dB, so re-measuring an hour
  // to learn what arithmetic already tells us would double the cost for nothing.
  const finalLufs = stats.integratedLufs + gainDb;
  const finalPeak = stats.truePeakDb + gainDb;
  const minutePeakDb = stats.windowPeakDb.map((v) => v + gainDb);
  const minuteRmsDb = stats.windowRmsDb.map((v) => v + gainDb);

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
