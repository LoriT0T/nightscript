'use client';

import { authHeaders } from '@/lib/access';
import { buildTimeline, planChunks, timelineDurationSec } from '@/lib/script/plan';
import { assembleInBrowser, type ChunkPcm } from '@/lib/audio/webaudio';
import { encodeMp3 } from '@/lib/audio/mp3';
import type { Intake, Line, Measurement, Script, Section, TrackSettings } from '@/lib/types';

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

async function speakChunk(
  section: string,
  text: string,
  voice: string,
  signal?: AbortSignal,
): Promise<Int16Array> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ section, text, voice }),
    signal,
  });
  if (!res.ok) {
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
  if (total < 2) throw new Error('The voice model returned no audio for a chunk.');

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
const SCRIPT_SECTIONS: Section[] = ['arrival', 'downshift', 'core', 'second', 'dissolution'];

export async function writeScript(
  intake: Intake,
  minutes: number,
  onProgress: (message: string) => void,
): Promise<Script> {
  let done = 0;
  onProgress('Writing the script…');

  const results = await Promise.all(
    SCRIPT_SECTIONS.map(async (section) => {
      const res = await fetch('/api/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ intake, minutes, section }),
      });
      if (!res.ok) {
        let message = `Script request failed (${res.status})`;
        try {
          message = ((await res.json()) as { error?: string }).error ?? message;
        } catch {
          /* keep generic */
        }
        throw new Error(message);
      }
      const json = (await res.json()) as { lines: Line[] };
      done++;
      onProgress(`Writing the script — ${done} of ${SCRIPT_SECTIONS.length} sections`);
      return { section, lines: json.lines ?? [] };
    }),
  );

  // Reassemble in arc order, not completion order.
  const bySection = new Map(results.map((r) => [r.section, r.lines]));
  const lines = SCRIPT_SECTIONS.flatMap((s) => bySection.get(s) ?? []);
  if (lines.length === 0) throw new Error('The writer returned nothing usable.');
  return { lines, cycles: 1 };
}
