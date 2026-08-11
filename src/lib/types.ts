/** Shared domain types. Kept free of browser/node specifics so both sides can import. */

/** The seven sanctioned framings. See docs/AFFIRMATION-DESIGN.md §3–§8. */
export type Pattern =
  | 'process'
  | 'evidence'
  | 'compassion'
  | 'values'
  | 'intention'
  | 'ambivalence'
  | 'sensory';

export const PATTERNS: Pattern[] = [
  'process',
  'evidence',
  'compassion',
  'values',
  'intention',
  'ambivalence',
  'sensory',
];

export const PATTERN_LABEL: Record<Pattern, string> = {
  process: 'Process',
  evidence: 'Evidence-anchored',
  compassion: 'Self-compassion',
  values: 'Values',
  intention: 'Implementation intention',
  ambivalence: 'Permitted ambivalence',
  sensory: 'Sensory',
};

/** Sections of the descending arc. See docs/AFFIRMATION-DESIGN.md §8 and the brief §3. */
export type Section = 'arrival' | 'downshift' | 'core' | 'second' | 'dissolution' | 'fade';

export interface Goal {
  id: string;
  /** The goal in the listener's own words. */
  text: string;
  /** Why it matters — the values anchor. */
  why: string;
  /** What specifically gets in the way — feeds implementation intentions. */
  obstacle: string;
  /** A past moment they handled it well — the evidence anchor. */
  evidence: string;
  /** 1–10. Below 4 restricts phrasing to process/compassion/values/intention. */
  believability: number;
  /** Relative share of track time. */
  weight: number;
  /** Marks the goal as addiction / mental-health, triggering the stricter rules (§7). */
  sensitive: boolean;
}

export interface Line {
  id: string;
  text: string;
  pattern: Pattern;
  section: Section;
  /** Goal this line serves; null for arrival/downshift/fade material. */
  goalId: string | null;
  /** User locked this line — regeneration must leave it alone. */
  locked?: boolean;
}

export interface Script {
  lines: Line[];
  /** Core affirmations get cycled; this records the repeat plan actually used. */
  cycles: number;
}

export interface Intake {
  goals: Goal[];
  /** Optional free note passed to the writer for tone/context. */
  note?: string;
}

export interface TrackSettings {
  voice: string;
  bed: 'none' | 'pink' | 'brown' | 'rain';
  bedLevelDb: number;
  /** Total target minutes. 60 by default; shorter is allowed for testing. */
  minutes: number;
}

export interface TrackMeta {
  id: string;
  name: string;
  createdAt: number;
  intake: Intake;
  settings: TrackSettings;
  script: Script;
  /** Measured after assembly. */
  measured?: Measurement;
  /** Which container actually got stored. */
  mime: string;
  bytes: number;
  durationSec: number;
}

export interface Measurement {
  durationSec: number;
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
  /** RMS dBFS per generated chunk, in order — used to spot voice drift across seams. */
  chunkRmsDb: number[];
  chunkRmsStdDb: number;
  /** Estimated speaking rate per chunk, words per minute of speech. */
  chunkWpm: number[];
  /** Per-minute RMS dBFS of the finished track. Reported, but see minutePeakDb. */
  minuteRmsDb: number[];
  /**
   * Per-minute peak dBFS. This is the series the "nothing gets louder after minute four"
   * constraint is judged on — the loudest moment in a minute is what could wake someone,
   * whereas per-minute RMS mostly tracks how much of that minute was silence.
   */
  minutePeakDb: number[];
  monotonicAfterMin4: boolean;
}

export interface ValidationIssue {
  lineId: string;
  rule: string;
  severity: 'error' | 'warn';
  message: string;
  /** The exact matched text, when there is one. */
  match?: string;
}
