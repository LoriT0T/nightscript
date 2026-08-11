'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Shell } from '@/components/ui';
import {
  deleteDraft,
  deleteTrack,
  getAudio,
  listDrafts,
  listTracks,
  openDatabase,
  storageEstimate,
  type Draft,
} from '@/lib/db';
import { formatDuration } from '@/lib/script/plan';
import { EXAMPLES, exampleUrl } from '@/lib/examples';
import type { TrackMeta } from '@/lib/types';

/**
 * The library. Note what is deliberately absent: no streak counter, no "you have not
 * listened in 4 days", no badges, no reminders. This runs at bedtime for someone trying to
 * sleep; every retention mechanic is a reason to be awake.
 */
/**
 * Save a track out as a file.
 *
 * Tracks live in this browser's storage, which is the right default but makes them awkward
 * to move: a track generated on a laptop cannot be reached from a phone, and clearing site
 * data takes it with it. This is the escape hatch — the same bytes, on disk, playable in
 * anything.
 */
async function saveToFile(name: string, source: string | Blob, mime: string) {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source;
  const ext = mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'm4a' : 'webm';
  const safe = name.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'nightscript';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function Library() {
  const [tracks, setTracks] = useState<TrackMeta[] | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const opened = await openDatabase();
    if (!opened.ok) {
      setStorageError(opened.message);
      setTracks([]);
      return;
    }
    setStorageError(null);
    const [t, d, s] = await Promise.all([listTracks(), listDrafts(), storageEstimate()]);
    setTracks(t);
    setDrafts(d.filter((x) => !t.some((tr) => tr.script === x.script)));
    setStorage(s);
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  return (
    <Shell>
      <header className="mb-10">
        <h1 className="text-2xl font-normal tracking-wide text-ink-100">Nightscript</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-400">
          An hour of quiet, written for you, to fall asleep to.
        </p>
      </header>

      <Link
        href="/new"
        className="mb-10 block rounded-xl border border-ink-700 bg-ink-900 px-4 py-4 text-sm text-ink-200 hover:bg-ink-850"
      >
        Make a new track →
      </Link>

      {storageError && (
        <div className="mb-8 rounded-xl border border-alert-400/40 bg-ink-900 p-4">
          <p className="text-sm leading-relaxed text-warm-300">{storageError}</p>
          <Button className="mt-3" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      )}

      {tracks === null && !storageError && <p className="text-sm text-ink-500">Loading…</p>}

      {tracks && tracks.length === 0 && drafts.length === 0 && (
        <p className="mb-10 text-sm leading-relaxed text-ink-500">
          You have not made one yet. A track takes a few minutes to make and then plays free
          forever — it lives on this device, not on a server. There are finished ones below to
          listen to first.
        </p>
      )}

      {EXAMPLES.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-xs uppercase tracking-widest text-ink-600">Finished tracks</h2>
          <p className="mb-3 text-xs leading-relaxed text-ink-500">
            Made with this app, ready to play. Nothing to generate and no key needed.
          </p>
          <ul className="space-y-2">
            {EXAMPLES.map((e) => (
              <li key={e.id} className="rounded-xl border border-ink-800 bg-ink-900/40 p-4">
                <div className="flex items-start justify-between gap-4">
                  <Link href={`/play?ex=${e.id}`} className="min-w-0 flex-1">
                    <p className="text-sm text-ink-100">{e.name}</p>
                    <p className="mt-1 text-xs text-ink-500">
                      {formatDuration(e.durationSec)} · {(e.bytes / 1e6).toFixed(1)} MB · {e.voice}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-600">{e.goals.join(' · ')}</p>
                    <p className="mt-1 text-xs tabular-nums text-ink-600">
                      {e.lufs.toFixed(1)} LUFS · peak {e.truePeakDb.toFixed(1)} dBTP
                    </p>
                  </Link>
                  <button
                    onClick={() => saveToFile(e.name, exampleUrl(e), e.mime)}
                    className="text-xs text-ink-500 hover:text-ink-300"
                  >
                    save
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tracks && tracks.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-xs uppercase tracking-widest text-ink-600">Your tracks</h2>
          <ul className="space-y-2">
            {tracks.map((t) => (
              <li key={t.id} className="rounded-xl border border-ink-800 bg-ink-900/40 p-4">
                <div className="flex items-start justify-between gap-4">
                  <Link href={`/play?t=${t.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink-100">{t.name}</p>
                    <p className="mt-1 text-xs text-ink-500">
                      {formatDuration(t.durationSec)} · {(t.bytes / 1e6).toFixed(1)} MB ·{' '}
                      {new Date(t.createdAt).toLocaleDateString()} · {t.settings.voice}
                    </p>
                    <p className="mt-1 truncate text-xs text-ink-600">
                      {t.intake.goals.map((g) => g.text).join(' · ')}
                    </p>
                    {t.measured && (
                      <p className="mt-1 text-xs tabular-nums text-ink-600">
                        {t.measured.integratedLufs.toFixed(1)} LUFS · peak{' '}
                        {t.measured.truePeakDb.toFixed(1)} dBTP
                        {t.measured.monotonicAfterMin4 ? '' : ' · level rises somewhere'}
                      </p>
                    )}
                  </Link>
                  <div className="flex flex-col items-end gap-1">
                    <button
                      onClick={async () => {
                        const blob = await getAudio(t.id);
                        if (blob) await saveToFile(t.name, blob, t.mime);
                      }}
                      className="text-xs text-ink-500 hover:text-ink-300"
                    >
                      save
                    </button>
                    <Link
                      href={`/new?from=${t.id}`}
                      className="text-xs text-ink-500 hover:text-ink-300"
                    >
                      remake
                    </Link>
                    <button
                      onClick={async () => {
                        await deleteTrack(t.id);
                        void refresh();
                      }}
                      className="text-xs text-ink-600 hover:text-alert-400"
                    >
                      delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {drafts.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-xs uppercase tracking-widest text-ink-600">Unfinished</h2>
          <ul className="space-y-2">
            {drafts.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-ink-850 px-4 py-3"
              >
                <Link href={`/review?d=${d.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink-300">{d.name}</p>
                  <p className="text-xs text-ink-600">
                    {d.script ? `${d.script.lines.length} lines written` : 'no script yet'}
                  </p>
                </Link>
                <Button
                  variant="quiet"
                  onClick={async () => {
                    await deleteDraft(d.id);
                    void refresh();
                  }}
                >
                  discard
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-16 border-t border-ink-850 pt-6 text-xs text-ink-600">
        <Link href="/about" className="hover:text-ink-400">
          About this, and what it is not
        </Link>
        {storage && (
          <p className="mt-2">
            {(storage.usage / 1e6).toFixed(0)} MB used on this device.
          </p>
        )}
      </footer>
    </Shell>
  );
}
