import type { Goal, Line, Pattern, ValidationIssue } from '@/lib/types';

/**
 * Line validator. Every rule here traces to docs/AFFIRMATION-DESIGN.md; the section is
 * named in each rule's `why`. This runs on generated lines AND on lines the user has
 * hand-edited, because an edit can reintroduce exactly what generation avoided.
 *
 * Severity: `error` blocks audio generation, `warn` is surfaced but does not block.
 */

interface Rule {
  id: string;
  severity: 'error' | 'warn';
  why: string;
  /** Return the offending substring, or null if the line is fine. */
  test: (line: Line, ctx: Ctx) => string | null;
}

interface Ctx {
  goal?: Goal;
}

/** Traits people silently contradict. Deliberately broad. */
const TRAIT_WORDS = [
  'confident',
  'successful',
  'fearless',
  'unstoppable',
  'powerful',
  'perfect',
  'flawless',
  'worthy',
  'lovable',
  'loveable',
  'enough',
  'amazing',
  'incredible',
  'brilliant',
  'strong',
  'disciplined',
  'fearlessly',
  'limitless',
  'invincible',
  'magnetic',
  'abundant',
  'wealthy',
  'rich',
  'beautiful',
  'attractive',
  'irresistible',
  'a winner',
  'the best',
  'free from all',
  'free of all',
  'completely healed',
  'fully healed',
  'cured',
];

/** Softeners that turn a state claim into a process/permission claim. */
const PROCESS_MARKERS = [
  'learning to',
  'building',
  'practising',
  'practicing',
  'getting better at',
  'a little more',
  'more often than',
  'beginning to',
  'starting to',
  'working on',
  'can be',
  'can choose',
  'can let',
  'allowed to',
  'do not have to',
  "don't have to",
  'it is okay',
  "it's okay",
  'may be',
  'might',
  'want to',
  'choose to',
  'i care about',
  'matters to me',
  'part of me',
];

const MYSTICAL = [
  'universe',
  'cosmos',
  'cosmic',
  'manifest',
  'manifesting',
  'manifestation',
  'abundance',
  'vibration',
  'vibrations',
  'frequency of',
  'energy field',
  'law of attraction',
  'divine',
  'aura',
  'chakra',
  'chakras',
  'higher self',
  'the source',
  'attract wealth',
  'attract money',
  'prosperity',
  'millionaire',
  'six figures',
  'destined',
  'destiny',
  'blessed with riches',
];

const SUPERLATIVES = [
  'always',
  'never',
  'every single',
  'completely',
  'totally',
  'absolutely',
  'perfectly',
  'forever',
  'unlimited',
  'infinite',
  'best',
  'greatest',
  'most powerful',
  'no matter what',
  'nothing can stop',
  'all of my',
  'any and all',
];

/** Shame / absolutist language forbidden on addiction and mental-health goals (§7). */
const SENSITIVE_BANNED = [
  'never again',
  'clean and sober',
  'stay clean',
  'dirty',
  'weak',
  'weakness',
  'willpower',
  'failure',
  'failed',
  'relapse',
  'give in',
  'gave in',
  'ashamed',
  'shame',
  'disgusting',
  'addict',
  'junkie',
  'broken beyond',
  'cured',
  'quit forever',
];

function firstMatch(text: string, needles: string[]): string | null {
  const lower = text.toLowerCase();
  for (const n of needles) {
    const i = lower.indexOf(n);
    if (i >= 0) {
      // Word-boundary check so "strong" does not fire inside "stronghold".
      const before = i === 0 ? ' ' : lower[i - 1];
      const after = lower[i + n.length] ?? ' ';
      if (!/[a-z]/.test(before) && !/[a-z]/.test(after)) return text.slice(i, i + n.length);
    }
  }
  return null;
}

function hasProcessMarker(text: string): boolean {
  return firstMatch(text, PROCESS_MARKERS) !== null;
}

export const RULES: Rule[] = [
  {
    id: 'absolute-trait',
    severity: 'error',
    why: '§1 Wood et al. 2009 — absolute trait claims recruit counter-evidence and lower mood in exactly the listener who needs them.',
    test: (line) => {
      // "I am <trait>" / "I'm <trait>" with nothing hedging it.
      const m = /\b(i am|i'm)\b([^.!?]*)/i.exec(line.text);
      if (!m) return null;
      const tail = m[2];
      if (hasProcessMarker(m[0])) return null;
      const hit = firstMatch(tail, TRAIT_WORDS);
      return hit ? `${m[1]}${tail.slice(0, 40)}` : null;
    },
  },
  {
    id: 'mystical',
    severity: 'error',
    why: '§Rules — wealth/manifestation/cosmic framing has no evidence base and maximises contrast harm.',
    test: (line) => firstMatch(line.text, MYSTICAL),
  },
  {
    id: 'superlative',
    severity: 'error',
    why: '§1 — magnitude of the claim scales the counter-evidence it recruits.',
    test: (line) => firstMatch(line.text, SUPERLATIVES),
  },
  {
    id: 'second-person',
    severity: 'error',
    why: 'Brief §2 — everything is first person. Second person turns the track into instruction.',
    test: (line) => {
      const m = /\b(you|your|you're|yours|yourself)\b/i.exec(line.text);
      return m ? m[0] : null;
    },
  },
  {
    id: 'exclamation',
    severity: 'error',
    why: 'Brief §2 — no hype or exclamation energy; also violates the monotonic-descent constraint.',
    test: (line) => (line.text.includes('!') ? '!' : null),
  },
  {
    id: 'question',
    severity: 'error',
    why: '§9a — interrogatives are motivating when awake but arousing at sleep onset. They belong in intake, not the track.',
    test: (line) => (line.text.includes('?') ? '?' : null),
  },
  {
    id: 'interrogative',
    severity: 'error',
    why: '§9a — interrogative self-talk ("Will I…") outperforms declarative when awake and pre-task, which is why it is used in intake. In the track it requests cognitive work at the exact moment arousal is the enemy. Punctuation is not the test; the grammatical form is.',
    test: (line) => {
      const m = /(^|[.;]\s+)(will i|can i|do i|am i|should i|could i|what if i|why do i|how do i)\b/i.exec(
        line.text,
      );
      return m ? m[2] : null;
    },
  },
  {
    id: 'low-belief-absolute',
    severity: 'error',
    why: '§2 — a goal rated below 4 is outside the latitude of acceptance; only process, compassion, values or intention framings are permitted.',
    test: (line, ctx) => {
      if (!ctx.goal || ctx.goal.believability >= 4) return null;
      const allowed: Pattern[] = ['process', 'compassion', 'values', 'intention', 'ambivalence'];
      if (allowed.includes(line.pattern)) return null;
      return `pattern "${line.pattern}" at believability ${ctx.goal.believability}`;
    },
  },
  {
    id: 'sensitive-shame',
    severity: 'error',
    why: '§7 — shame and absolutist framing on addiction/mental-health goals predicts the abstinence-violation effect.',
    test: (line, ctx) => (ctx.goal?.sensitive ? firstMatch(line.text, SENSITIVE_BANNED) : null),
  },
  {
    id: 'intention-needs-cue',
    severity: 'error',
    why: '§4 — an implementation intention without a concrete cue is just an intention, and loses the d=0.65 effect.',
    test: (line) => {
      if (line.pattern !== 'intention') return null;
      const hasCue = /\b(when|if|as soon as|before|after|the moment)\b/i.test(line.text);
      return hasCue ? null : 'no when/if cue';
    },
  },
  {
    id: 'too-long',
    severity: 'warn',
    why: '§10 — long sentences force breath support, which raises energy. Short falling sentences hold the arc.',
    test: (line) => {
      const words = line.text.trim().split(/\s+/).length;
      return words > 26 ? `${words} words` : null;
    },
  },
  {
    id: 'unsupported-tag',
    severity: 'warn',
    why: 'docs/GEMINI-TTS.md §7 — only a few audio tags lower energy; the rest raise it.',
    test: (line) => {
      const m = /\[([^\]]+)\]/.exec(line.text);
      if (!m) return null;
      const ok = ['whispers', 'tired', 'very slow', 'softly'];
      return ok.includes(m[1].toLowerCase()) ? null : m[0];
    },
  },
];

export function validateLine(line: Line, goal?: Goal): ValidationIssue[] {
  const ctx: Ctx = { goal };
  const issues: ValidationIssue[] = [];
  for (const rule of RULES) {
    const match = rule.test(line, ctx);
    if (match) {
      issues.push({
        lineId: line.id,
        rule: rule.id,
        severity: rule.severity,
        message: rule.why,
        match,
      });
    }
  }
  return issues;
}

export function validateScript(lines: Line[], goals: Goal[]): ValidationIssue[] {
  const byId = new Map(goals.map((g) => [g.id, g]));
  return lines.flatMap((l) => validateLine(l, l.goalId ? byId.get(l.goalId) : undefined));
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
