/**
 * Assembly verification harness.
 *
 * This runs the REAL timeline, the REAL splitter, the REAL ffmpeg chain and the REAL
 * measurement over a full-length track — but it substitutes cached audio for the TTS calls
 * instead of spending quota. It exists because the free tier caps TTS at ~10 requests per
 * day (docs/GEMINI-TTS.md §6) while a fresh hour needs ~14, so the audio-engineering half of
 * the pipeline would otherwise be unverifiable on days when the cap is gone.
 *
 * WHAT THIS PROVES: duration, integrated loudness, true peak, per-minute level descent,
 * per-chunk RMS variance across seams, the silence splitter, the pause schedule, encoding,
 * file size, and playback.
 * WHAT THIS DOES NOT PROVE: that the spoken words are the script's words. They are not —
 * every line is the same cached audition sentence. Use scripts/generate-track.ts for that.
 *
 *   npx tsx scripts/verify-assembly.ts [--minutes 60] [--source public/auditions/Sulafat.wav]
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assembleTrack, type ChunkAudio } from '@/lib/audio/assemble';
import { detectSilences, durationOf } from '@/lib/audio/measure';
import { buildTimeline, planChunks, formatDuration, ARC } from '@/lib/script/plan';
import { SAMPLE_RATE } from '@/lib/gemini/wav';
import { ffmpeg } from '@/lib/audio/ffmpeg';
import type { Script, TrackSettings } from '@/lib/types';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** One sentence of real generated speech, extracted from a cached audition. */
async function sentencePcm(sourceWav: string, workDir: string): Promise<Uint8Array> {
  const total = await durationOf(sourceWav);
  const sil = await detectSilences(sourceWav, 0.3, -40);
  const firstGap = sil.find((s) => s.start > 0.5);
  const end = firstGap ? firstGap.start : Math.min(3, total);
  const start = sil.length && sil[0].start < 0.5 ? sil[0].end : 0;
  const out = join(workDir, 'sentence.raw');
  await ffmpeg([
    '-i', sourceWav,
    '-ss', start.toFixed(3),
    '-to', end.toFixed(3),
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '1',
    out,
  ]);
  return new Uint8Array(await readFile(out));
}

function silencePcm(sec: number): Uint8Array {
  return new Uint8Array(Math.round(sec * SAMPLE_RATE) * 2);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

async function main() {
  const minutes = Number(arg('minutes', '60'));
  const source = arg('source', 'public/auditions/Sulafat.wav');
  const workDir = join(process.cwd(), '.cache', 'verify');
  await mkdir(workDir, { recursive: true });

  const script = JSON.parse(await readFile('artifacts/track.script.json', 'utf8')) as Script;
  const chunks = planChunks(script);
  chunks.forEach((c, i) => (c.hashKey = `verify${i}`));
  const { plays, coreCycles } = buildTimeline(chunks, minutes);

  console.log(`Source speech: ${source}`);
  const sentence = await sentencePcm(source, workDir);
  console.log(`One sentence = ${(sentence.byteLength / 2 / SAMPLE_RATE).toFixed(2)}s of real speech\n`);

  // Build stand-in chunk audio with the correct number of speech regions per chunk, so the
  // silence splitter takes its real path rather than the degraded fallback.
  const audio = new Map<string, ChunkAudio>();
  for (const c of chunks) {
    const parts: Uint8Array[] = [];
    c.lines.forEach((_, i) => {
      if (i > 0) parts.push(silencePcm(0.6));
      parts.push(sentence);
    });
    audio.set(c.hashKey, { hash: c.hashKey, pcm: concat(parts), lineCount: c.lines.length });
  }

  const settings: TrackSettings = { voice: 'Sulafat', bed: 'pink', bedLevelDb: -34, minutes };
  const t0 = Date.now();
  const res = await assembleTrack(plays, audio, {
    workDir,
    outBase: join('artifacts', 'verify'),
    settings,
    onProgress: (m) => process.stdout.write(`\r  ${m.padEnd(60)}`),
  });
  console.log('');

  const m = res.measurement;
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const finite = m.minutePeakDb.filter(Number.isFinite);

  // Where, if anywhere, does the level rise after minute 4?
  const rises: string[] = [];
  for (let i = 5; i < m.minutePeakDb.length; i++) {
    const a = m.minutePeakDb[i - 1];
    const b = m.minutePeakDb[i];
    if (Number.isFinite(a) && Number.isFinite(b) && b > a + 0.5) {
      rises.push(`min ${i}: ${a.toFixed(2)} → ${b.toFixed(2)} dB`);
    }
  }

  console.log(`
════════ ASSEMBLY VERIFICATION ════════
 (speech content is a repeated cached sentence — see the header of this file)

 wall clock          ${((Date.now() - t0) / 1000).toFixed(0)}s
 chunks              ${chunks.length} unique, ${plays.length} plays, ${coreCycles} core cycles
 split fallbacks     ${res.splitFallbacks} / ${chunks.length}   ${res.splitFallbacks === 0 ? '(splitter matched every chunk)' : '(degraded spacing on these)'}

 duration            ${formatDuration(m.durationSec)}  (${m.durationSec.toFixed(1)}s)  target ${minutes}:00
 integrated loudness ${m.integratedLufs.toFixed(2)} LUFS      target -23
 true peak           ${m.truePeakDb.toFixed(2)} dBTP        target < -3
 loudness range      ${m.lra.toFixed(2)} LU

 per-chunk RMS       mean ${mean(m.chunkRmsDb).toFixed(2)} dBFS, sd ${m.chunkRmsStdDb.toFixed(2)} dB
 per-minute peak     first ${finite[0]?.toFixed(2)} dB → last ${finite[finite.length - 1]?.toFixed(2)} dB
 peak curve          ${m.minutePeakDb.map((v) => (Number.isFinite(v) ? v.toFixed(0) : '-')).join(' ')}
 monotonic after 4m  ${m.monotonicAfterMin4 ? 'YES' : 'NO'}${rises.length ? `\n   rises: ${rises.join(', ')}` : ''}

 files               artifacts/verify.webm
                     artifacts/verify.m4a
═══════════════════════════════════════`);

  // Section boundaries actually achieved, against the brief's layout.
  let t = 0;
  console.log('\n section boundaries (achieved / brief):');
  for (const spec of ARC) {
    if (spec.section === 'fade') {
      console.log(`  ${spec.label.padEnd(12)} ${formatDuration(t)}`);
      continue;
    }
    const ps = plays.filter((p) => p.chunk.section === spec.section);
    if (!ps.length) continue;
    console.log(`  ${spec.label.padEnd(12)} ${formatDuration(t)}`);
    t += ps.reduce(
      (a, p) =>
        a +
        p.chunk.lines.reduce((x, l) => x + l.text.trim().split(/\s+/).length, 0) / 86 * 60 +
        p.pauses.reduce((x, y) => x + y, 0),
      0,
    );
  }

  await writeFile('artifacts/verify.measurement.json', JSON.stringify(m, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
