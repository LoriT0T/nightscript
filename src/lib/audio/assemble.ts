import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpeg, durationOf } from './ffmpeg';
import {
  detectSilences,
  isMonotonicAfter,
  measureLoudness,
  measureMinutePeak,
  measureMinuteRms,
} from './measure';
import { pcmToWav, pcmDurationSec, pcmRmsDb, SAMPLE_RATE } from '@/lib/gemini/wav';
import { SECTION_SPEC, type Play } from '@/lib/script/plan';
import type { Measurement, Section, TrackSettings } from '@/lib/types';

/**
 * Assembly.
 *
 * Pauses are NOT produced by the model — it cannot hold a 7-second gap reliably. Each
 * generated chunk is split back into its individual lines at the model's own inter-sentence
 * gaps, and the pieces are re-laid against the exact pause schedule the arc calls for.
 * See docs/GEMINI-TTS.md §8.
 */

export interface ChunkAudio {
  hash: string;
  pcm: Uint8Array;
  /** Number of lines that went into this chunk — used to sanity-check the split. */
  lineCount: number;
}

export interface AssembleOptions {
  workDir: string;
  outBase: string;
  settings: TrackSettings;
  onProgress?: (msg: string) => void;
}

export interface AssembleResult {
  opusPath: string;
  aacPath: string;
  measurement: Measurement;
  /** Chunks whose silence split did not match the expected line count. */
  splitFallbacks: number;
}

/** Level of the noise bed relative to full scale, before the master loudnorm. */
const BED_DEFAULT_DB = -34;
/** The final fade, in seconds. The brief's 90 s, applied to the whole mix. */
const FADE_SEC = 90;
/**
 * Safety taper. The arc is *designed* to descend, but model prosody is not under our
 * control chunk to chunk. This guarantees the descent in the master regardless: 0 dB until
 * 4:00, then a smooth linear-in-dB slide to −6 dB by the end. Slow enough to be
 * imperceptible as an event (docs/AFFIRMATION-DESIGN.md §10), decisive enough that the
 * last ten minutes cannot exceed the first.
 */
const TAPER_START_SEC = 240;
const TAPER_DEPTH_DB = 8;
/** True-peak ceiling. Below the -3 dBTP requirement, not at it. */
const PEAK_CEILING_DB = -3.5;
/** Nothing after this minute may exceed the loudest minute of the opening. */
const CAP_FROM_MINUTE = 4;

function quantize(sec: number): number {
  return Math.max(0, Math.round(sec * 10) / 10);
}

async function makeSilence(path: string, sec: number): Promise<void> {
  await ffmpeg([
    '-f', 'lavfi',
    '-i', `anullsrc=r=${SAMPLE_RATE}:cl=mono`,
    '-t', sec.toFixed(2),
    '-c:a', 'pcm_s16le',
    path,
  ]);
}

/**
 * Split one chunk's audio into its constituent lines using the model's own gaps.
 * Falls back to one whole-chunk segment if the gap count does not match the line count —
 * degraded spacing, never a broken track.
 */
async function splitChunk(
  wavPath: string,
  outDir: string,
  hash: string,
  lineCount: number,
): Promise<{ segments: string[]; durations: number[]; fellBack: boolean }> {
  const total = await durationOf(wavPath);
  const silences = await detectSilences(wavPath, 0.35, -40);

  // Speech regions are what is left between the detected silences.
  const regions: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor + 0.15) regions.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (total > cursor + 0.15) regions.push({ start: cursor, end: total });

  const fellBack = regions.length !== lineCount;
  const use = fellBack ? [{ start: 0, end: total }] : regions;

  const segments: string[] = [];
  const durations: number[] = [];
  for (let i = 0; i < use.length; i++) {
    const r = use[i];
    // Keep 120 ms of the natural gap on each side so consonants are not clipped and the
    // splice does not click.
    const start = Math.max(0, r.start - 0.12);
    const end = Math.min(total, r.end + 0.12);
    const p = join(outDir, `${hash}_${i}.wav`);
    await ffmpeg([
      '-i', wavPath,
      '-ss', start.toFixed(3),
      '-to', end.toFixed(3),
      '-c:a', 'pcm_s16le',
      p,
    ]);
    segments.push(p);
    durations.push(end - start);
  }
  return { segments, durations, fellBack };
}

export async function assembleTrack(
  plays: Play[],
  audio: Map<string, ChunkAudio>,
  opts: AssembleOptions,
): Promise<AssembleResult> {
  const { workDir, outBase, settings } = opts;
  const say = opts.onProgress ?? (() => {});
  const segDir = join(workDir, 'seg');
  const silDir = join(workDir, 'sil');
  await mkdir(segDir, { recursive: true });
  await mkdir(silDir, { recursive: true });

  // ---- 1. split every unique chunk once -----------------------------------------
  say('Splitting chunks into lines…');
  const splitCache = new Map<string, { segments: string[]; durations: number[] }>();
  let splitFallbacks = 0;
  const chunkRmsDb: number[] = [];
  const chunkWpm: number[] = [];

  for (const [hash, ca] of audio) {
    const wav = join(workDir, `${hash}.wav`);
    await writeFile(wav, pcmToWav(ca.pcm));
    const { segments, durations, fellBack } = await splitChunk(wav, segDir, hash, ca.lineCount);
    if (fellBack) splitFallbacks++;
    splitCache.set(hash, { segments, durations });
    chunkRmsDb.push(pcmRmsDb(ca.pcm));
  }

  // Speaking rate per chunk, for drift detection across seams.
  for (const play of plays) {
    const ca = audio.get(play.chunk.hashKey);
    if (!ca) continue;
    const words = play.chunk.lines.reduce((a, l) => a + l.text.trim().split(/\s+/).length, 0);
    const sec = pcmDurationSec(ca.pcm);
    if (sec > 0) chunkWpm.push((words / sec) * 60);
  }

  // ---- 2. re-time against MEASURED speech ------------------------------------------
  // The plan sized every pause against an estimated speaking rate. Now that the audio exists
  // we know the real one, so each section's pauses are rescaled to land that section on its
  // time budget.
  //
  // A pause is only placed after a segment that actually exists. When the model runs two
  // lines together, an eight-line chunk comes back as, say, five speech regions, so only
  // five pauses are placed — not eight. Scaling against the *planned* list then leaves the
  // section far short: measured, a 10-minute track came out at 7:50 with five of six chunks
  // mis-split. So the effective pause list is computed first, per play, and the scale is
  // derived from that. This mirrors the browser assembler exactly; the two must agree.
  say('Re-timing against measured speech…');

  const effective = new Map<Play, number[]>();
  for (const play of plays) {
    const split = splitCache.get(play.chunk.hashKey);
    if (!split || split.segments.length === 0) continue;
    const matched = split.segments.length === play.chunk.lines.length;
    if (matched) {
      effective.set(play, play.pauses.slice(0, split.segments.length));
    } else {
      // Spread the chunk's whole planned silence across the segments we really have, so a
      // mis-split loses the line boundary but never loses the time.
      const planned = play.pauses.reduce((a, b) => a + b, 0);
      effective.set(play, new Array(split.segments.length).fill(planned / split.segments.length));
    }
  }

  const scaleBySection = new Map<Section, number>();
  for (const spec of SECTION_SPEC.values()) {
    if (spec.section === 'fade') continue;
    const sectionPlays = plays.filter((p) => p.chunk.section === spec.section);
    if (sectionPlays.length === 0) continue;

    let speech = 0;
    let pause = 0;
    for (const play of sectionPlays) {
      speech += splitCache.get(play.chunk.hashKey)?.durations.reduce((a, b) => a + b, 0) ?? 0;
      pause += (effective.get(play) ?? []).reduce((a, b) => a + b, 0);
    }
    const budget = spec.share * settings.minutes * 60;
    scaleBySection.set(spec.section, pause > 0 ? Math.min(4, Math.max(0.4, (budget - speech) / pause)) : 1);
  }

  // ---- 3. build the concat list ---------------------------------------------------
  say('Laying out the timeline…');
  const silences = new Set<number>();
  const entries: string[] = [];

  for (const play of plays) {
    const split = splitCache.get(play.chunk.hashKey);
    const pauses = effective.get(play);
    if (!split || !pauses) continue;
    const scale = scaleBySection.get(play.chunk.section) ?? 1;

    split.segments.forEach((seg, i) => {
      entries.push(seg);
      const p = quantize((pauses[i] ?? pauses[pauses.length - 1] ?? 4) * scale);
      silences.add(p);
      entries.push(`__SIL__${p}`);
    });
  }

  for (const s of silences) await makeSilence(join(silDir, `s${s}.wav`), s);

  const listPath = join(workDir, 'concat.txt');
  const resolve = (e: string) =>
    e.startsWith('__SIL__') ? join(silDir, `s${e.slice(7)}.wav`) : e;
  await writeFile(
    listPath,
    entries.map((e) => `file '${resolve(e).replace(/'/g, "'\\''")}'`).join('\n'),
  );

  const voiceRaw = join(workDir, 'voice_raw.wav');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'pcm_s16le', voiceRaw]);

  // ---- 4. voice conditioning -------------------------------------------------------
  // High-pass removes rumble nobody can use; the de-esser and 10 kHz low-pass exist purely
  // because sibilance is what jolts people awake (docs/AFFIRMATION-DESIGN.md §10).
  say('Conditioning the voice…');
  const voice = join(workDir, 'voice.wav');
  await ffmpeg([
    '-i', voiceRaw,
    // Matches the browser chain, including the gentle peak control: without it a handful of
    // loud consonants cap the normalisation gain and the per-minute envelope wobbles by
    // several dB, which swamps the taper.
    '-af',
    'highpass=f=80,deesser=i=0.4:m=0.5:f=0.35,lowpass=f=10000,' +
      'acompressor=threshold=-20dB:ratio=12:attack=4:release=250:knee=8',
    '-c:a', 'pcm_s16le',
    voice,
  ]);

  const speechDur = await durationOf(voice);
  const fadeShare = SECTION_SPEC.get('fade')!.share;
  const totalDur = speechDur + fadeShare * settings.minutes * 60;

  // ---- 5. bed ----------------------------------------------------------------------
  const mixInputs: string[] = ['-i', voice];
  let mixFilter: string;
  const taper =
    `volume=volume='if(lt(t,${TAPER_START_SEC}),1,` +
    `pow(10,(-${TAPER_DEPTH_DB}*(t-${TAPER_START_SEC})/(${totalDur.toFixed(2)}-${TAPER_START_SEC}))/20))':eval=frame`;

  if (settings.bed === 'none') {
    mixFilter =
      `[0:a]apad=whole_dur=${totalDur.toFixed(2)},${taper},` +
      `afade=t=out:st=${(totalDur - FADE_SEC).toFixed(2)}:d=${FADE_SEC}[mix]`;
  } else {
    say('Generating the bed…');
    const bed = join(workDir, 'bed.wav');
    await makeBed(bed, settings.bed, totalDur);
    mixInputs.push('-i', bed);
    const bedGain = (settings.bedLevelDb ?? BED_DEFAULT_DB).toFixed(1);
    mixFilter =
      `[0:a]apad=whole_dur=${totalDur.toFixed(2)}[v];` +
      `[1:a]volume=${bedGain}dB[b];` +
      `[v][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[m];` +
      `[m]${taper},afade=t=out:st=${(totalDur - FADE_SEC).toFixed(2)}:d=${FADE_SEC}[mix]`;
  }

  say('Mixing…');
  const mixed = join(workDir, 'mixed.wav');
  await ffmpeg([...mixInputs, '-filter_complex', mixFilter, '-map', '[mix]', '-c:a', 'pcm_s16le', mixed]);

  // ---- enforce the descent, BEFORE normalising ---------------------------------------
  // "Nothing gets louder after minute four" cannot be left to chance: the core section is
  // the densest part of the track, so its peaks sit above the quiet opening even with a
  // taper running. Measure the per-minute peak, then hold every later minute down to the
  // loudest of the opening minutes with a gain that moves smoothly across each minute.
  //
  // Order matters. Doing this after normalisation pulls the finished level back down —
  // measured, -25.07 LUFS against a -23 target. Capping first lets the normaliser bring the
  // whole thing back up to target afterwards. Mirrors src/lib/audio/webaudio.ts; the two
  // renderers must agree.
  let levelled = mixed;
  const prePeaks = await measureMinutePeak(mixed, 60);
  const openingPeaks = prePeaks.slice(0, CAP_FROM_MINUTE + 1).filter(Number.isFinite);
  if (openingPeaks.length > 0 && prePeaks.length > CAP_FROM_MINUTE + 1) {
    const ceiling = Math.max(...openingPeaks);
    const minuteGainDb = prePeaks.map((p, i) =>
      i <= CAP_FROM_MINUTE || !Number.isFinite(p) ? 0 : Math.min(0, ceiling - p),
    );

    if (minuteGainDb.some((g) => g < -0.01)) {
      say('Holding the level down…');
      // Piecewise-linear dB curve across minute centres, as an ffmpeg volume expression.
      const terms: string[] = [`lt(t,30)*(${minuteGainDb[0].toFixed(3)})`];
      for (let i = 0; i < minuteGainDb.length - 1; i++) {
        const t0 = i * 60 + 30;
        const g0 = minuteGainDb[i];
        const g1 = minuteGainDb[i + 1];
        terms.push(
          `between(t,${t0},${t0 + 60})*(${g0.toFixed(3)}+(${(g1 - g0).toFixed(3)})*(t-${t0})/60)`,
        );
      }
      const last = minuteGainDb.length - 1;
      terms.push(`gte(t,${last * 60 + 30})*(${minuteGainDb[last].toFixed(3)})`);

      levelled = join(workDir, 'levelled.wav');
      await ffmpeg([
        '-i', mixed,
        '-af', `volume=volume='pow(10,(${terms.join('+')})/20)':eval=frame`,
        '-c:a', 'pcm_s16le',
        levelled,
      ]);
    }
  }

  // ---- 6. two-pass loudness normalisation ------------------------------------------
  say('Normalising loudness…');
  const pre = await measureLoudness(levelled);
  const master = join(workDir, 'master.wav');
  await ffmpeg([
    '-i', levelled,
    '-af',
    `loudnorm=I=-23:TP=-3.5:LRA=7:measured_I=${pre.integratedLufs}:measured_TP=${pre.truePeakDb}` +
      `:measured_LRA=${pre.lra}:measured_thresh=${pre.threshold}:linear=true:print_format=summary`,
    '-ar', String(SAMPLE_RATE),
    '-c:a', 'pcm_s16le',
    master,
  ]);

  // loudnorm's linear mode lands a couple of dB short on material that is more than half
  // silence. Measure what it actually produced and close the gap with a plain gain, which is
  // safe here because true peak sits far below the -3 dBTP ceiling.
  const afterNorm = await measureLoudness(master);
  let finalMaster = master;
  const delta = -23 - afterNorm.integratedLufs;
  if (Math.abs(delta) > 0.3 && afterNorm.truePeakDb + delta < PEAK_CEILING_DB) {
    say('Trimming to target loudness…');
    finalMaster = join(workDir, 'master_trim.wav');
    await ffmpeg(['-i', master, '-af', `volume=${delta.toFixed(2)}dB`, '-c:a', 'pcm_s16le', finalMaster]);
  }

  // ---- 7. encode --------------------------------------------------------------------
  say('Encoding…');
  const opusPath = `${outBase}.webm`;
  const aacPath = `${outBase}.m4a`;
  await ffmpeg(['-i', finalMaster, '-c:a', 'libopus', '-b:a', '24k', '-vbr', 'on', '-application', 'voip', opusPath]);
  // iOS Safari cannot play Opus in WebM; the AAC copy is the fallback the player picks
  // when canPlayType says no.
  await ffmpeg(['-i', finalMaster, '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', aacPath]);

  // ---- 8. measure the thing we actually shipped -------------------------------------
  say('Measuring…');
  const post = await measureLoudness(finalMaster);
  const minuteRmsDb = await measureMinuteRms(finalMaster, 60);
  const minutePeakDb = await measureMinutePeak(finalMaster, 60);
  const finite = chunkRmsDb.filter(Number.isFinite);
  const mean = finite.reduce((a, b) => a + b, 0) / Math.max(1, finite.length);
  const std = Math.sqrt(
    finite.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, finite.length),
  );

  const measurement: Measurement = {
    durationSec: await durationOf(finalMaster),
    integratedLufs: post.integratedLufs,
    truePeakDb: post.truePeakDb,
    lra: post.lra,
    chunkRmsDb,
    chunkRmsStdDb: std,
    chunkWpm,
    minuteRmsDb,
    minutePeakDb,
    monotonicAfterMin4: isMonotonicAfter(minutePeakDb, 4),
  };

  return { opusPath, aacPath, measurement, splitFallbacks };
}

/**
 * Beds are synthesized locally with ffmpeg rather than shipped as recordings — nothing
 * streams, and there is no licensing question. "Rain" is band-limited noise shaped to sit
 * where rain sits; it is not a field recording and is labelled as synthesized in the UI.
 */
export async function makeBed(path: string, kind: TrackSettings['bed'], durationSec: number) {
  const t = durationSec.toFixed(2);
  const chains: Record<string, string> = {
    pink: `anoisesrc=color=pink:r=${SAMPLE_RATE}:d=${t}`,
    brown: `anoisesrc=color=brown:r=${SAMPLE_RATE}:d=${t}`,
    rain: `anoisesrc=color=white:r=${SAMPLE_RATE}:d=${t}`,
  };
  const post: Record<string, string[]> = {
    pink: ['lowpass=f=6000'],
    brown: ['lowpass=f=4000'],
    rain: ['highpass=f=400', 'lowpass=f=7000', 'tremolo=f=0.15:d=0.15'],
  };
  const k = kind === 'none' ? 'pink' : kind;
  await ffmpeg([
    '-f', 'lavfi',
    '-i', chains[k],
    '-af', [...post[k], `afade=t=out:st=${Math.max(0, durationSec - FADE_SEC).toFixed(2)}:d=${FADE_SEC}`].join(','),
    '-c:a', 'pcm_s16le',
    path,
  ]);
}

export async function cleanWorkDir(dir: string) {
  await rm(dir, { recursive: true, force: true });
}
