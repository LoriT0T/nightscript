'use client';

import { getCachedChunk, putCachedChunk } from '@/lib/db';
import { generateText, speakChunk as speakChunkDirect } from '@/lib/gemini/browser';
import {
  acceptRepair,
  buildRepairPrompt,
  buildSectionPrompt,
  classifyScriptingPattern,
  parseScriptJson,
  sectionLineTarget,
} from '@/lib/gemini/script';
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
  WritingStyle,
} from '@/lib/types';

/**
 * Generation, entirely in the browser.
 *
 * There is no server at all: the app is static files, and the browser talks to Google
 * directly with the listener's own key. That makes the local-first claim literal — the
 * script and the finished hour never touch a machine we control — and it removes the
 * function time limits that shaped the earlier proxied design.
 */

export interface GenerateProgress {
  phase: 'plan' | 'speak' | 'assemble' | 'encode' | 'done';
  message: string;
  fraction: number;
}

export interface GenerateResult {
  blob: Blob;
  mime: string;
  /** How many chunks came from the local cache instead of the API. */
  cachedCount: number;
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
 * Cache key for one spoken chunk. Covers everything that can change the audio. SHA-256 via
 * WebCrypto, so it matches the server-side key format used by the CLI renderer.
 */
async function chunkKey(section: string, text: string, voice: string): Promise<string> {
  const data = new TextEncoder().encode(`${voice}\u0000${section}\u0000${text}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Speak one chunk, retrying transient failures.
 *
 * Rate limits and the occasional dropped stream are normal, and one bad passage must not
 * lose a whole track, so each is retried with backoff before giving up.
 */
async function speakChunk(
  section: Section,
  text: string,
  voice: string,
  signal?: AbortSignal,
  attempt = 0,
): Promise<Int16Array> {
  try {
    return await speakChunkDirect(section, text, voice, { signal });
  } catch (e) {
    const message = (e as Error).message ?? '';
    const permanent =
      /API key|api_key|not set|PERMISSION|content_blocked|policy/i.test(message) || attempt >= 3;
    if (permanent) throw e;
    // Honour the API's own retry hint when it gives one.
    const hinted = /retry in ([0-9.]+)s/i.exec(message);
    const waitMs = hinted ? (Number(hinted[1]) + 1) * 1000 : 1500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, waitMs));
    return speakChunk(section, text, voice, signal, attempt + 1);
  }
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
  let cached = 0;

  const queue = [...unique.values()];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const chunk = queue.shift();
      if (!chunk) return;

      const key = await chunkKey(chunk.section, chunk.text, settings.voice);
      let pcm = await getCachedChunk(key).catch(() => null);
      let fromCache = true;
      if (!pcm) {
        fromCache = false;
        pcm = await speakChunk(chunk.section, chunk.text, settings.voice, signal);
        await putCachedChunk(key, pcm).catch(() => {});
      } else {
        cached++;
      }

      audio.set(chunk.hashKey, { hashKey: chunk.hashKey, pcm, lineCount: chunk.lines.length });
      done++;
      onProgress({
        phase: 'speak',
        message: `Speaking — ${done} of ${unique.size} passages${fromCache ? ' (cached)' : ''}`,
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
    cachedCount: cached,
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
 * The request plan, built for the requested length.
 *
 * Sections are written as several small batches running in parallel. That started as a way
 * to survive a 30-second serverless ceiling; it stays because it is simply faster than one
 * long call and gives each batch a distinct emphasis. The totals track the target duration —
 * hardcoding them once gave a 10-minute track the same 146 lines as an hour, which overran
 * by 2:14 with the pauses already at their floor.
 */
const BATCH_NOTES: Record<WritingStyle, Array<{ section: Section; notes: string[] }>> = {
  // Each batch gets a different emphasis so four parallel calls do not converge on the same
  // lines. The emphases have to match the style, or the notes fight the rules.
  scripting: [
    {
      section: 'arrival',
      notes: [
        'Gratitude that the day is finished and can be set down.',
        'The feeling of the bed and of being allowed to stop.',
      ],
    },
    {
      section: 'downshift',
      notes: [
        'Work downward from jaw and face to the chest.',
        'Work downward from the stomach to the feet.',
      ],
    },
    {
      section: 'core',
      notes: [
        'Lead with gratitude lines about the goals, already true.',
        'Lead with what they already have, and what they are able to do.',
        'Lead with the feeling of it, and with concrete sensory detail of the life.',
        'Lead with who they are to their people, and with trust that it is working.',
      ],
    },
    {
      section: 'second',
      notes: [
        'The softer re-voicing. Gratitude first.',
        'The softer re-voicing. Name the feeling first.',
      ],
    },
    {
      section: 'dissolution',
      notes: [
        'Fragments of the life, warm and concrete.',
        'Fragments of settling and of the day being done.',
      ],
    },
  ],
  process: [
    {
      section: 'arrival',
      notes: [
        'Focus on arriving and putting the day down.',
        'Focus on breath and on permission to stop listening.',
      ],
    },
    {
      section: 'downshift',
      notes: [
        'Work downward from jaw and face to the chest.',
        'Work downward from the belly to the feet.',
      ],
    },
    {
      section: 'core',
      notes: [
        'Weight towards implementation intentions built from their stated obstacle.',
        'Weight towards evidence anchored in the specific past moment they described.',
        'Weight towards values and process framing.',
        'Weight towards permitted ambivalence and self-compassion.',
      ],
    },
    {
      section: 'second',
      notes: [
        'The gentler re-voicing. Compassion first.',
        'The gentler re-voicing. Ambivalence and permission first.',
      ],
    },
    {
      section: 'dissolution',
      notes: ['Fragments about the body settling.', 'Fragments about letting the day go.'],
    },
  ],
};

/** Never ask for more than this in one request — it is what keeps a call inside 30 seconds. */
const MAX_LINES_PER_REQUEST = 15;

function planScriptRequests(
  minutes: number,
  style: WritingStyle = 'scripting',
): Array<{ section: Section; lineCount: number; variantNote: string }> {
  const out: Array<{ section: Section; lineCount: number; variantNote: string }> = [];

  for (const { section, notes } of BATCH_NOTES[style]) {
    const total = sectionLineTarget(minutes, section);
    if (total <= 0) continue;
    // Use as few batches as the per-request ceiling allows, so short tracks do not fan out
    // into a dozen requests for four lines each.
    const batches = Math.max(1, Math.min(notes.length, Math.ceil(total / MAX_LINES_PER_REQUEST)));
    const base = Math.floor(total / batches);
    let remainder = total - base * batches;

    for (let i = 0; i < batches; i++) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      const lineCount = base + extra;
      if (lineCount <= 0) continue;
      out.push({ section, lineCount, variantNote: notes[i] });
    }
  }
  return out;
}

const SECTION_ORDER: Section[] = ['arrival', 'downshift', 'core', 'second', 'dissolution'];

/** Cap on repair round-trips, so a bad generation cannot fan out into fifty requests. */
const MAX_REPAIRS = 12;

export async function writeScript(
  intake: Intake,
  minutes: number,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
  style: WritingStyle = 'scripting',
): Promise<Script> {
  let done = 0;
  const requests = planScriptRequests(minutes, style);
  onProgress('Writing the script…');

  const batches = await Promise.all(
    requests.map(async (request) => {
      const raw = await generateText(
        buildSectionPrompt(
          intake,
          minutes,
          request.section,
          request.lineCount,
          request.variantNote,
          style,
        ),
        signal,
      );
      const lines = parseScriptJson(raw, intake.goals).map((l) => ({
        ...l,
        section: request.section,
        pattern: style === 'scripting' ? classifyScriptingPattern(l.text, l.pattern) : l.pattern,
      }));
      done++;
      onProgress(`Writing the script — ${done} of ${requests.length} passes`);
      return { section: request.section, lines };
    }),
  );

  let lines = SECTION_ORDER.flatMap((s) =>
    batches.filter((b) => b.section === s).flatMap((b) => b.lines),
  );

  // Repair whatever broke the rules, one short request per line. Anything still failing is
  // dropped rather than shipped: at three to four repetitions per line, one bad line is
  // heard a dozen times.
  const problems = new Map<string, string[]>();
  for (const issue of validateScript(lines, intake.goals, style)) {
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
        try {
          const raw = await generateText(
            buildRepairPrompt(intake, line, problems.get(lineId) ?? [], style),
            signal,
          );
          const fixed = acceptRepair(intake, line, raw, style);
          if (fixed) fixes.set(lineId, fixed);
        } catch {
          // Leave it broken; the drop below is the backstop.
        }
      }),
    );
    lines = lines.map((l) => fixes.get(l.id) ?? l);

    const stillBad = new Set(
      validateScript(lines, intake.goals, style)
        .filter((i) => i.severity === 'error')
        .map((i) => i.lineId),
    );
    lines = lines.filter((l) => !stillBad.has(l.id));
  }

  if (lines.length === 0) throw new Error('The writer returned nothing usable.');
  return { lines, cycles: 1 };
}
