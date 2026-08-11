/**
 * Prebuilt voice roster, enumerated from the live docs on 2026-08-11.
 * See docs/GEMINI-TTS.md §1. The `descriptor` column is Google's own one-word
 * characterisation; `femalePresenting` is our judgement of which are plausible
 * candidates for this track, and `nightRank` is a preference order within those
 * (lower = warmer / lower energy = better default).
 *
 * The point of the audition flow is that the listener picks by ear. Nothing here
 * is authoritative about how a voice actually sounds.
 */

export interface VoiceInfo {
  name: string;
  descriptor: string;
  femalePresenting: boolean;
  /** Only set for female-presenting candidates. 1 is the default pick. */
  nightRank?: number;
  /** Why it is or is not a candidate for a sleep track. */
  note?: string;
}

export const VOICES: VoiceInfo[] = [
  { name: 'Zephyr', descriptor: 'Bright', femalePresenting: true, nightRank: 8, note: 'Bright is the opposite of what we want, but auditioned for completeness.' },
  { name: 'Puck', descriptor: 'Upbeat', femalePresenting: false },
  { name: 'Charon', descriptor: 'Informative', femalePresenting: false },
  { name: 'Kore', descriptor: 'Firm', femalePresenting: true, nightRank: 7, note: 'Firm reads as instructional; risks therapist-voice.' },
  { name: 'Fenrir', descriptor: 'Excitable', femalePresenting: false },
  { name: 'Leda', descriptor: 'Youthful', femalePresenting: true, nightRank: 9, note: 'Youthful tends to sit high in pitch.' },
  { name: 'Orus', descriptor: 'Firm', femalePresenting: false },
  { name: 'Aoede', descriptor: 'Breezy', femalePresenting: true, nightRank: 6 },
  { name: 'Callirrhoe', descriptor: 'Easy-going', femalePresenting: true, nightRank: 4 },
  { name: 'Autonoe', descriptor: 'Bright', femalePresenting: true, nightRank: 10 },
  { name: 'Enceladus', descriptor: 'Breathy', femalePresenting: false },
  { name: 'Iapetus', descriptor: 'Clear', femalePresenting: false },
  { name: 'Umbriel', descriptor: 'Easy-going', femalePresenting: false },
  { name: 'Algieba', descriptor: 'Smooth', femalePresenting: false },
  { name: 'Despina', descriptor: 'Smooth', femalePresenting: true, nightRank: 3 },
  { name: 'Erinome', descriptor: 'Clear', femalePresenting: true, nightRank: 11 },
  { name: 'Algenib', descriptor: 'Gravelly', femalePresenting: false },
  { name: 'Rasalgethi', descriptor: 'Informative', femalePresenting: false },
  { name: 'Laomedeia', descriptor: 'Upbeat', femalePresenting: true, nightRank: 12, note: 'Upbeat is disqualifying on paper; included so the choice is yours.' },
  { name: 'Achernar', descriptor: 'Soft', femalePresenting: true, nightRank: 2 },
  { name: 'Alnilam', descriptor: 'Firm', femalePresenting: false },
  { name: 'Schedar', descriptor: 'Even', femalePresenting: false },
  { name: 'Gacrux', descriptor: 'Mature', femalePresenting: true, nightRank: 5, note: 'Mature usually means lower pitch, which suits.' },
  { name: 'Pulcherrima', descriptor: 'Forward', femalePresenting: true, nightRank: 13, note: 'Forward = projected. Wrong direction for close-mic.' },
  { name: 'Achird', descriptor: 'Friendly', femalePresenting: false },
  { name: 'Zubenelgenubi', descriptor: 'Casual', femalePresenting: false },
  { name: 'Vindemiatrix', descriptor: 'Gentle', femalePresenting: true, nightRank: 3 },
  { name: 'Sadachbia', descriptor: 'Lively', femalePresenting: false },
  { name: 'Sadaltager', descriptor: 'Knowledgeable', femalePresenting: false },
  { name: 'Sulafat', descriptor: 'Warm', femalePresenting: true, nightRank: 1, note: 'Default. Warm + low energy is exactly the brief.' },
];

export const AUDITION_VOICES = VOICES.filter((v) => v.femalePresenting).sort(
  (a, b) => (a.nightRank ?? 99) - (b.nightRank ?? 99),
);

export const DEFAULT_VOICE = 'Sulafat';

export function isKnownVoice(name: string): boolean {
  return VOICES.some((v) => v.name === name);
}

/**
 * The passage every voice reads in the audition. Deliberately contains the two
 * hardest things for this track: a long falling sentence, and sibilance.
 */
export const AUDITION_PASSAGE =
  'I am learning to be steadier than I was. My shoulders can soften now. ' +
  'I showed up before, and I can show up again. My jaw is loose. My hands are still.';
