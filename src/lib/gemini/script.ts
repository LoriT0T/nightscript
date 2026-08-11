import { callInteractions, TEXT_MODEL, withRetry } from './client';
import { validateScript } from '@/lib/affirmations/validator';
import { targetLineCounts } from '@/lib/script/plan';
import type { Goal, Intake, Line, Pattern, Section } from '@/lib/types';

/**
 * Script generation.
 *
 * The prompt below is the single most load-bearing artifact in this project: it is where
 * docs/AFFIRMATION-DESIGN.md becomes text. The validator is the backstop, not the plan —
 * anything the validator has to reject is a prompt failure first.
 */

function goalBlock(g: Goal, i: number): string {
  const belief =
    g.believability < 4
      ? `${g.believability}/10 — LOW. This goal is outside their latitude of acceptance. ` +
        `Absolutely no present-tense state claims for it. Only process, self-compassion, ` +
        `values, implementation-intention, or permitted-ambivalence framings.`
      : g.believability <= 6
        ? `${g.believability}/10 — MIDDLING. Lean on process and evidence framings; a mild ` +
          `present-tense claim is allowed only when it is anchored to their evidence below.`
        : `${g.believability}/10 — HIGH. Stronger framings are safe here, but still never absolute.`;

  return [
    `GOAL ${i + 1} (id: ${g.id}, share of track: ${g.weight})`,
    `  In their words: ${g.text}`,
    `  Why it matters to them (use for VALUES lines): ${g.why}`,
    `  What gets in the way (use for IMPLEMENTATION INTENTION cues): ${g.obstacle}`,
    `  A time they handled it well (use verbatim detail for EVIDENCE lines): ${g.evidence}`,
    `  Believability: ${belief}`,
    g.sensitive
      ? `  ⚠ SENSITIVE (addiction / mental health). Urge-surfing and implementation-intention ` +
        `framing only. Never shame. Never "never again" or any permanent-abstinence absolute. ` +
        `Never imply a lapse is failure. Do not use the words: relapse, clean, dirty, weak, ` +
        `willpower, failure, addict, ashamed.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Per-section prompts.
 *
 * The whole script used to be written in one call. That call takes about 60 s, and the host
 * kills a serverless function at ~30 s no matter how diligently it streams — verified in
 * production, where the stream sent six heartbeats and then died without a result. Sections
 * are independent, so five smaller calls run in parallel, each finishing in 10-25 s, and the
 * whole script arrives faster than the single call ever did.
 */
const SECTION_BRIEF: Record<Exclude<Section, 'fade'>, (n: number, uniqueCore: number) => string> = {
  arrival: (n) => `Write ${n} ARRIVAL lines. Settling and breath. Permission to stop listening
and let the words carry on without them. NO goal content at all — goalId must be null for every
line. Short: five to nine words. Patterns: sensory, compassion, ambivalence.`,

  downshift: (n) => `Write ${n} DOWNSHIFT lines: a slow body scan moving jaw, shoulders, arms,
hands, chest, belly, legs, feet. Sensory pattern throughout, goalId null. Five to nine words
each. Name one body part per line and let it soften. Do not repeat a body part.`,

  core: (n) => `Write ${n} CORE lines — the densest section, covering the
goals in proportion to their share. Mix all seven patterns, weighted so that roughly a third are
implementation intentions ("When <specific cue>, I <specific action>") drawn from their stated
obstacles. Every line carries the goalId it serves. Ten to sixteen words.`,

  second: (n) => `Write ${n} SECOND-PASS
lines: a re-voicing of the same ideas as the core section, but softer, shorter and weighted much
more heavily to self-compassion and permitted ambivalence. Not verbatim repeats — the gentler
version of the same thoughts. Seven to eleven words. Carry the goalId.`,

  dissolution: (n) => `Write ${n} DISSOLUTION lines. Fragments, not sentences. Three to six words
each, no full stops needed. Sparse and trailing. goalId null. They should feel like the last
thoughts of the day thinning out. Do NOT use the words "softer now", "still here" or "nothing to
fix tonight" — those are the shape, not the content. Draw the fragments from this listener's own
material where you can.`,
};

/**
 * Default line count a section asks for, before any splitting.
 */
export function sectionLineTarget(minutes: number, section: Section): number {
  const counts = targetLineCounts(minutes);
  if (section === 'core') return uniqueCoreCount(minutes);
  if (section === 'second') {
    return Math.max(4, Math.round(uniqueCoreCount(minutes) * 0.45));
  }
  return counts[section] ?? 20;
}

/**
 * How many unique core affirmations to write.
 *
 * The brief's "40 to 60 core affirmations, cycled three to four times" is a figure for a
 * 60-minute track. Applied as a flat floor it wrecks short ones: a 10-minute track got the
 * same 146 lines as an hour and overran its target by 2:14 with the pauses already
 * compressed to their floor. So the floor scales with the requested length, and the brief's
 * number is what it produces at 60 minutes.
 */
function uniqueCoreCount(minutes: number): number {
  const counts = targetLineCounts(minutes);
  const floor = Math.max(6, Math.round(40 * (minutes / 60)));
  return Math.max(floor, Math.min(60, Math.round(counts.core / 3.5)));
}

export function buildSectionPrompt(
  intake: Intake,
  minutes: number,
  section: Section,
  lineCount?: number,
  variantNote?: string,
): string {
  const uniqueCore = uniqueCoreCount(minutes);
  const brief = SECTION_BRIEF[section as Exclude<Section, 'fade'>];
  const wanted = lineCount ?? sectionLineTarget(minutes, section);

  return `You are writing one section of a ${minutes}-minute affirmation track that one person
will play as they fall asleep. It is read aloud by a single calm female voice. Write only what
she says.

You are writing for THIS person, from THEIR words below. Generic lines are the failure mode.

${intake.goals.map(goalBlock).join('\n\n')}
${intake.note ? `\nExtra context from them: ${intake.note}\n` : ''}

═══ THE RULES. These are not style preferences; they come from the research. ═══

BANNED, without exception:
  • Absolute trait claims the listener will silently contradict. "I am confident."
    "I am successful." "I am free from all cravings." Repeating an unbelievable statement
    measurably LOWERS mood in people who do not already believe it. This is the single most
    important rule.
  • Any wealth, manifestation, universe, cosmic, energy, destiny or mystical framing.
  • Superlatives and absolutes: always, never, completely, totally, perfectly, forever,
    unlimited, no matter what, nothing can stop.
  • Second person. No "you", "your", "yourself". Everything is first person, singular.
  • Exclamation marks. Question marks. Any interrogative phrasing at all ("Will I…", "Am I…").
  • Any line the listener could answer with "no I'm not".

THE PATTERNS. Every line is exactly one of these, and you will label it:
  process      "I am learning to…", "I am building…". Growth underway, never claimed as done.
  evidence     Anchored to something real they told you above, using their actual detail.
  compassion   "I can be kind to myself about this." Makes no claim that can be contradicted.
  values       Affirms what they care about rather than a trait they lack.
  intention    "When <specific cue>, I <specific action>." MUST contain a concrete when/if cue.
               Strongest evidence of anything here (d = 0.65).
  ambivalence  "Part of me resists this, and that part is welcome here too." Protective.
  sensory      "My chest is loose. My jaw is soft." Body-anchored, aids sleep onset.

VOICE: short sentences, every one falling at the end. Plain and sincere. No therapist lilt, no
poetry, no metaphor-stacking, no "journey", "embrace", "radiant", "flow". Contractions fine.
No stage directions, no bracketed tags, no numbering inside the text.

═══ YOUR TASK ═══

${brief(wanted, uniqueCore)}

Write exactly ${wanted} lines.${variantNote ? ` ${variantNote}` : ''}

Return ONLY a JSON object, no prose, no markdown fences:

{"lines":[{"text":"…","pattern":"process","section":"${section}","goalId":"<goal id or null>"}]}

pattern ∈ process|evidence|compassion|values|intention|ambivalence|sensory
Every line must have section "${section}".
goalId must be one of the ids given above, or null.`;
}

const SECTIONS: Section[] = ['arrival', 'downshift', 'core', 'second', 'dissolution'];
const PATTERN_SET = new Set<Pattern>([
  'process',
  'evidence',
  'compassion',
  'values',
  'intention',
  'ambivalence',
  'sensory',
]);

function extractText(json: Record<string, unknown>): string {
  const steps = json.steps as Array<{ content?: Array<Record<string, unknown>> }> | undefined;
  let out = '';
  for (const step of steps ?? []) {
    for (const c of step.content ?? []) {
      if (c.type === 'text' && typeof c.text === 'string') out += c.text;
    }
  }
  return out;
}

/** Models wrap JSON in fences often enough that stripping them is not optional. */
export function parseScriptJson(raw: string, goals: Goal[]): Line[] {
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);

  const parsed = JSON.parse(s) as { lines?: Array<Record<string, unknown>> };
  const goalIds = new Set(goals.map((g) => g.id));

  return (parsed.lines ?? [])
    .map((l, i): Line | null => {
      const text = typeof l.text === 'string' ? l.text.trim() : '';
      if (!text) return null;
      const section = SECTIONS.includes(l.section as Section) ? (l.section as Section) : 'core';
      const pattern = PATTERN_SET.has(l.pattern as Pattern) ? (l.pattern as Pattern) : 'process';
      const rawGoal = typeof l.goalId === 'string' ? l.goalId : null;
      const goalId = rawGoal && goalIds.has(rawGoal) ? rawGoal : null;
      return { id: `l${i}_${Math.random().toString(36).slice(2, 8)}`, text, pattern, section, goalId };
    })
    .filter((l): l is Line => l !== null);
}

async function generateOnce(prompt: string): Promise<string> {
  const json = await withRetry(() =>
    callInteractions({ model: TEXT_MODEL, input: prompt }),
  );
  return extractText(json);
}

export interface GenerateSectionResult {
  lines: Line[];
  repairedCount: number;
  droppedCount: number;
}

/**
 * Generate one batch of lines. NO repair pass.
 *
 * The repair call used to happen here, in the same request. That made a request two model
 * round-trips deep, and the host kills a function at 30 s — measured exactly: an `arrival`
 * request died at 30.7 s while a `dissolution` request survived at 24.1 s. The difference
 * was luck, not size. Repair is now the client's job, one short request per bad line, so no
 * single server call ever contains more than one model round-trip.
 */
export async function generateSectionLines(
  intake: Intake,
  minutes: number,
  section: Section,
  lineCount?: number,
  variantNote?: string,
): Promise<Line[]> {
  const raw = await generateOnce(buildSectionPrompt(intake, minutes, section, lineCount, variantNote));
  // The model occasionally mislabels the section; this call only asked for one.
  return parseScriptJson(raw, intake.goals).map((l) => ({ ...l, section }));
}

/** Rewrite one line that failed validation. Used by the client and by the CLI. */
export async function repairLine(
  intake: Intake,
  line: Line,
  problems: string[],
): Promise<Line | null> {
  const goal = intake.goals.find((g) => g.id === line.goalId);
  const prompt = `Rewrite this line of a sleep affirmation script so it keeps its meaning and its
pattern while fixing the stated problem.

Line: "${line.text}"
Pattern it must keep: ${line.pattern}
Problem: ${problems.join('; ')}
${goal ? `It serves this goal: ${goal.text}. Believability ${goal.believability}/10.${goal.believability < 4 ? ' LOW — no present-tense state claims at all.' : ''}` : ''}
${goal?.sensitive ? 'Addiction / mental-health goal: urge-surfing framing only, no shame, no absolutes.' : ''}

Rules: first person only, no second person, no absolute trait claims, no superlatives
(always, never, completely, perfectly), no questions or interrogative phrasing, no exclamation
marks, no mystical or wealth framing. Short sentence, falling at the end. If the pattern is
"intention" it must contain a concrete "when …" cue.

Return ONLY JSON: {"lines":[{"text":"…","pattern":"${line.pattern}","section":"${line.section}","goalId":${goal ? `"${goal.id}"` : 'null'}}]}`;

  try {
    const parsed = parseScriptJson(await generateOnce(prompt), intake.goals);
    if (!parsed.length) return null;
    const candidate: Line = { ...line, text: parsed[0].text };
    return validateScript([candidate], intake.goals).some((i) => i.severity === 'error')
      ? null
      : candidate;
  } catch {
    return null;
  }
}

/**
 * Whole-script generation for the CLI, which has no 30-second ceiling. The browser takes the
 * parallel path in src/lib/generate.ts instead.
 */
export async function generateSection(
  intake: Intake,
  minutes: number,
  section: Section,
  lineCount?: number,
  variantNote?: string,
): Promise<GenerateSectionResult> {
  let lines = await generateSectionLines(intake, minutes, section, lineCount, variantNote);

  const issues = validateScript(lines, intake.goals).filter((i) => i.severity === 'error');
  const byLine = new Map<string, string[]>();
  for (const i of issues) {
    byLine.set(i.lineId, [...(byLine.get(i.lineId) ?? []), `${i.rule} (matched "${i.match}")`]);
  }

  let repairedCount = 0;
  if (byLine.size > 0) {
    const repaired = await Promise.all(
      lines.map(async (l) => {
        const problems = byLine.get(l.id);
        if (!problems) return l;
        const fixed = await repairLine(intake, l, problems);
        if (fixed) repairedCount++;
        return fixed ?? l;
      }),
    );
    lines = repaired;
  }

  const stillBad = new Set(
    validateScript(lines, intake.goals).filter((i) => i.severity === 'error').map((i) => i.lineId),
  );
  return {
    lines: lines.filter((l) => !stillBad.has(l.id)),
    repairedCount,
    droppedCount: stillBad.size,
  };
}
