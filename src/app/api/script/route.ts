import { checkAccess } from '@/lib/access';
import { generateSection } from '@/lib/gemini/script';
import type { Intake, Section } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const SECTIONS = new Set<Section>(['arrival', 'downshift', 'core', 'second', 'dissolution']);

/**
 * Write ONE section of a script.
 *
 * The whole script in one request took ~60 s and the host killed the function at ~30 s —
 * verified in production, where the response streamed six heartbeats and then died with no
 * result. Sections are independent, so the browser asks for all five at once and each
 * returns in 10-25 s.
 *
 * Stateless: the intake builds a prompt and is not written anywhere.
 */
export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;

  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: 'Server is missing GEMINI_API_KEY.' }, { status: 503 });
  }

  const { intake, minutes, section } = (await req.json()) as {
    intake: Intake;
    minutes?: number;
    section: Section;
  };
  if (!intake?.goals?.length) {
    return Response.json({ error: 'No goals provided.' }, { status: 400 });
  }
  if (!SECTIONS.has(section)) {
    return Response.json({ error: `Unknown section "${section}".` }, { status: 400 });
  }

  try {
    const result = await generateSection(intake, minutes ?? 60, section);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
