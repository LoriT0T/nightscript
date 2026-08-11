'use client';

import { TEXT_MODEL, TTS_MODEL } from './client';
import { extractAudioBase64, extractText, parseSse } from './stream';
import { buildInput } from './style';
import type { Section } from '@/lib/types';

/**
 * Talking to Gemini from the browser.
 *
 * The app is served as static files, so there is no server to hold a key and no serverless
 * function to proxy through. The browser calls Google directly with the listener's own key,
 * which it stores on their device and sends nowhere else.
 *
 * Two things were verified against the live API before this was written (2026-08-11):
 *
 *  1. **CORS is allowed.** A preflight from a `github.io` origin returns 200 with
 *     `access-control-allow-origin` echoing that origin.
 *  2. **The allowed request headers are `content-type` and `x-goog-api-key` — and nothing
 *     else.** A preflight that also asked for `api-revision` returned **403**. The docs
 *     describe `Api-Revision: 2026-05-20` as required for streaming, so this looked fatal;
 *     it is not. Both the non-streaming and streaming endpoints work without that header.
 *     Do not add custom headers here without re-running a preflight.
 *
 * Losing the proxy also lost the host's 30-second function ceiling, which is why chunks can
 * be large again — see CHUNK_TARGET_WORDS in src/lib/script/plan.ts.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const API_KEY_STORAGE = 'nightscript.apikey';

export class MissingKeyError extends Error {
  constructor() {
    super('No API key set. Add your Gemini API key on the last step of "Make a new track".');
    this.name = 'MissingKeyError';
  }
}

export function getApiKey(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(API_KEY_STORAGE) ?? '';
}

export function setApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE, key.trim());
}

export function hasApiKey(): boolean {
  return getApiKey().length > 0;
}

/** Only the two headers the API's CORS policy permits. */
function headers(): Record<string, string> {
  const key = getApiKey();
  if (!key) throw new MissingKeyError();
  return { 'Content-Type': 'application/json', 'x-goog-api-key': key };
}

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    return j.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Generate text and return it whole. Used for script writing and line repair. */
export async function generateText(prompt: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model: TEXT_MODEL, input: prompt }),
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));

  const json = (await res.json()) as { steps?: Array<{ content?: Array<Record<string, unknown>> }> };
  let out = '';
  for (const step of json.steps ?? []) {
    for (const c of step.content ?? []) {
      if (c.type === 'text' && typeof c.text === 'string') out += c.text;
    }
  }
  if (!out) {
    // A streamed shape occasionally arrives here; extractText walks whatever came back.
    out = extractText(json as Record<string, unknown>);
  }
  return out;
}

export interface SpeakOptions {
  onBytes?: (received: number) => void;
  signal?: AbortSignal;
}

/**
 * Speak one chunk, streaming. Returns raw 24 kHz mono s16le PCM.
 *
 * Streamed rather than whole because it is dramatically faster: measured on one 152-word
 * chunk, 46.9 s non-streamed against 13.6 s streamed.
 */
export async function speakChunk(
  section: Section,
  text: string,
  voice: string,
  opts: SpeakOptions = {},
): Promise<Int16Array> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: TTS_MODEL,
      input: buildInput(section, text),
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  if (!res.body) throw new Error('The voice model returned an empty response.');

  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const event of parseSse(res.body)) {
    for (const b64 of extractAudioBase64(event)) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      parts.push(bytes);
      total += bytes.length;
      opts.onBytes?.(total);
    }
  }

  if (total < 2) throw new Error('The voice model returned no audio for a passage.');

  const merged = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    merged.set(p, o);
    o += p.length;
  }
  const usable = total - (total % 2);
  return new Int16Array(merged.buffer, 0, usable / 2);
}

/** Cheap round-trip to tell the listener whether their key works, before spending anything. */
export async function testApiKey(key: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.trim() },
      body: JSON.stringify({ model: TEXT_MODEL, input: 'Reply with the single word: ok' }),
    });
    if (!res.ok) return { ok: false, message: await readError(res) };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
