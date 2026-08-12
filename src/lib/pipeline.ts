import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkHash, synthesizeChunk } from './gemini/tts';
import { GeminiError, TTS_FALLBACK_MODEL, TTS_MODEL } from './gemini/client';
import { buildTimeline, planChunks, timelineDurationSec, type Chunk, type Play } from './script/plan';
import { assembleTrack, type AssembleResult, type ChunkAudio } from './audio/assemble';
import { validateScript, hasBlockingIssues } from './affirmations/validator';
import type { Intake, Script, TrackSettings } from './types';

/**
 * End-to-end: script → chunks → audio → assembled track.
 * Server-side only. Shared by the API route and the CLI so both take the same path.
 */

export interface PipelineProgress {
  phase: 'plan' | 'synth' | 'assemble' | 'done';
  message: string;
  /** 0..1 within the synth phase. */
  fraction?: number;
}

export interface RunPipelineOptions {
  script: Script;
  intake: Intake;
  settings: TrackSettings;
  workDir: string;
  outBase: string;
  onProgress?: (p: PipelineProgress) => void;
  /** Skip validation. Only the CLI's --force sets this. */
  skipValidation?: boolean;
}

export interface PipelineResult extends AssembleResult {
  /** The model that actually produced every chunk of this track. */
  ttsModel: string;
  chunkCount: number;
  cachedCount: number;
  coreCycles: number;
  estimatedSec: number;
  plays: Play[];
}

export async function runPipeline(opts: RunPipelineOptions): Promise<PipelineResult> {
  const say = opts.onProgress ?? (() => {});
  const { script, settings } = opts;

  if (!opts.skipValidation) {
    const issues = validateScript(script.lines, opts.intake.goals, settings.style);
    if (hasBlockingIssues(issues)) {
      const first = issues.filter((i) => i.severity === 'error').slice(0, 5);
      throw new Error(
        `Script has ${issues.filter((i) => i.severity === 'error').length} blocking validation ` +
          `errors and will not be generated:\n` +
          first.map((i) => `  • ${i.rule}: "${i.match}"`).join('\n'),
      );
    }
  }

  say({ phase: 'plan', message: 'Planning chunks…' });
  const chunks = planChunks(script);
  for (const c of chunks) {
    c.hashKey = chunkHash({ section: c.section, text: c.text, voice: settings.voice });
  }
  const { plays, coreCycles } = buildTimeline(chunks, settings.minutes);
  const estimatedSec = timelineDurationSec(plays, settings.minutes);

  // Only unique chunks are synthesized; a second core cycle reuses the same audio and
  // therefore costs nothing. See docs/GEMINI-TTS.md §7.
  const unique = new Map(chunks.map((c) => [c.hashKey, c]));
  say({
    phase: 'plan',
    message: `${chunks.length} chunks, ${unique.size} unique, ${coreCycles} core cycles, ` +
      `≈${Math.round(estimatedSec / 60)} min planned`,
  });

  // Decide the voice model ONCE, before anything is generated. If the primary model's daily
  // quota is gone we would otherwise discover it halfway through the hour and be left with a
  // half-rendered track. Switching model mid-track is not an option — it would put an audible
  // seam in the middle. See the note on TTS_FALLBACK_MODEL.
  const ttsModel = await pickModel(chunks[0], settings.voice, say);
  if (ttsModel !== TTS_MODEL) {
    say({ phase: 'plan', message: `Primary voice model is out of quota; using ${ttsModel} for the whole track` });
  }
  for (const c of chunks) {
    c.hashKey = chunkHash({ section: c.section, text: c.text, voice: settings.voice, model: ttsModel });
  }
  unique.clear();
  for (const c of chunks) unique.set(c.hashKey, c);

  const audio = new Map<string, ChunkAudio>();
  let cachedCount = 0;
  let i = 0;

  for (const [hash, chunk] of unique) {
    i++;
    say({
      phase: 'synth',
      message: `Chunk ${i}/${unique.size} (${chunk.section})`,
      fraction: i / unique.size,
    });
    let res;
    try {
      res = await synthesizeChunk(
        { section: chunk.section, text: chunk.text, voice: settings.voice, model: ttsModel },
        {
          onWait: (sec, attempt, why) =>
            say({
              phase: 'synth',
              message: `Chunk ${i}/${unique.size}: ${why}, waiting ${sec.toFixed(0)}s (attempt ${attempt})`,
              fraction: i / unique.size,
            }),
        },
      );
    } catch (e) {
      if (e instanceof GeminiError && e.code === 'content_blocked') {
        throw new Error(
          `The voice model refused chunk ${i}/${unique.size} (${chunk.section}). Its content ` +
            `filter is stricter on some models than others, and body-scan wording is the usual ` +
            `trigger. Reword one of these lines and re-run — everything already generated is ` +
            `cached, so only this chunk costs anything:\n\n` +
            chunk.lines.map((l) => `    • ${l.text}`).join('\n'),
        );
      }
      throw e;
    }
    if (res.cached) cachedCount++;
    audio.set(hash, { hash, pcm: res.pcm, lineCount: chunk.lines.length });
  }

  await mkdir(opts.workDir, { recursive: true });
  say({ phase: 'assemble', message: 'Assembling…' });
  const assembled = await assembleTrack(plays, audio, {
    workDir: opts.workDir,
    outBase: opts.outBase,
    settings,
    onProgress: (m) => say({ phase: 'assemble', message: m }),
  });

  say({ phase: 'done', message: 'Done' });
  return {
    ...assembled,
    ttsModel,
    chunkCount: chunks.length,
    cachedCount,
    coreCycles,
    estimatedSec,
    plays,
  };
}

/**
 * Try the primary model on the first chunk. If it is quota-blocked after a short retry
 * budget, fall back. The probe result is cached like any other chunk, so this costs nothing
 * extra — the chunk it generates is one the track needs anyway.
 */
async function pickModel(
  first: Chunk | undefined,
  voice: string,
  say: (p: PipelineProgress) => void,
): Promise<string> {
  if (!first) return TTS_MODEL;
  try {
    await synthesizeChunk(
      { section: first.section, text: first.text, voice, model: TTS_MODEL },
      {
        attempts: 3,
        onWait: (sec, attempt, why) =>
          say({ phase: 'plan', message: `Checking voice model: ${why}, waiting ${sec.toFixed(0)}s (${attempt}/2)` }),
      },
    );
    return TTS_MODEL;
  } catch (e) {
    if (e instanceof GeminiError && e.code === 'too_many_requests') return TTS_FALLBACK_MODEL;
    throw e;
  }
}

export function defaultWorkDir(id: string): string {
  return join(process.cwd(), '.cache', 'work', id);
}
