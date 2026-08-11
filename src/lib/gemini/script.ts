import { callInteractions, TEXT_MODEL, withRetry } from './client';
import { validateScript } from '@/lib/affirmations/validator';
import { targetLineCounts } from '@/lib/script/plan';
import type { Goal, Intake, Line, Pattern, Script, Section } from '@/lib/types';

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

export function buildScriptPrompt(intake: Intake, minutes: number): string {
  const counts = targetLineCounts(minutes);
  const uniqueCore = Math.max(40, Math.min(60, Math.round(counts.core / 3.5)));

  return `You are writing the script for a ${minutes}-minute affirmation track that one person
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
  • Exclamation marks. Question marks. Hype of any kind.
  • Any line the listener could answer with "no I'm not".

REQUIRED PATTERNS. Every line is exactly one of these, and you will label it:
  process      "I am learning to…", "I am building…", "Each day a little more…"
               Growth underway, never growth claimed as finished.
  evidence     Anchored to something real they told you above. "I got up at six on the
               Tuesday it rained. I can do that again." Use their actual detail.
  compassion   "I can be kind to myself about this." "Struggling with this does not make me
               broken." Makes no claim about ability, so nothing can contradict it.
  values       Affirms what they care about rather than a trait they lack. "I care about
               being someone my people can rely on."
  intention    "When <specific cue>, I <specific action>." MUST contain a concrete when/if
               cue drawn from their stated obstacle. These have the strongest evidence of
               any element here (d = 0.65). Make them the most common pattern in the core
               section — roughly a third of core lines.
  ambivalence  "Part of me resists this, and that part is welcome here too." Allowing the
               contradicting thought outperforms suppressing it. Include these regularly;
               they are protective, not decorative.
  sensory      "My chest is loose. My jaw is soft." Body-anchored, aids sleep onset.

VOICE AND SHAPE:
  • Short sentences. Under 20 words, most much shorter. Every sentence must fall at the end.
  • Plain and sincere. No therapist lilt, no poetry, no metaphor-stacking, no "journey",
    no "embrace", no "radiant", no "flow".
  • Contractions are fine. Ordinary words only.
  • No stage directions, no tags in brackets, no speaker names, no numbering in the text.

═══ THE STRUCTURE ═══

Return these sections, with roughly these line counts:

  arrival      ${counts.arrival} lines. Settling and breath. Permission to stop listening and let
               the words carry on without them. NO goal content at all. goalId must be null.
  downshift    ${counts.downshift} lines. A slow body scan: jaw, shoulders, hands, belly, legs, feet.
               Sensory pattern throughout. goalId null.
  core         ${uniqueCore} UNIQUE lines. The densest section, covering the goals in
               proportion to their share. Mix all seven patterns, weighted to intention.
               Each line carries the goalId it serves.
  second       ${Math.max(12, Math.round(uniqueCore * 0.45))} lines. A re-voicing of the core
               material: same ideas, softer wording, shorter, weighted much more heavily to
               compassion and ambivalence. Do not simply repeat the core lines verbatim —
               these are the gentler versions of them.
  dissolution  ${counts.dissolution} lines. Fragments, not sentences. Three to six words.
               "Softer now." "Still here." "Nothing to fix tonight." Sparse and trailing.

Do NOT write a fade section; it is silence.

═══ OUTPUT ═══

Return ONLY a JSON object, no prose, no markdown fences:

{"lines":[{"text":"…","pattern":"process","section":"core","goalId":"<goal id or null>"}]}

pattern ∈ process|evidence|compassion|values|intention|ambivalence|sensory
section ∈ arrival|downshift|core|second|dissolution
goalId must be one of the ids given above, or null for arrival/downshift.`;
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

export interface GenerateScriptResult {
  script: Script;
  /** Lines the model produced that failed validation and were dropped or repaired. */
  repairedCount: number;
  droppedCount: number;
}

/**
 * Generate, validate, and make ONE repair pass over the failures. Anything still failing
 * after the repair pass is dropped rather than shipped — at 3–4 repetitions per line, one
 * bad line is heard a dozen times (docs/AFFIRMATION-DESIGN.md §9c).
 */
export async function generateScript(
  intake: Intake,
  minutes: number,
  opts: { cycles?: number } = {},
): Promise<GenerateScriptResult> {
  const prompt = buildScriptPrompt(intake, minutes);
  let lines = parseScriptJson(await generateOnce(prompt), intake.goals);

  let repairedCount = 0;
  let droppedCount = 0;

  const issues = validateScript(lines, intake.goals);
  const badIds = new Set(issues.filter((i) => i.severity === 'error').map((i) => i.lineId));

  if (badIds.size > 0) {
    const bad = lines.filter((l) => badIds.has(l.id));
    const byLine = new Map<string, string[]>();
    for (const i of issues.filter((x) => x.severity === 'error')) {
      byLine.set(i.lineId, [...(byLine.get(i.lineId) ?? []), `${i.rule} (matched "${i.match}")`]);
    }

    const repairPrompt = `These lines from an affirmation script broke the rules. Rewrite each one
to keep its meaning, its section and its pattern, while fixing the stated problem. Same rules as
before: first person only, no absolute trait claims, no superlatives, no second person, no
questions, no exclamation marks, no mystical or wealth framing. Implementation-intention lines
must contain a concrete "when …" cue.

${bad.map((l, i) => `${i + 1}. [${l.section}/${l.pattern}] "${l.text}"\n   PROBLEM: ${(byLine.get(l.id) ?? []).join('; ')}`).join('\n')}

Return ONLY JSON: {"lines":[{"text":"…","pattern":"…","section":"…","goalId":"…"}]} in the same
order, one replacement per input line.`;

    try {
      const replacements = parseScriptJson(await generateOnce(repairPrompt), intake.goals);
      lines = lines.map((l) => {
        if (!badIds.has(l.id)) return l;
        const idx = bad.findIndex((b) => b.id === l.id);
        const rep = replacements[idx];
        if (!rep) return l;
        const candidate: Line = { ...l, text: rep.text };
        if (validateScript([candidate], intake.goals).some((i) => i.severity === 'error')) return l;
        repairedCount++;
        return candidate;
      });
    } catch {
      // Repair pass failed entirely; fall through to dropping.
    }

    const stillBad = new Set(
      validateScript(lines, intake.goals)
        .filter((i) => i.severity === 'error')
        .map((i) => i.lineId),
    );
    droppedCount = stillBad.size;
    lines = lines.filter((l) => !stillBad.has(l.id));
  }

  return {
    script: { lines, cycles: opts.cycles ?? 1 },
    repairedCount,
    droppedCount,
  };
}
