import { ffmpeg, durationOf } from './ffmpeg';

/**
 * Measurement, not intention. The brief's hardest constraint — nothing after minute four
 * may be louder than what came before — is only meaningful if it is measured, so every
 * assembled track is analysed and the result is stored with it.
 */

export interface LoudnessStats {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
  threshold: number;
}

/** EBU R128 scan via loudnorm's analysis pass, which reports true peak as well. */
export async function measureLoudness(path: string): Promise<LoudnessStats> {
  const { stderr } = await ffmpeg([
    '-i', path,
    '-af', 'loudnorm=I=-23:TP=-3:LRA=7:print_format=json',
    '-f', 'null', '-',
  ]);
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Could not parse loudnorm output');
  const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  return {
    integratedLufs: Number(j.input_i),
    truePeakDb: Number(j.input_tp),
    lra: Number(j.input_lra),
    threshold: Number(j.input_thresh),
  };
}

/**
 * Per-minute RMS in dBFS. `astats` with a one-minute reset window gives us the descent
 * curve directly.
 */
export async function measureMinuteRms(
  path: string,
  windowSec = 60,
  sampleRate = 24000,
): Promise<number[]> {
  // `astats` `reset` counts FRAMES, not seconds. Passing 60 gives ~86 ms windows, over which
  // level rises and falls with every syllable — which made the monotonicity check
  // meaningless. `asetnsamples` forces one frame per window so `reset=1` is exactly one
  // window, and the numbers mean what they say.
  const n = Math.round(sampleRate * windowSec);
  const { stderr } = await ffmpeg([
    '-i', path,
    '-af',
    `asetnsamples=n=${n}:p=0,astats=metadata=1:reset=1,` +
      `ametadata=print:key=lavfi.astats.Overall.RMS_level`,
    '-f', 'null', '-',
  ]);
  const out: number[] = [];
  for (const m of stderr.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/g)) {
    out.push(m[1] === '-inf' ? -Infinity : Number(m[1]));
  }
  return out;
}

/**
 * Per-minute PEAK level in dBFS.
 *
 * This, not RMS, is the honest measure of "could this wake someone". Per-minute RMS over a
 * track that is more than half silence mostly reports the speech-to-silence ratio of that
 * particular minute, which swings around a decibel as the pause schedule grows — so an RMS
 * monotonicity test fails on a track whose loudest moments are in fact descending. The
 * loudest moment in each minute is what the sleeping ear is exposed to.
 */
export async function measureMinutePeak(
  path: string,
  windowSec = 60,
  sampleRate = 24000,
): Promise<number[]> {
  const n = Math.round(sampleRate * windowSec);
  const { stderr } = await ffmpeg([
    '-i', path,
    '-af',
    `asetnsamples=n=${n}:p=0,astats=metadata=1:reset=1,` +
      `ametadata=print:key=lavfi.astats.Overall.Peak_level`,
    '-f', 'null', '-',
  ]);
  const out: number[] = [];
  for (const m of stderr.matchAll(/lavfi\.astats\.Overall\.Peak_level=(-?[\d.]+|-inf)/g)) {
    out.push(m[1] === '-inf' ? -Infinity : Number(m[1]));
  }
  return out;
}

/**
 * The descent constraint: after minute four, no minute is louder than anything that came
 * before it.
 *
 * Must stay identical to the browser assembler's version in src/lib/audio/webaudio.ts. They
 * drifted apart once and the two renderers disagreed about whether the same track passed —
 * the CLI was still applying a strict minute-over-minute test, which real speech fails on
 * noise alone, since natural variation between adjacent minutes is far larger than the
 * taper's 0.14 dB/min. The ceiling is the loudest minute of the opening, which is exactly
 * what the enforcement pass caps against.
 */
export function isMonotonicAfter(minutePeak: number[], fromMinute = 4, toleranceDb = 0.5): boolean {
  const opening = minutePeak.slice(0, fromMinute + 1).filter(Number.isFinite);
  if (opening.length === 0) return true;
  let ceiling = Math.max(...opening);
  for (let i = fromMinute + 1; i < minutePeak.length; i++) {
    const cur = minutePeak[i];
    if (!Number.isFinite(cur)) continue;
    if (cur > ceiling + toleranceDb) return false;
    ceiling = Math.max(ceiling, cur);
  }
  return true;
}

/** Silence boundaries inside a file, used to split a chunk into its individual lines. */
export async function detectSilences(
  path: string,
  minSilenceSec = 0.35,
  thresholdDb = -40,
): Promise<Array<{ start: number; end: number }>> {
  const { stderr } = await ffmpeg([
    '-i', path,
    '-af', `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`,
    '-f', 'null', '-',
  ]);
  const out: Array<{ start: number; end: number }> = [];
  let pending: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) pending = Number(s[1]);
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && pending !== null) {
      out.push({ start: pending, end: Number(e[1]) });
      pending = null;
    }
  }
  if (pending !== null) out.push({ start: pending, end: await durationOf(path) });
  return out;
}

export { durationOf };
