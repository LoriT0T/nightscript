import { API_REVISION, ENDPOINT, TTS_MODEL } from '@/lib/gemini/client';
import { extractAudioBase64, parseSse } from '@/lib/gemini/stream';
import { buildInput } from '@/lib/gemini/style';
import type { Section } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Speak one chunk.
 *
 * A thin streaming proxy: Gemini's SSE goes in, raw 24 kHz mono s16le PCM comes out, and
 * the browser does everything else. The API key stays on this side and the listener's text
 * is never written anywhere — it exists only for the life of the request.
 *
 * Streaming is required, not preferred. See docs/GEMINI-TTS.md §6 and src/lib/gemini/stream.ts.
 */
export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return Response.json({ error: 'Server is missing GEMINI_API_KEY.' }, { status: 503 });
  }

  let section: Section;
  let text: string;
  let voice: string;
  let model: string;
  try {
    const body = (await req.json()) as {
      section: Section;
      text: string;
      voice: string;
      model?: string;
    };
    section = body.section;
    text = body.text;
    voice = body.voice;
    model = body.model || TTS_MODEL;
    if (!text?.trim() || !voice) throw new Error('missing text or voice');
  } catch {
    return Response.json({ error: 'Bad request.' }, { status: 400 });
  }

  const upstream = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'Content-Type': 'application/json',
      'Api-Revision': API_REVISION,
    },
    body: JSON.stringify({
      model,
      input: buildInput(section, text),
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    let message = `Upstream error ${upstream.status}`;
    try {
      message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* keep the generic message */
    }
    return Response.json({ error: message }, { status: upstream.status });
  }

  const body = upstream.body;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of parseSse(body)) {
          for (const b64 of extractAudioBase64(event)) {
            controller.enqueue(new Uint8Array(Buffer.from(b64, 'base64')));
          }
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    headers: {
      // Raw PCM. The browser knows the format because we chose it; there is no header to
      // parse and no decode step, which keeps assembly exact.
      'Content-Type': 'audio/l16; rate=24000; channels=1',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
