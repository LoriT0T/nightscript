import type { Goal, Line, Script, Section } from '@/lib/types';

/**
 * Track arc, timing and chunking.
 *
 * The whole design serves one constraint from the brief: if the listener is asleep by
 * minute 12, nothing after it may wake them. That makes every number here a *descent* —
 * pauses only grow, density only falls, and no section is ever busier than the one before.
 * See docs/AFFIRMATION-DESIGN.md §8 and §10.
 */

export interface SectionSpec {
  section: Section;
  /** Fraction of total runtime. Sums to 1. */
  share: number;
  /** Seconds of silence after each line at the start / end of the section. */
  pauseStart: number;
  pauseEnd: number;
  label: string;
  purpose: string;
}

/** Proportions taken directly from the brief's 60-minute layout. */
export const ARC: SectionSpec[] = [
  {
    section: 'arrival',
    share: 4 / 60,
    pauseStart: 5,
    pauseEnd: 6,
    label: 'Arrival',
    purpose: 'Breath cue and permission to stop listening. No content.',
  },
  {
    section: 'downshift',
    share: 6 / 60,
    pauseStart: 5,
    pauseEnd: 6,
    label: 'Downshift',
    purpose: 'Slow body scan: jaw, shoulders, hands, feet.',
  },
  {
    section: 'core',
    share: 25 / 60,
    pauseStart: 3,
    pauseEnd: 5.5,
    label: 'Core affirmations',
    purpose: 'Densest section. Primary goals. Pauses grow throughout.',
  },
  {
    section: 'second',
    share: 15 / 60,
    pauseStart: 5.5,
    pauseEnd: 7,
    label: 'Second pass',
    purpose: 'Same material, softer and more spaced, weighted to self-compassion.',
  },
  {
    section: 'dissolution',
    share: 7 / 60,
    pauseStart: 7,
    pauseEnd: 8,
    label: 'Dissolution',
    purpose: 'Fragments rather than sentences. Sparse.',
  },
  {
    section: 'fade',
    share: 3 / 60,
    pauseStart: 0,
    pauseEnd: 0,
    label: 'Fade',
    purpose: 'No speech. Bed fades to silence over the final 90 seconds.',
  },
];

export const SECTION_SPEC = new Map(ARC.map((s) => [s.section, s]));

/**
 * Measured speaking rate under the style preamble, in words per minute of *speech* (pauses
 * excluded). Not a guess: measured across the full voice-audition set on 2026-08-11, which
 * ranged 74–101 wpm with a mean of 86. See docs/AFFIRMATION-DESIGN.md §9d. Used for the live
 * runtime estimate in the editor and for the section budgets.
 */
export const SPEECH_WPM = 86;

export function speechSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return (words / SPEECH_WPM) * 60;
}

/** Silence after a line, given where it sits in its section. `t` is 0..1 within the section. */
export function pauseSeconds(section: Section, t: number): number {
  const spec = SECTION_SPEC.get(section);
  if (!spec) return 4;
  return spec.pauseStart + (spec.pauseEnd - spec.pauseStart) * Math.min(1, Math.max(0, t));
}

/**
 * Total runtime in seconds — what the editor shows live as lines are edited.
 * Goes through the real timeline (including core cycling) so the number the user sees is
 * the number the assembler will produce, not an idealised one.
 */
export function estimateRuntimeSec(lines: Line[], totalMinutes = 60): number {
  const { plays } = buildTimeline(planChunks({ lines, cycles: 1 }), totalMinutes);
  return timelineDurationSec(plays, totalMinutes);
}

export function groupBySection(lines: Line[]): Map<Section, Line[]> {
  const m = new Map<Section, Line[]>();
  for (const spec of ARC) m.set(spec.section, []);
  for (const line of lines) m.get(line.section)?.push(line);
  for (const [k, v] of m) if (v.length === 0 && k !== 'fade') m.set(k, v);
  return m;
}

/**
 * Observed average line length per section, in words. These are not guesses — they are what
 * the writing model actually produces for each section's instructions. Getting them wrong
 * is what makes a section underfill its budget, and an underfilled section gets padded with
 * silence, which is how the opening ends up with longer gaps than the core. Measure and
 * update these if the section prompts change.
 */
const SECTION_AVG_WORDS: Record<Section, number> = {
  arrival: 7,
  downshift: 7,
  core: 12,
  second: 9,
  dissolution: 5,
  fade: 0,
};

/**
 * How many lines each section needs to fill its time budget. Used to brief the writing
 * model, not to constrain the user afterwards.
 */
export function targetLineCounts(totalMinutes = 60): Record<Section, number> {
  const out = {} as Record<Section, number>;
  for (const spec of ARC) {
    if (spec.section === 'fade') {
      out.fade = 0;
      continue;
    }
    const budget = spec.share * totalMinutes * 60;
    const avgSpeech = (SECTION_AVG_WORDS[spec.section] / SPEECH_WPM) * 60;
    const avgPause = (spec.pauseStart + spec.pauseEnd) / 2;
    out[spec.section] = Math.max(1, Math.round(budget / (avgSpeech + avgPause)));
  }
  return out;
}

/**
 * Split goal time proportionally to weight, using largest-remainder so the counts
 * actually sum to `total` rather than drifting.
 */
export function allocateByWeight(goals: Goal[], total: number): Map<string, number> {
  const sum = goals.reduce((a, g) => a + Math.max(0, g.weight), 0) || 1;
  const exact = goals.map((g) => ({ id: g.id, v: (Math.max(0, g.weight) / sum) * total }));
  const out = new Map(exact.map((e) => [e.id, Math.floor(e.v)]));
  let remaining = total - [...out.values()].reduce((a, b) => a + b, 0);
  exact
    .sort((a, b) => (b.v % 1) - (a.v % 1))
    .forEach((e) => {
      if (remaining > 0) {
        out.set(e.id, (out.get(e.id) ?? 0) + 1);
        remaining--;
      }
    });
  return out;
}

// ---------------------------------------------------------------------------
// Chunking for TTS
// ---------------------------------------------------------------------------

export interface Chunk {
  index: number;
  /** SHA-256 cache key, filled in by the pipeline once the voice is known. */
  hashKey: string;
  section: Section;
  lines: Line[];
  /** Text sent to the model: lines joined by blank lines so gaps are detectable. */
  text: string;
  /** Silence to place after each line, in order. */
  pauses: number[];
}

/**
 * Chunk size. Not driven by the token limit — we are two orders of magnitude inside the
 * context window either way.
 *
 * These were halved from 150/220 to survive a serverless host's 30-second function ceiling.
 * The browser now calls the API directly and that ceiling is gone, so bigger chunks are
 * available again — but they are deliberately NOT taken, for two reasons:
 *
 *  1. These values produced the measured 60-minute track (-23.00 LUFS, descent holding), so
 *     they are the known-good configuration. Larger chunks are a theoretical prosody gain
 *     against a proven result.
 *  2. Chunk text is the cache key. Changing these silently invalidates every chunk of
 *     already-generated speech, which at a hard 100 TTS requests per day is expensive in the
 *     one currency that actually runs out.
 *
 * Raise them if seam drift ever becomes audible, and expect to re-generate. See
 * docs/GEMINI-TTS.md §7.
 */
export const CHUNK_TARGET_WORDS = 80;
export const CHUNK_MAX_WORDS = 120;
export const CHUNK_MAX_LINES = 8;

export function planChunks(script: Script): Chunk[] {
  const chunks: Chunk[] = [];
  for (const [section, group] of groupBySection(script.lines)) {
    if (group.length === 0) continue;
    let current: Line[] = [];
    let currentPauses: number[] = [];
    let words = 0;

    const flush = () => {
      if (current.length === 0) return;
      chunks.push({
        index: chunks.length,
        hashKey: '',
        section,
        lines: current,
        // Blank line between affirmations encourages a real gap, which the silence
        // splitter then re-times to the exact schedule.
        text: current.map((l) => l.text).join('\n\n'),
        pauses: currentPauses,
      });
      current = [];
      currentPauses = [];
      words = 0;
    };

    group.forEach((line, i) => {
      const t = group.length > 1 ? i / (group.length - 1) : 0;
      const w = line.text.trim().split(/\s+/).length;
      if (
        current.length > 0 &&
        (words + w > CHUNK_MAX_WORDS ||
          current.length >= CHUNK_MAX_LINES ||
          (words >= CHUNK_TARGET_WORDS && current.length >= 4))
      ) {
        flush();
      }
      current.push(line);
      currentPauses.push(pauseSeconds(section, t));
      words += w;
    });
    flush();
  }
  return chunks;
}

/**
 * One playback of one chunk, with the pause schedule for *this* playback.
 *
 * The core section is heard more than once. Crucially, a repeat reuses the **identical
 * chunk grouping**, so its cache key (docs/GEMINI-TTS.md §7) is unchanged and a second
 * cycle costs zero API requests. Only the pauses differ between plays, and pauses are
 * inserted at assembly time, not by the model.
 *
 * Variation across exposures comes from the `second` section (the model's softer
 * re-voicing of the same ideas) and `dissolution` (fragments), not from re-generating the
 * core wording — which is what keeps a 4-exposure hour affordable at 3 requests/minute.
 */
export interface Play {
  chunk: Chunk;
  /** Silence after each line of the chunk, for this playback. */
  pauses: number[];
  /** 0 = first exposure. */
  cycle: number;
}

/**
 * Order the chunks into the actual track, cycling the core section to fill its budget.
 * Returns the plays in playback order plus the number of core exposures achieved.
 */
export function buildTimeline(
  chunks: Chunk[],
  totalMinutes = 60,
): { plays: Play[]; coreCycles: number } {
  const plays: Play[] = [];
  const bySection = new Map<Section, Chunk[]>();
  for (const c of chunks) bySection.set(c.section, [...(bySection.get(c.section) ?? []), c]);

  const chunkSpeech = (c: Chunk) => c.lines.reduce((a, l) => a + speechSeconds(l.text), 0);

  /**
   * Every spoken section fills its budget by repeating rather than by stretching silence.
   * Repeating is free (cached audio) and keeps pause length inside the schedule; stretching
   * is the fallback for the remainder. Without this, a short arrival section ends up with
   * 8-second gaps while the core has 3-second gaps — the opposite of the growing-pause arc.
   */
  const CYCLING: Section[] = ['arrival', 'downshift', 'core', 'second', 'dissolution'];
  const MAX_CYCLES = 6;
  /**
   * How far a pause may be scaled from its nominal value to land a section on its budget.
   * Cycling gets the section close; this closes the remainder. Allowing slight compression
   * as well as stretching means a section can overshoot by one chunk and be pulled back,
   * which keeps pauses near the 3→8 s schedule instead of ballooning past it.
   */
  const MAX_PAUSE_STRETCH = 1.8;
  const MIN_PAUSE_STRETCH = 0.75;

  for (const spec of ARC) {
    if (spec.section === 'fade') continue;
    const group = bySection.get(spec.section) ?? [];
    if (group.length === 0) continue;

    const budget = spec.share * totalMinutes * 60;
    const ordered: Chunk[] = [];

    if (CYCLING.includes(spec.section)) {
      // Repeat the chunk list, rotating each pass so the listener does not hear the same
      // two lines adjacent twice. Each repeat reuses cached audio, so it is free.
      let used = 0;
      let cycle = 0;
      while (used < budget && cycle < MAX_CYCLES) {
        const rotation =
          cycle === 0 ? 0 : (cycle * Math.max(1, Math.floor(group.length / 3))) % group.length;
        const pass = [...group.slice(rotation), ...group.slice(0, rotation)];
        let stop = false;
        for (const c of pass) {
          if (ordered.length > 0 && used >= budget) {
            stop = true;
            break;
          }
          ordered.push(c);
          used += chunkSpeech(c) + c.pauses.reduce((a, b) => a + b, 0);
        }
        if (stop) break;
        cycle++;
      }
    } else {
      ordered.push(...group);
    }

    // Re-time every play against its position in the section so pauses grow monotonically
    // across the section regardless of cycling, then stretch them by a single factor so
    // the section lands on its time budget. Stretching silence rather than adding words is
    // the only way to lengthen a section that does not raise density.
    const totalLines = ordered.reduce((a, c) => a + c.lines.length, 0);
    const speech = ordered.reduce((a, c) => a + chunkSpeech(c), 0);

    let seen = 0;
    const nominal: number[][] = ordered.map((c) => {
      const arr = c.lines.map((_, i) => {
        const t = totalLines > 1 ? (seen + i) / (totalLines - 1) : 0;
        return pauseSeconds(spec.section, t);
      });
      seen += c.lines.length;
      return arr;
    });

    const nominalTotal = nominal.flat().reduce((a, b) => a + b, 0) || 1;
    const stretch = Math.min(
      MAX_PAUSE_STRETCH,
      Math.max(MIN_PAUSE_STRETCH, (budget - speech) / nominalTotal),
    );

    const cycleOf = new Map<Chunk, number>();
    ordered.forEach((c, i) => {
      const cyc = cycleOf.get(c) ?? 0;
      cycleOf.set(c, cyc + 1);
      plays.push({ chunk: c, pauses: nominal[i].map((p) => p * stretch), cycle: cyc });
    });
  }

  const coreCycles = Math.max(
    1,
    ...plays.filter((p) => p.chunk.section === 'core').map((p) => p.cycle + 1),
  );
  return { plays, coreCycles };
}

/** Runtime of a full timeline, including the trailing fade section. */
export function timelineDurationSec(plays: Play[], totalMinutes = 60): number {
  let total = 0;
  for (const p of plays) {
    total += p.chunk.lines.reduce((a, l) => a + speechSeconds(l.text), 0);
    total += p.pauses.reduce((a, b) => a + b, 0);
  }
  return total + SECTION_SPEC.get('fade')!.share * totalMinutes * 60;
}

export function formatDuration(sec: number): string {
  // Round to whole seconds FIRST, then split. Splitting first and rounding the remainder
  // produces "59:60" for anything just under the hour.
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
