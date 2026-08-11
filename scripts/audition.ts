/**
 * Generate a 20-second audition of the same passage in every plausible female-presenting
 * voice, so the choice is made by ear rather than by me guessing from a one-word
 * descriptor. Output lands in public/auditions/ and is served by the audition picker.
 *
 *   GEMINI_API_KEY=... npx tsx scripts/audition.ts
 *
 * At 3 requests/minute this takes about five minutes for the full set. Cached, so a
 * re-run is free.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { synthesizeChunk } from '@/lib/gemini/tts';
import { pcmToWav, pcmDurationSec, pcmRmsDb } from '@/lib/gemini/wav';
import { AUDITION_PASSAGE, AUDITION_VOICES } from '@/lib/voices';
import { ffmpeg } from '@/lib/audio/ffmpeg';

const OUT = join(process.cwd(), 'public', 'auditions');

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const voices = only.length ? AUDITION_VOICES.filter((v) => only.includes(v.name)) : AUDITION_VOICES;
  await mkdir(OUT, { recursive: true });

  const rows: Array<{ voice: string; sec: number; rms: number }> = [];

  for (const v of voices) {
    process.stdout.write(`${v.name.padEnd(14)} `);
    try {
      const res = await synthesizeChunk(
        { section: 'core', text: AUDITION_PASSAGE, voice: v.name },
        { onWait: (s, _a, why) => process.stdout.write(`[${why} ${s.toFixed(0)}s] `) },
      );
      const wav = join(OUT, `${v.name}.wav`);
      await writeFile(wav, pcmToWav(res.pcm));
      // Same conditioning the real track gets, so the audition sounds like the product.
      await ffmpeg([
        '-i', wav,
        '-af', 'highpass=f=80,deesser=i=0.4:m=0.5:f=0.35,lowpass=f=10000,loudnorm=I=-23:TP=-3:LRA=7',
        '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart',
        join(OUT, `${v.name}.m4a`),
      ]);
      const sec = pcmDurationSec(res.pcm);
      rows.push({ voice: v.name, sec, rms: pcmRmsDb(res.pcm) });
      const words = AUDITION_PASSAGE.split(/\s+/).length;
      console.log(
        `${res.cached ? 'cached' : 'new   '}  ${sec.toFixed(1)}s  ${((words / sec) * 60).toFixed(0)} wpm  ${pcmRmsDb(res.pcm).toFixed(1)} dBFS`,
      );
    } catch (e) {
      console.log(`FAILED — ${(e as Error).message.slice(0, 120)}`);
    }
  }

  await writeFile(
    join(OUT, 'index.json'),
    JSON.stringify(
      { passage: AUDITION_PASSAGE, generatedAt: new Date().toISOString(), voices: rows },
      null,
      2,
    ),
  );
  console.log(`\n${rows.length} auditions in public/auditions/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
