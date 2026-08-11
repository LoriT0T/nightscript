'use client';

import { useState } from 'react';
import { assembleInBrowser, type ChunkPcm } from '@/lib/audio/webaudio';
import { encodeMp3 } from '@/lib/audio/mp3';
import { buildTimeline, planChunks } from '@/lib/script/plan';
import type { Script, TrackSettings } from '@/lib/types';

/**
 * Full-length scale harness. Development only — it refuses to run outside `next dev`, and
 * the script fixture it reads is not deployed.
 *
 * Runs the real timeline, the real assembler, the real measurement and the real encoder
 * over a real 60-minute script, with locally synthesized speech-shaped audio standing in
 * for the API. It exists to answer the two questions a short test cannot: does an hour fit
 * in browser memory, and do the numbers still land at full length. It costs zero requests.
 */
export default function DevScale() {
  const [log, setLog] = useState<string[]>(['idle']);
  const [running, setRunning] = useState(false);
  const say = (m: string) => setLog((l) => [...l, m]);

  async function runScale(minutes = 60) {
    const t0 = performance.now();
    const res = await fetch('/_scale.json');
    if (!res.ok) {
      throw new Error(
        'Missing public/_scale.json. Create it with: node -e "const s=require(\'./out/track.script.json\');require(\'fs\').writeFileSync(\'public/_scale.json\',JSON.stringify({script:s}))"',
      );
    }
    const script = ((await res.json()).script) as Script;
    const chunks = planChunks(script);
    chunks.forEach((c, i) => (c.hashKey = `scale:${i}`));
    const { plays, coreCycles } = buildTimeline(chunks, minutes);

    // Speech-shaped stand-in: a formant-ish burst per line, separated by real gaps so the
    // silence splitter takes its true path rather than the fallback.
    const fs = 24000;
    const audio = new Map<string, ChunkPcm>();
    for (const c of chunks) {
      const wordsPerLine = c.lines.map((l) => l.text.trim().split(/\s+/).length);
      const segSamples = wordsPerLine.map((w) => Math.round((w / 86) * 60 * fs));
      const gap = Math.round(0.6 * fs);
      const total = segSamples.reduce((a, b) => a + b, 0) + gap * (c.lines.length - 1);
      const pcm = new Int16Array(total);
      let o = 0;
      segSamples.forEach((n, i) => {
        if (i > 0) o += gap;
        for (let j = 0; j < n; j++) {
          const env = Math.sin((Math.PI * j) / n);
          const v =
            Math.sin((2 * Math.PI * 180 * j) / fs) * 0.5 +
            Math.sin((2 * Math.PI * 700 * j) / fs) * 0.3 +
            (Math.random() * 2 - 1) * 0.06;
          pcm[o + j] = Math.round(v * env * 8000);
        }
        o += n;
      });
      audio.set(c.hashKey, { hashKey: c.hashKey, pcm, lineCount: c.lines.length });
    }

    const settings: TrackSettings = { voice: 'Sulafat', bed: 'pink', bedLevelDb: -34, minutes };
    const assembled = await assembleInBrowser({ plays, audio, settings, onProgress: say });
    const { blob } = await encodeMp3(assembled.samples, assembled.sampleRate);

    const m = assembled.measurement;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const result = {
      minutes,
      chunks: chunks.length,
      plays: plays.length,
      coreCycles,
      splitFallbacks: assembled.splitFallbacks,
      durationSec: +m.durationSec.toFixed(1),
      durationMMSS: `${Math.floor(m.durationSec / 60)}:${String(Math.round(m.durationSec % 60)).padStart(2, '0')}`,
      integratedLufs: +m.integratedLufs.toFixed(2),
      truePeakDb: +m.truePeakDb.toFixed(2),
      minutePeakDb: m.minutePeakDb.map((v) => +v.toFixed(1)),
      monotonicAfterMin4: m.monotonicAfterMin4,
      mp3Bytes: blob.size,
      mp3MB: +(blob.size / 1e6).toFixed(2),
      heapMB: mem ? +(mem.usedJSHeapSize / 1e6).toFixed(0) : null,
      wallSec: +((performance.now() - t0) / 1000).toFixed(1),
    };
    say(JSON.stringify(result));
    return result;
  }

  if (process.env.NODE_ENV === 'production') {
    return <p className="p-6 text-sm text-ink-400">Development harness. Not available here.</p>;
  }

  return (
    <div className="p-6">
      <button
        onClick={async () => {
          setRunning(true);
          try {
            await runScale(60);
          } catch (e) {
            say(`FAILED: ${(e as Error).message}`);
          }
          setRunning(false);
        }}
        disabled={running}
        className="rounded border border-ink-600 bg-ink-800 px-4 py-2 text-sm text-ink-200 disabled:opacity-40"
      >
        {running ? 'running…' : 'Run 60-minute scale test'}
      </button>
      <pre className="mt-6 whitespace-pre-wrap text-xs text-ink-300">{log.join('\n')}</pre>
    </div>
  );
}
