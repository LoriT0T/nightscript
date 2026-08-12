/**
 * End-to-end track generation from the command line. The app's API route runs the same
 * pipeline; this exists so an hour-long generation can be driven, measured and re-run
 * without holding a browser tab open for it.
 *
 *   GEMINI_API_KEY=... npx tsx scripts/generate-track.ts artifacts/intake.json [--minutes 60]
 *       [--voice Sulafat] [--bed pink|brown|rain|none] [--script script.json]
 *       [--out artifacts/track] [--script-only]
 *
 * Everything is cached by content hash, so a re-run after editing one line only
 * regenerates the chunks that line touched.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { generateSection } from '@/lib/gemini/script';
import { runPipeline } from '@/lib/pipeline';
import { validateScript } from '@/lib/affirmations/validator';
import { estimateRuntimeSec, formatDuration } from '@/lib/script/plan';
import { DEFAULT_VOICE } from '@/lib/voices';
import type { Intake, Script, Section, TrackSettings } from '@/lib/types';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const intakePath = process.argv[2];
  if (!intakePath || intakePath.startsWith('--')) {
    console.error('usage: tsx scripts/generate-track.ts <intake.json> [options]');
    process.exit(2);
  }

  const intake = JSON.parse(await readFile(intakePath, 'utf8')) as Intake;
  const minutes = Number(arg('minutes', '60'));
  const settings: TrackSettings = {
    voice: arg('voice', DEFAULT_VOICE)!,
    style: (arg('style', 'scripting') as TrackSettings['style']) ?? 'scripting',
    bed: (arg('bed', 'pink') as TrackSettings['bed']) ?? 'pink',
    bedLevelDb: Number(arg('bed-db', '-34')),
    minutes,
  };
  // NOT `out/` — that is Next's static-export directory and `next build` empties it.
  const outBase = arg('out', join('artifacts', 'track'))!;
  await mkdir(dirname(outBase), { recursive: true });

  // ---- script -------------------------------------------------------------
  const scriptPath = arg('script');
  let script: Script;
  if (scriptPath) {
    script = JSON.parse(await readFile(scriptPath, 'utf8')) as Script;
    console.log(`Loaded script: ${script.lines.length} lines from ${scriptPath}`);
  } else {
    console.log(`Writing script (${minutes} min, ${intake.goals.length} goals)…`);
    const t0 = Date.now();
    const sections: Section[] = ['arrival', 'downshift', 'core', 'second', 'dissolution'];
    const parts = await Promise.all(
      sections.map((s) => generateSection(intake, minutes, s, undefined, undefined, settings.style)),
    );
    script = { lines: parts.flatMap((p) => p.lines), cycles: 1 };
    console.log(
      `  ${script.lines.length} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s ` +
        `(${parts.reduce((a, p) => a + p.repairedCount, 0)} repaired, ` +
        `${parts.reduce((a, p) => a + p.droppedCount, 0)} dropped)`,
    );
    const p = `${outBase}.script.json`;
    await writeFile(p, JSON.stringify(script, null, 2));
    console.log(`  saved ${p}`);
  }

  const bySection = new Map<string, number>();
  for (const l of script.lines) bySection.set(l.section, (bySection.get(l.section) ?? 0) + 1);
  console.log(`  sections: ${[...bySection].map(([k, v]) => `${k}=${v}`).join(' ')}`);

  const issues = validateScript(script.lines, intake.goals, settings.style);
  const errors = issues.filter((i) => i.severity === 'error');
  const warns = issues.filter((i) => i.severity === 'warn');
  console.log(`  style: ${settings.style}`);
  console.log(`  validator: ${errors.length} errors, ${warns.length} warnings`);
  for (const e of errors.slice(0, 10)) console.log(`    ✗ ${e.rule}: "${e.match}"`);

  const words = script.lines.reduce((a, l) => a + l.text.trim().split(/\s+/).length, 0);
  console.log(`  unique words: ${words}`);
  console.log(`  estimated runtime: ${formatDuration(estimateRuntimeSec(script.lines, minutes))}`);

  if (flag('script-only')) return;

  // ---- audio --------------------------------------------------------------
  const t0 = Date.now();
  const result = await runPipeline({
    script,
    intake,
    settings,
    workDir: join(process.cwd(), '.cache', 'work', String(Date.now())),
    outBase,
    onProgress: (p) => process.stdout.write(`\r  [${p.phase}] ${p.message.padEnd(70)}`),
    skipValidation: flag('force'),
  });
  console.log('');

  const m = result.measurement;
  const wpm = m.chunkWpm;
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const spoken = script.lines.reduce((a, l) => a + l.text.trim().split(/\s+/).length, 0);

  console.log(`
════════ RESULT ════════
 wall clock          ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min
 voice model         ${result.ttsModel}
 chunks              ${result.chunkCount} plays, ${result.chunkCount - result.cachedCount} generated, ${result.cachedCount} from cache
 core cycles         ${result.coreCycles}
 split fallbacks     ${result.splitFallbacks}

 duration            ${formatDuration(m.durationSec)}  (${m.durationSec.toFixed(1)}s)
 estimated           ${formatDuration(result.estimatedSec)}
 integrated loudness ${m.integratedLufs.toFixed(2)} LUFS   (target -23)
 true peak           ${m.truePeakDb.toFixed(2)} dBTP     (target < -3)
 loudness range      ${m.lra.toFixed(2)} LU

 per-chunk RMS       mean ${mean(m.chunkRmsDb).toFixed(2)} dBFS, sd ${m.chunkRmsStdDb.toFixed(2)} dB
 per-chunk rate      mean ${mean(wpm).toFixed(1)} wpm, min ${Math.min(...wpm).toFixed(1)}, max ${Math.max(...wpm).toFixed(1)}
 effective rate      ${((spoken * result.coreCycles) / (m.durationSec / 60)).toFixed(1)} words/min of track
 monotonic after 4m  ${m.monotonicAfterMin4 ? 'YES' : 'NO — LEVEL RISES'}

 files               ${result.opusPath}
                     ${result.aacPath}
════════════════════════`);

  await writeFile(`${outBase}.measurement.json`, JSON.stringify(m, null, 2));

  // Flag chunks whose level or rate is an outlier — the known weak point of chunked TTS.
  const rmsMean = mean(m.chunkRmsDb.filter(Number.isFinite));
  const outliers = m.chunkRmsDb
    .map((v, i) => ({ i, v }))
    .filter((c) => Number.isFinite(c.v) && Math.abs(c.v - rmsMean) > 2 * m.chunkRmsStdDb);
  if (outliers.length) {
    console.log(`\n⚠ ${outliers.length} chunk(s) more than 2σ off the mean level — candidates for regeneration:`);
    for (const o of outliers) console.log(`   chunk ${o.i}: ${o.v.toFixed(2)} dBFS`);
  }
}

main().catch((e) => {
  console.error(`\n${e.message ?? e}`);
  process.exit(1);
});
