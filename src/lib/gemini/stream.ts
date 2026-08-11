/**
 * Streaming transport for the Interactions API.
 *
 * Streaming is not an optimisation here, it is what makes the app hostable at all.
 * Measured on 2026-08-11 for one 152-word chunk:
 *
 *            time to first byte     total
 *   normal          46.9 s          46.9 s
 *   streamed         0.7 s          13.6 s
 *
 * Serverless hosts cap how long a function may take to *begin* responding. At 47 s a
 * non-streamed chunk cannot be proxied by any of them. At 0.7 s it can, and the whole
 * request is also 3.4x faster. Every route that talks to Gemini streams.
 */

export interface SseEvent {
  event_type?: string;
  [k: string]: unknown;
}

/** Parse an SSE byte stream into events. Tolerates chunk boundaries mid-event. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload) as SseEvent;
        } catch {
          // A malformed frame is not worth aborting a 40-minute generation over.
        }
      }
    }
  }
}

/**
 * Pull base64 audio out of an event.
 *
 * Deliberately structure-agnostic: it walks the event and collects any string `data`
 * field that sits next to an audio-ish marker. The documented response shape for the
 * non-streaming call was already wrong once (docs/GEMINI-TTS.md §4), so this does not
 * assume `delta.data` is where the bytes live.
 */
export function extractAudioBase64(event: SseEvent): string[] {
  const out: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;

    const looksAudio =
      o.type === 'audio' ||
      (typeof o.mime_type === 'string' && o.mime_type.toLowerCase().includes('audio')) ||
      typeof o.sample_rate === 'number';

    if (looksAudio && typeof o.data === 'string' && o.data.length > 0) out.push(o.data);

    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') walk(v);
    }
  };

  walk(event);
  return out;
}

/** Pull incremental text out of a streamed text generation. */
export function extractText(event: SseEvent): string {
  let text = '';
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (o.type === 'text' && typeof o.text === 'string') text += o.text;
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(event);
  return text;
}
