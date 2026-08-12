/**
 * Thin client for the Gemini Interactions API.
 * Verified against the live API on 2026-08-11 — see docs/GEMINI-TTS.md.
 *
 * Server-side only. The key is read from process.env and never leaves this module.
 */

export const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const API_REVISION = '2026-05-20';
export const TTS_MODEL = process.env.NIGHTSCRIPT_TTS_MODEL ?? 'gemini-3.1-flash-tts-preview';

/**
 * Fallback voice model. The free tier caps `gemini-3.1-flash-tts` at 3 requests/minute AND
 * about 10 requests/day (verified 2026-08-11 — the daily figure is only ever revealed in a
 * 429 body). A fresh 60-minute track needs ~14, so the daily cap alone can strand a
 * generation halfway. `gemini-2.5-flash-preview-tts` draws on a separate quota bucket and
 * accepts the same request and style-prompt shape, so it can carry a whole track.
 *
 * The fallback is chosen ONCE, before the first chunk, and then used for every chunk in the
 * track. Switching models mid-track would put an audible seam in the middle of the hour,
 * which is worse than not producing the track at all.
 *
 * It is `2.5-pro`, not `2.5-flash`, because their content filters differ sharply. Measured
 * 2026-08-12: flash refused an ordinary body-scan chunk as a policy violation, and refused a
 * chunk containing only "morning will come" and "steady from here". Pro accepted the same
 * body scan on the first try. Flash is faster and cheaper and would otherwise be the obvious
 * pick; it is unusable for this material.
 */
export const TTS_FALLBACK_MODEL =
  process.env.NIGHTSCRIPT_TTS_FALLBACK ?? 'gemini-2.5-pro-preview-tts';
/**
 * Script writing model.
 *
 * Chosen on latency, because the host kills a serverless function at 30 s. Measured on the
 * same 12-line core prompt (2026-08-11):
 *
 *   gemini-3.6-flash         12.5 s   (2,221 thinking tokens)
 *   gemini-3-flash-preview   16.4 s   (3,486 thinking tokens)
 *   gemini-3.1-flash-lite     4.2 s
 *   gemini-3.5-flash-lite     3.5 s   ← chosen
 *
 * The heavier models spend their time thinking, which buys nothing here: the task is
 * constrained writing against an explicit rule list, and the validator is the real quality
 * gate. Output quality was checked side by side and flash-lite's lines are specific,
 * correctly patterned and drawn from the listener's own words.
 *
 * `gemini-3.1-pro-preview` is listed but has a free-tier quota of literally 0 requests.
 */
export const TEXT_MODEL = process.env.NIGHTSCRIPT_TEXT_MODEL ?? 'gemini-3.5-flash-lite';

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** Seconds the API asked us to wait, parsed from a 429 body. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

function apiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) {
    throw new GeminiError(
      'GEMINI_API_KEY is not set. Export it in the shell that runs the server; see README.',
      'no_key',
      0,
    );
  }
  return k;
}

/**
 * The 429 body carries `Please retry in 19.347400292s.` — honour it rather than
 * guessing a backoff. See docs/GEMINI-TTS.md §6.
 */
function parseRetryAfter(message: string): number | undefined {
  const m = /retry in ([0-9.]+)s/i.exec(message);
  return m ? Number(m[1]) : undefined;
}

export async function callInteractions(body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey(),
      'Content-Type': 'application/json',
      'Api-Revision': API_REVISION,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new GeminiError(`Non-JSON response (${res.status})`, 'bad_response', res.status);
  }

  const err = json.error as { message?: string; code?: string } | undefined;
  if (err) {
    const message = err.message ?? 'unknown error';
    throw new GeminiError(message, err.code ?? 'unknown', res.status, parseRetryAfter(message));
  }
  if (!res.ok) {
    throw new GeminiError(`HTTP ${res.status}`, 'http_error', res.status);
  }
  return json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry with backoff. Rate limits are the normal case on the free tier (3 RPM), not an
 * exceptional one, so they get generous patience; content blocks and bad requests are
 * permanent and fail fast.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; onWait?: (sec: number, attempt: number, why: string) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!(e instanceof GeminiError)) throw e;
      // Permanent failures — retrying cannot help and would burn quota.
      if (e.code === 'no_key' || e.code === 'content_blocked' || e.code === 'invalid_request') {
        throw e;
      }
      if (i === attempts - 1) break;
      const wait = e.retryAfterSec != null ? e.retryAfterSec + 1 : Math.min(2 ** i * 2, 60);
      opts.onWait?.(wait, i + 1, e.code);
      await sleep(wait * 1000);
    }
  }
  throw lastErr;
}
