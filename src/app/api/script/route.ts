import { checkAccess } from '@/lib/access';
import { generateSectionLines, repairLine } from '@/lib/gemini/script';
import { validateScript } from '@/lib/affirmations/validator';
import type { Intake, Line, Section } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const SECTIONS = new Set<Section>(['arrival', 'downshift', 'core', 'second', 'dissolution']);

/**
 * One batch of script lines, or one repaired line.
 *
 * Hard constraint: **the host kills this function at 30 seconds.** Measured precisely — an
 * `arrival` batch died at 30.7 s while a `dissolution` batch of the same shape returned at
 * 24.1 s. Streaming does not help; the whole-script version streamed heartbeats for 30.8 s
 * and was killed mid-flight. So the rule is that no request may contain more than one model
 * round-trip, and batches are kept small enough that one round-trip is comfortably inside
 * the budget. The browser fans out across many of these.
 *
 * Stateless: the intake builds a prompt and is not written anywhere.
 */
export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;

  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: 'Server is missing GEMINI_API_KEY.' }, { status: 503 });
  }

  const body = (await req.json()) as {
    intake: Intake;
    minutes?: number;
    section?: Section;
    lineCount?: number;
    variantNote?: string;
    /** Set for a repair request instead of a generation request. */
    repair?: { line: Line; problems: string[] };
  };

  if (!body.intake?.goals?.length) {
    return Response.json({ error: 'No goals provided.' }, { status: 400 });
  }

  try {
    if (body.repair) {
      const fixed = await repairLine(body.intake, body.repair.line, body.repair.problems);
      return Response.json({ line: fixed });
    }

    if (!body.section || !SECTIONS.has(body.section)) {
      return Response.json({ error: `Unknown section "${body.section}".` }, { status: 400 });
    }

    const lines = await generateSectionLines(
      body.intake,
      body.minutes ?? 60,
      body.section,
      body.lineCount,
      body.variantNote,
    );
    return Response.json({
      lines,
      issues: validateScript(lines, body.intake.goals),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
