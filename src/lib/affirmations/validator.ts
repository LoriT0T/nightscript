import type { Goal, Line, Pattern, ValidationIssue, WritingStyle } from '@/lib/types';

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
  /**
   * Which writing styles this rule applies to. Rules about harm apply to both; rules that
   * encode the process style's taste apply only to it. See docs/AFFIRMATION-STYLE.md §4.
   */
  styles?: WritingStyle[];
  /** Return the offending substring, or null if the line is fine. */
  test: (line: Line, ctx: Ctx) => string | null;
}

interface Ctx {
  goal?: Goal;
  /** Every goal, for relevance checking — a line may legitimately reference any of them. */
  goals?: Goal[];
  style: WritingStyle;
}

/** Always on-topic regardless of the goal wording. */
const UNIVERSAL_WORDS = [
  'grateful','thankful','proud','calm','steady','strong','stronger','strength','myself','promise',
  'promises','showing','again','today','tomorrow','morning','week','earned','trust','capable','able',
  'enough','feels','feel','life','living','future','person','someone','people','depend','rely',
];

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

/**
 * Body-sensation vocabulary. Banned outright in the scripting style — the listener wants
 * affirmations, not guided relaxation, and lines like "my shoulders sink into the mattress"
 * are the latter wearing the former's grammar.
 */
const BODY_PARTS = [
  'jaw','face','forehead','eyes','eyelids','neck','shoulder','shoulders','arm','arms','elbow',
  'hand','hands','finger','fingers','chest','ribs','stomach','belly','back','spine','hip','hips',
  'thigh','thighs','knee','knees','calf','calves','leg','legs','ankle','ankles','foot','feet','toes',
  'breath','breathing','lungs','muscles','body','limbs','head','scalp','tongue','teeth',
];
const SENSATION_VERBS = [
  'sink','sinks','sinking','soften','softens','softening','relax','relaxes','relaxing','loosen',
  'loosens','loosening','heavy','heavier','warm','warmer','melt','melts','melting','rest','rests',
  'resting','settle','settles','settling','drop','drops','dropping','release','releases','releasing',
  'still','quiet','limp','slack','unclench','unclenches','sag','sags','float','floats','floating',
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
    styles: ['process'],
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
    styles: ['process'],
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
    styles: ['process'],
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
    id: 'body-sensation',
    severity: 'error',
    styles: ['scripting'],
    why: 'style §2b — this is a guided-relaxation line, not an affirmation. The listener asked for affirmations only: no body scans, no "my shoulders sink into the bed", no instructions to notice a sensation.',
    test: (line) => {
      const t = line.text.toLowerCase();
      const part = BODY_PARTS.find((b) => new RegExp(`\\b${b}\\b`).test(t));
      if (!part) return null;
      const verb = SENSATION_VERBS.find((v) => new RegExp(`\\b${v}\\b`).test(t));
      return verb ? `${part} … ${verb}` : null;
    },
  },
  {
    id: 'not-an-affirmation',
    severity: 'error',
    styles: ['scripting'],
    why: 'style §2c — every line must be a first-person affirmation. Scene-setting and stray imagery ("chrome catching the sun", "fresh rubber on open road") describe a picture rather than assert anything about the listener, and read as filler.',
    test: (line) => {
      // A first-person SUBJECT, not merely a possessive: "cold steel on my palms" has "my"
      // and is still just a photograph. "It feels…" is the one subjectless form the style
      // actually uses, and it is a statement about the listener's state, so it counts.
      if (/\b(i|i'm|i've|me)\b/i.test(line.text)) return null;
      if (/\bit (feels|felt|is|'s)\b/i.test(line.text)) return null;
      return 'no first-person subject';
    },
  },
  {
    id: 'off-topic',
    severity: 'warn',
    styles: ['scripting'],
    why: 'style §2c — the line shares no vocabulary with any stated goal, so it is probably generic filler rather than something about this listener.',
    test: (line, ctx) => {
      if (!ctx.goals || ctx.goals.length === 0) return null;
      const words = new Set(
        line.text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4),
      );
      if (words.size === 0) return null;
      // Vocabulary the listener supplied, plus the forms that are universally on-topic.
      const corpus = new Set<string>(UNIVERSAL_WORDS);
      for (const g of ctx.goals) {
        for (const field of [g.text, g.why, g.obstacle, g.evidence]) {
          for (const w of field.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
            if (w.length >= 4) corpus.add(w);
          }
        }
      }
      for (const w of words) {
        if (corpus.has(w)) return null;
        // crude stem match so "training"/"trained"/"trains" all count as "train"
        for (const c of corpus) {
          if (c.length >= 5 && (w.startsWith(c.slice(0, 5)) || c.startsWith(w.slice(0, 5)))) return null;
        }
      }
      return 'nothing in common with any goal';
    },
  },
  {
    id: 'too-long',
    severity: 'error',
    why: 'design §10 — long sentences force breath support, which raises energy. Short falling sentences hold the arc.',
    test: (line, ctx) => {
      const words = line.text.trim().split(/\s+/).length;
      // The reference tracks sit at a median of 9 words and a 90th percentile of 14
      // (style §2), so scripting lines are held much tighter than process ones. This is an
      // error rather than a warning because as a warning it shipped a 22-word line.
      const cap = ctx.style === 'scripting' ? 16 : 26;
      return words > cap ? `${words} words` : null;
    },
  },
  {
    id: 'future-tense',
    severity: 'warn',
    styles: ['scripting'],
    why: 'style §2 — the reference has essentially no "I will". The scripting voice describes the life in the present rather than promising it, so future tense breaks the form.',
    test: (line) => {
      // "I will" inside an implementation intention is the one legitimate use.
      if (line.pattern === 'intention') return null;
      const m = /\b(i will|i'll|one day|someday|i am going to|i'm going to)\b/i.exec(line.text);
      return m ? m[0] : null;
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

export function validateLine(
  line: Line,
  goal?: Goal,
  style: WritingStyle = 'scripting',
  goals?: Goal[],
): ValidationIssue[] {
  const ctx: Ctx = { goal, goals: goals ?? (goal ? [goal] : undefined), style };
  const issues: ValidationIssue[] = [];
  for (const rule of RULES) {
    if (rule.styles && !rule.styles.includes(style)) continue;
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

export function validateScript(
  lines: Line[],
  goals: Goal[],
  style: WritingStyle = 'scripting',
): ValidationIssue[] {
  const byId = new Map(goals.map((g) => [g.id, g]));
  return lines.flatMap((l) =>
    validateLine(l, l.goalId ? byId.get(l.goalId) : undefined, style, goals),
  );
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
