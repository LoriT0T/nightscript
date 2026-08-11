'use client';

import { authHeaders } from '@/lib/access';
import { validateScript } from '@/lib/affirmations/validator';
import { buildTimeline, planChunks, timelineDurationSec } from '@/lib/script/plan';
import { assembleInBrowser, type ChunkPcm } from '@/lib/audio/webaudio';
import { encodeMp3 } from '@/lib/audio/mp3';
import type {
  Intake,
  Line,
  Measurement,
  Script,
  Section,
  TrackSettings,
  ValidationIssue,
} from '@/lib/types';

/**
 * Client-side generation.
 *
 * The browser owns the whole pipeline and the server is two stateless proxies that hold the
 * API key. That is what makes this hostable — no serverless function has to live longer than
 * a single chunk — and it is also what makes the local-first promise true rather than
 * aspirational: the script and the finished hour never land on a disk we control.
 */

export interface GenerateProgress {
  phase: 'plan' | 'speak' | 'assemble' | 'encode' | 'done';
  message: string;
  fraction: number;
}

export interface GenerateResult {
  blob: Blob;
  mime: string;
  measurement: Measurement;
  splitFallbacks: number;
  chunkCount: number;
  uniqueCount: number;
  coreCycles: number;
  estimatedSec: number;
  elapsedSec: number;
}

/** How many chunks to speak at once. Small enough to be a polite API citizen. */
const CONCURRENCY = 3;

/**
 * Speak one chunk, retrying transient failures.
 *
 * 502s happen: the platform kills a function that runs long, and a chunk that streams back
 * comfortably on its own can tip over the edge when three are in flight. One bad chunk must
 * not lose an hour of work, so each is retried with backoff before giving up.
 */
async function speakChunk(
  section: string,
  text: string,
  voice: string,
  signal?: AbortSignal,
  attempt = 0,
): Promise<Int16Array> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ section, text, voice }),
    signal,
  });
  if (!res.ok) {
    const transient = res.status >= 500 || res.status === 429;
    if (transient && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      return speakChunk(section, text, voice, signal, attempt + 1);
    }
    let message = `Speech request failed (${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* keep generic */
    }
    throw new Error(message);
  }

  // Raw PCM arrives as a stream; collect it without assuming a length up front.
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }

  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  if (total < 2) {
    // An empty body from a stream that closed early is the same class of failure as a 502.
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      return speakChunk(section, text, voice, signal, attempt + 1);
    }
    throw new Error('The voice model returned no audio for a chunk.');
  }

  // Byte offset must be even and the buffer length a multiple of 2 for Int16Array.
  const usable = total - (total % 2);
  return new Int16Array(bytes.buffer, 0, usable / 2);
}

export async function generateTrack(
  script: Script,
  intake: Intake,
  settings: TrackSettings,
  onProgress: (p: GenerateProgress) => void,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  const started = performance.now();

  onProgress({ phase: 'plan', message: 'Planning…', fraction: 0 });
  const chunks = planChunks(script);
  chunks.forEach((c, i) => (c.hashKey = `${c.section}:${i}`));
  const { plays, coreCycles } = buildTimeline(chunks, settings.minutes);
  const estimatedSec = timelineDurationSec(plays, settings.minutes);

  // Only unique chunks are spoken. The core section repeats, and a repeat reuses the same
  // audio, so extra cycles cost nothing.
  const unique = new Map(chunks.map((c) => [c.hashKey, c]));
  const audio = new Map<string, ChunkPcm>();
  let done = 0;

  const queue = [...unique.values()];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const chunk = queue.shift();
      if (!chunk) return;
      const pcm = await speakChunk(chunk.section, chunk.text, settings.voice, signal);
      audio.set(chunk.hashKey, { hashKey: chunk.hashKey, pcm, lineCount: chunk.lines.length });
      done++;
      onProgress({
        phase: 'speak',
        message: `Speaking — ${done} of ${unique.size} passages`,
        fraction: (done / unique.size) * 0.75,
      });
    }
  });
  await Promise.all(workers);

  const assembled = await assembleInBrowser({
    plays,
    audio,
    settings,
    onProgress: (message) => onProgress({ phase: 'assemble', message, fraction: 0.8 }),
  });

  const { blob, mime } = await encodeMp3(assembled.samples, assembled.sampleRate, (f) =>
    onProgress({ phase: 'encode', message: 'Encoding…', fraction: 0.85 + f * 0.15 }),
  );

  onProgress({ phase: 'done', message: 'Ready', fraction: 1 });
  return {
    blob,
    mime,
    measurement: assembled.measurement,
    splitFallbacks: assembled.splitFallbacks,
    chunkCount: plays.length,
    uniqueCount: unique.size,
    coreCycles,
    estimatedSec,
    elapsedSec: (performance.now() - started) / 1000,
  };
}

/**
 * Write the script by asking for all five sections at once.
 *
 * Parallel rather than sequential because each section is an independent prompt, and because
 * a single whole-script call exceeds the host's function limit (see the route). The sections
 * come back in whatever order they finish and are reassembled into arc order here.
 */
/**
 * The request plan.
 *
 * Many small batches rather than five big ones, because the host kills any function at 30
 * seconds and generation latency scales with how many lines are asked for. Measured: a
 * 20-line batch died at 30.7 s; a 12-15 line batch returns in 10-20 s. Every batch is one
 * model round-trip, and they all run at once.
 */
const SCRIPT_REQUESTS: Array<{ section: Section; lineCount: number; variantNote?: string }> = [
  { section: 'arrival', lineCount: 10, variantNote: 'Focus on arriving and putting the day down.' },
  { section: 'arrival', lineCount: 10, variantNote: 'Focus on breath and on permission to stop listening.' },
  { section: 'downshift', lineCount: 15, variantNote: 'Work downward from jaw and face to the chest.' },
  { section: 'downshift', lineCount: 15, variantNote: 'Work downward from the belly to the feet.' },
  { section: 'core', lineCount: 12, variantNote: 'Weight towards implementation intentions built from their stated obstacle.' },
  { section: 'core', lineCount: 12, variantNote: 'Weight towards evidence anchored in the specific past moment they described.' },
  { section: 'core', lineCount: 12, variantNote: 'Weight towards values and process framing.' },
  { section: 'core', lineCount: 12, variantNote: 'Weight towards permitted ambivalence and self-compassion.' },
  { section: 'second', lineCount: 12, variantNote: 'The gentler re-voicing. Compassion first.' },
  { section: 'second', lineCount: 12, variantNote: 'The gentler re-voicing. Ambivalence and permission first.' },
  { section: 'dissolution', lineCount: 15, variantNote: 'Fragments about the body settling.' },
  { section: 'dissolution', lineCount: 15, variantNote: 'Fragments about letting the day go.' },
];

const SECTION_ORDER: Section[] = ['arrival', 'downshift', 'core', 'second', 'dissolution'];

/** Cap on repair round-trips, so a bad generation cannot fan out into fifty requests. */
const MAX_REPAIRS = 12;

export async function writeScript(
  intake: Intake,
  minutes: number,
  onProgress: (message: string) => void,
): Promise<Script> {
  let done = 0;
  onProgress('Writing the script…');

  const batches = await Promise.all(
    SCRIPT_REQUESTS.map(async (request) => {
      const res = await fetch('/api/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ intake, minutes, ...request }),
      });
      if (!res.ok) {
        let message = `Script request failed (${res.status})`;
        try {
          message = ((await res.json()) as { error?: string }).error ?? message;
        } catch {
          /* keep generic */
        }
        throw new Error(`${request.section}: ${message}`);
      }
      const json = (await res.json()) as { lines: Line[]; issues: ValidationIssue[] };
      done++;
      onProgress(`Writing the script — ${done} of ${SCRIPT_REQUESTS.length} passes`);
      return { section: request.section, lines: json.lines ?? [] };
    }),
  );

  let lines = SECTION_ORDER.flatMap((s) =>
    batches.filter((b) => b.section === s).flatMap((b) => b.lines),
  );

  // Repair whatever broke the rules, one short request per line. Anything still failing is
  // dropped rather than shipped: at three to four repetitions per line, one bad line is
  // heard a dozen times.
  const problems = new Map<string, string[]>();
  for (const issue of validateScript(lines, intake.goals)) {
    if (issue.severity !== 'error') continue;
    problems.set(issue.lineId, [
      ...(problems.get(issue.lineId) ?? []),
      `${issue.rule} (matched "${issue.match}")`,
    ]);
  }

  if (problems.size > 0) {
    onProgress(`Fixing ${problems.size} line${problems.size === 1 ? '' : 's'} that broke the rules…`);
    const targets = [...problems.keys()].slice(0, MAX_REPAIRS);
    const fixes = new Map<string, Line>();
    await Promise.all(
      targets.map(async (lineId) => {
        const line = lines.find((l) => l.id === lineId);
        if (!line) return;
        const res = await fetch('/api/script', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            intake,
            repair: { line, problems: problems.get(lineId) ?? [] },
          }),
        });
        if (!res.ok) return;
        const json = (await res.json()) as { line: Line | null };
        if (json.line) fixes.set(lineId, json.line);
      }),
    );
    lines = lines.map((l) => fixes.get(l.id) ?? l);

    const stillBad = new Set(
      validateScript(lines, intake.goals)
        .filter((i) => i.severity === 'error')
        .map((i) => i.lineId),
    );
    lines = lines.filter((l) => !stillBad.has(l.id));
  }

  if (lines.length === 0) throw new Error('The writer returned nothing usable.');
  return { lines, cycles: 1 };
}
