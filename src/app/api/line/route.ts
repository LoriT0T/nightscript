import { callInteractions, TEXT_MODEL, withRetry } from '@/lib/gemini/client';
import { parseScriptJson } from '@/lib/gemini/script';
import { validateLine } from '@/lib/affirmations/validator';
import type { Goal, Line } from '@/lib/types';

export const runtime = 'nodejs';

/** Regenerate one line in place, keeping its section and pattern. */
export async function POST(req: Request) {
  try {
    const { line, goal, instruction } = (await req.json()) as {
      line: Line;
      goal?: Goal;
      instruction?: string;
    };

    const prompt = `Rewrite this single line of a sleep affirmation script.

Current line: "${line.text}"
Section: ${line.section}
Pattern it must keep: ${line.pattern}
${goal ? `It serves this goal: ${goal.text}\nWhy it matters: ${goal.why}\nWhat gets in the way: ${goal.obstacle}\nA time they handled it: ${goal.evidence}\nBelievability: ${goal.believability}/10${goal.believability < 4 ? ' — LOW, so no present-tense state claims at all' : ''}` : ''}
${goal?.sensitive ? 'This is an addiction / mental-health goal: urge-surfing framing only, no shame, no absolutes, no "never again".' : ''}
${instruction ? `What they want changed: ${instruction}` : 'Give a different wording of the same idea.'}

Rules: first person only, no second person, no absolute trait claims ("I am confident"), no
superlatives (always, never, completely, perfectly), no questions, no exclamation marks, no
mystical or wealth framing. Short sentence, falls at the end. If the pattern is "intention" it
must contain a concrete "when …" cue.

Return ONLY JSON: {"lines":[{"text":"…","pattern":"${line.pattern}","section":"${line.section}","goalId":${goal ? `"${goal.id}"` : 'null'}}]}`;

    const json = await withRetry(() => callInteractions({ model: TEXT_MODEL, input: prompt }));
    const steps = json.steps as Array<{ content?: Array<Record<string, unknown>> }> | undefined;
    let text = '';
    for (const s of steps ?? []) {
      for (const c of s.content ?? []) if (c.type === 'text' && typeof c.text === 'string') text += c.text;
    }

    const parsed = parseScriptJson(text, goal ? [goal] : []);
    if (!parsed.length) return Response.json({ error: 'Model returned nothing usable.' }, { status: 502 });

    const candidate: Line = { ...line, text: parsed[0].text };
    const issues = validateLine(candidate, goal);
    return Response.json({ line: candidate, issues });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
