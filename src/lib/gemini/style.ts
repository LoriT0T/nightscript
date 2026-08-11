import type { Section } from '@/lib/types';

/**
 * Style direction for the TTS model.
 *
 * IMPORTANT (docs/GEMINI-TTS.md §7): an earlier draft of this preamble was rejected by
 * the API with HTTP 400 `content_blocked`. The blocked wording described the *listener's*
 * state ("as if speaking to someone already half asleep", "you do not have to stay awake
 * for this") which reads as hypnotic induction. This version describes **vocal delivery
 * only** and never refers to the listener's consciousness. Re-test against the live API
 * before changing a single clause of BASE_STYLE.
 *
 * BASE_STYLE is byte-identical on every chunk of a track so the voice does not drift
 * across request boundaries. SECTION_STYLE adds at most one short clause, which is the
 * minimum needed to make energy descend across the hour without destabilising continuity.
 */
export const BASE_STYLE = [
  'Read the following text as quiet narration.',
  'Speak slowly and evenly, at about half the pace of normal conversation.',
  'Keep the voice low, warm and close to the microphone, at a small and intimate volume.',
  'Let the pitch fall at the end of every sentence. Never let a sentence rise or sound like a question.',
  'Be plain and sincere. No performance, no bright tone, no dramatic emphasis, no singsong.',
  'Leave small natural breaths between sentences. No theatrical sighs.',
  'Do not speed up or get brighter as you go. Keep every sentence at the same low, level energy.',
].join(' ');

const SECTION_STYLE: Record<Section, string> = {
  arrival: 'Settled and unhurried.',
  downshift: 'Softer and slower than a normal reading voice.',
  core: 'Steady and quiet throughout.',
  second: 'Softer and slower still, almost murmured.',
  dissolution: 'Barely voiced, trailing off, the quietest reading of all.',
  fade: 'Barely voiced, trailing off, the quietest reading of all.',
};

/** Full input string sent to the model for one chunk. */
export function buildInput(section: Section, text: string): string {
  return `${BASE_STYLE} ${SECTION_STYLE[section]}\n\n${text}`;
}

/**
 * Inline audio tags we permit. The docs list many more, but everything not here
 * raises energy, which the arc forbids after minute four.
 * See docs/GEMINI-TTS.md §7.
 */
export const ALLOWED_TAGS = ['[whispers]', '[tired]', '[very slow]', '[softly]'] as const;
