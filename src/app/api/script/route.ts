import { generateScript } from '@/lib/gemini/script';
import { validateScript } from '@/lib/affirmations/validator';
import type { Intake } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Write a script from an intake.
 *
 * Emits NDJSON and sends its first line immediately. Writing a full script takes ~60 s
 * upstream, which exceeds the time-to-first-byte budget of every serverless host; streaming
 * a heartbeat from the outset keeps the response alive and gives the browser something to
 * show. The result arrives as the final line.
 *
 * Stateless: the intake is used to build one prompt and is not written anywhere.
 */
export async function POST(req: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: 'Server is missing GEMINI_API_KEY.' }, { status: 503 });
  }

  const { intake, minutes } = (await req.json()) as { intake: Intake; minutes?: number };
  if (!intake?.goals?.length) {
    return Response.json({ error: 'No goals provided.' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(o)}\n`));
      send({ type: 'progress', message: 'Writing the script…' });

      // Something must keep flowing while the model thinks, or intermediaries decide the
      // response has stalled and cut it.
      const beat = setInterval(() => send({ type: 'progress', message: 'Still writing…' }), 5000);

      try {
        const result = await generateScript(intake, minutes ?? 60);
        clearInterval(beat);
        send({
          type: 'result',
          script: result.script,
          repairedCount: result.repairedCount,
          droppedCount: result.droppedCount,
          issues: validateScript(result.script.lines, intake.goals),
        });
      } catch (e) {
        clearInterval(beat);
        send({ type: 'error', error: (e as Error).message });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
