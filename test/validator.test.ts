import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLine, validateScript, hasBlockingIssues } from '@/lib/affirmations/validator';
import type { Goal, Line, Pattern, Section } from '@/lib/types';

/**
 * The test set the acceptance criteria asks for: phrasings that MUST be rejected, and a
 * matching set that must survive. The rejects are written to look exactly like the output
 * of every affirmation app that does not read the research.
 */

let n = 0;
const line = (text: string, pattern: Pattern = 'process', section: Section = 'core', goalId: string | null = null): Line => ({
  id: `t${n++}`,
  text,
  pattern,
  section,
  goalId,
});

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1',
  text: 'get up at six',
  why: 'mornings are the only quiet time I get',
  obstacle: 'I snooze four or five times',
  evidence: 'I got up at six every day the week before my exams',
  believability: 6,
  weight: 1,
  sensitive: false,
  ...over,
});

// ---------------------------------------------------------------------------
// MUST REJECT
// ---------------------------------------------------------------------------

const MUST_REJECT: Array<[string, string, Partial<Line>?, Goal?]> = [
  // Absolute trait claims — the core finding (Wood et al. 2009)
  ['I am confident.', 'absolute-trait'],
  ['I am successful in everything I do.', 'absolute-trait'],
  ["I'm strong and disciplined.", 'absolute-trait'],
  ['I am worthy of love.', 'absolute-trait'],
  ['I am a lovable person.', 'absolute-trait'],
  ['I am enough.', 'absolute-trait'],
  ['I am free from all cravings.', 'absolute-trait'],
  ['I am completely healed.', 'superlative'],
  ['I am powerful beyond measure.', 'absolute-trait'],

  // Manifestation / wealth / mystical
  ['The universe is bringing me everything I ask for.', 'mystical'],
  ['I attract wealth effortlessly.', 'mystical'],
  ['I am aligned with abundance.', 'mystical'],
  ['My higher self knows the way.', 'mystical'],
  ['I raise my vibration each night.', 'mystical'],
  ['I am destined for greatness.', 'mystical'],

  // Superlatives and absolutes
  ['I always finish what I start.', 'superlative'],
  ['I never give up on myself.', 'superlative'],
  ['Nothing can stop me now.', 'superlative'],
  ['I handle everything perfectly.', 'superlative'],
  ['I will be calm no matter what.', 'superlative'],

  // Second person
  ['You are safe now.', 'second-person'],
  ['Let your shoulders drop.', 'second-person'],
  ['Your breath is slowing down.', 'second-person'],

  // Hype and interrogation
  ['I am unstoppable!', 'exclamation'],
  // Interrogative form without a question mark — §9a. Motivating when awake, arousing at 3am.
  ['Will I get up at six tomorrow.', 'interrogative'],
  ['Am I the kind of person who follows through.', 'interrogative'],
  ['What kind of person do I want to be?', 'question'],

  // Implementation intention with no cue
  ['I put my feet on the floor.', 'intention-needs-cue', { pattern: 'intention' }],

  // Low-belief goal getting a non-permitted framing
  [
    'I got up at six last week, so I can do it tomorrow.',
    'low-belief-absolute',
    { pattern: 'evidence', goalId: 'g1' },
    goal({ believability: 2 }),
  ],

  // Sensitive-goal shame and absolutes
  ['I will never again reach for it.', 'superlative', { goalId: 'g1' }, goal({ sensitive: true })],
  ['I am done being weak about this.', 'sensitive-shame', { goalId: 'g1' }, goal({ sensitive: true })],
  ['A relapse would mean I failed.', 'sensitive-shame', { goalId: 'g1' }, goal({ sensitive: true })],
  ['My willpower is stronger than the urge.', 'sensitive-shame', { goalId: 'g1' }, goal({ sensitive: true })],
];

test('rejects banned phrasings', () => {
  const missed: string[] = [];
  for (const [text, expectedRule, over, g] of MUST_REJECT) {
    const l = { ...line(text), ...over };
    const issues = validateLine(l, g);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length === 0) {
      missed.push(`NOT CAUGHT AT ALL: "${text}"`);
      continue;
    }
    if (!errors.some((e) => e.rule === expectedRule)) {
      missed.push(
        `"${text}" — expected ${expectedRule}, got ${errors.map((e) => e.rule).join(',')}`,
      );
    }
  }
  assert.deepEqual(missed, [], `\n${missed.join('\n')}`);
});

test('every banned phrasing blocks generation', () => {
  for (const [text, , over, g] of MUST_REJECT) {
    const l = { ...line(text), ...over };
    assert.ok(hasBlockingIssues(validateLine(l, g)), `should block: "${text}"`);
  }
});

// ---------------------------------------------------------------------------
// MUST PASS — the seven sanctioned patterns, written properly
// ---------------------------------------------------------------------------

const MUST_PASS: Array<[string, Pattern, Goal?]> = [
  ['I am learning to get out of bed a little sooner.', 'process'],
  ['I am building the habit one morning at a time.', 'process'],
  ['I got up at six every day the week before my exams. I have done this before.', 'evidence'],
  ['I can be kind to myself about this.', 'compassion'],
  ['Struggling with mornings does not make me broken.', 'compassion'],
  ['I care about being someone my people can rely on.', 'values'],
  ['When the alarm goes at six, I put my feet on the floor.', 'intention'],
  ['When the urge comes, I let it rise and pass without acting on it.', 'intention'],
  ['Part of me resists this, and that part is welcome here too.', 'ambivalence'],
  ['My chest is loose. My jaw is soft.', 'sensory'],
  ['My hands are heavy on the sheet.', 'sensory'],
  // Low-belief goal with permitted framings
  ['I am learning to be steadier in the mornings.', 'process', goal({ believability: 2 })],
  ['I can be gentle with myself about the mornings.', 'compassion', goal({ believability: 1 })],
  // Sensitive goal, urge-surfing framing
  [
    'When the craving rises, I notice it and let it move through.',
    'intention',
    goal({ sensitive: true }),
  ],
  ['A hard night does not undo the work.', 'compassion', goal({ sensitive: true })],
];

test('accepts properly written affirmations', () => {
  const wrong: string[] = [];
  for (const [text, pattern, g] of MUST_PASS) {
    const l = line(text, pattern, 'core', g ? g.id : null);
    const errors = validateLine(l, g).filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      wrong.push(`"${text}" wrongly rejected by ${errors.map((e) => e.rule).join(',')}`);
    }
  }
  assert.deepEqual(wrong, [], `\n${wrong.join('\n')}`);
});

test('validateScript maps goals to their lines', () => {
  const g = goal({ believability: 2 });
  const lines = [
    line('I am learning to get up sooner.', 'process', 'core', 'g1'),
    line('I got up at six before, so I am a morning person now.', 'evidence', 'core', 'g1'),
  ];
  const issues = validateScript(lines, [g]);
  assert.ok(issues.some((i) => i.rule === 'low-belief-absolute'));
  assert.ok(!issues.some((i) => i.lineId === lines[0].id && i.severity === 'error'));
});
