'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getAudio, getTrack } from '@/lib/db';
import { formatDuration } from '@/lib/script/plan';
import type { TrackMeta } from '@/lib/types';

/**
 * The player.
 *
 * Designed for a dark room and a half-asleep hand: five controls, all of them large, on a
 * near-black surface with nothing brighter than #a8a8b0. The screen dims to black after ten
 * seconds and stays there until touched.
 *
 * Two things this must survive, because they are where every web audio player breaks:
 * screen lock and backgrounding. That means no Wake Lock (the point is for the screen to go
 * off), a plain <audio> element rather than WebAudio (Safari suspends AudioContext when
 * backgrounded, but a media element keeps playing), and a Media Session so the lock screen
 * controls work.
 */

export default function PlayerPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-ink-950" />}>
      <Player />
    </Suspense>
  );
}

const TIMERS = [0, 15, 30, 45, 60] as const;

function Player() {
  const trackId = useSearchParams().get('t');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [meta, setMeta] = useState<TrackMeta | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.7);
  const [timerMin, setTimerMin] = useState<number>(0);
  const [dim, setDim] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!trackId) return;
    let revoke: string | null = null;
    (async () => {
      const [m, blob] = await Promise.all([getTrack(trackId), getAudio(trackId)]);
      if (m) setMeta(m);
      if (blob) {
        revoke = URL.createObjectURL(blob);
        setUrl(revoke);
      }
    })();
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [trackId]);

  // Dim to black after ten seconds of no touching, and stay there.
  const wake = useCallback(() => {
    setDim(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setDim(true), 10000);
  }, []);

  useEffect(() => {
    // Start the idle countdown without touching state on mount — `dim` already starts false.
    idleTimer.current = setTimeout(() => setDim(true), 10000);
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, wake);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [wake]);

  // Sleep timer: fade the volume down over the last 30 seconds rather than cutting, so the
  // stop is never itself an event.
  useEffect(() => {
    if (!timerMin || !playing) return;
    const el = audioRef.current;
    if (!el) return;
    const endsAt = Date.now() + timerMin * 60_000;
    const tick = setInterval(() => {
      const left = endsAt - Date.now();
      if (left <= 0) {
        el.pause();
        el.volume = volume;
        setPlaying(false);
        setTimerMin(0);
      } else if (left < 30_000) {
        el.volume = volume * (left / 30_000);
      }
    }, 500);
    return () => {
      clearInterval(tick);
      el.volume = volume;
    };
  }, [timerMin, playing, volume]);

  // Lock-screen controls.
  useEffect(() => {
    if (!meta || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.name,
      artist: 'Nightscript',
      album: new Date(meta.createdAt).toLocaleDateString(),
    });
    navigator.mediaSession.setActionHandler('play', () => void audioRef.current?.play());
    navigator.mediaSession.setActionHandler('pause', () => audioRef.current?.pause());
    // Deliberately no seek / next / previous handlers: nothing on the lock screen should
    // invite fiddling at 2am.
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
    };
  }, [meta]);

  useEffect(() => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }, [playing]);

  async function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      try {
        await el.play();
      } catch {
        setUnsupported(true);
      }
    } else {
      el.pause();
    }
  }

  if (!trackId) return <Empty />;

  return (
    <div className="flex min-h-dvh flex-col bg-ink-950" onClick={wake}>
      <audio
        ref={audioRef}
        src={url ?? undefined}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onError={() => setUnsupported(true)}
      />

      <div className={`dimmable flex flex-1 flex-col ${dim && playing ? 'dimmed' : ''}`}>
        <header className="px-6 pt-6">
          <Link href="/" className="text-sm text-ink-500 hover:text-ink-300">
            ← Library
          </Link>
        </header>

        <div className="flex flex-1 flex-col items-center justify-center gap-10 px-6">
          <div className="text-center">
            <h1 className="text-base font-normal text-ink-300">{meta?.name ?? '—'}</h1>
            <p className="mt-2 text-sm tabular-nums text-ink-500">
              {formatDuration(position)} / {formatDuration(duration || meta?.durationSec || 0)}
            </p>
          </div>

          <button
            onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            className="flex h-40 w-40 items-center justify-center rounded-full border border-ink-700 bg-ink-900 active:bg-ink-850"
          >
            {playing ? (
              <span className="flex gap-3">
                <span className="block h-12 w-3.5 rounded-sm bg-ink-400" />
                <span className="block h-12 w-3.5 rounded-sm bg-ink-400" />
              </span>
            ) : (
              <span
                className="ml-2 block h-0 w-0 border-y-[26px] border-l-[42px] border-y-transparent"
                style={{ borderLeftColor: 'var(--color-ink-400)' }}
              />
            )}
          </button>

          <div className="w-full max-w-xs">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              aria-label="Volume"
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                if (audioRef.current) audioRef.current.volume = v;
              }}
              className="h-11 w-full"
            />
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            {TIMERS.map((t) => (
              <button
                key={t}
                onClick={() => setTimerMin(t)}
                className={`min-h-11 min-w-16 rounded-lg border px-4 text-sm ${
                  timerMin === t
                    ? 'border-ink-500 bg-ink-800 text-ink-200'
                    : 'border-ink-800 text-ink-500'
                }`}
              >
                {t === 0 ? 'no timer' : `${t}m`}
              </button>
            ))}
          </div>

          {unsupported && (
            <p className="max-w-xs text-center text-xs leading-relaxed text-warm-300">
              This browser could not play the stored file. Regenerate the track here — the app
              picks the format the browser reports it can play, and the AAC fallback exists for
              exactly this.
            </p>
          )}
        </div>

        <footer className="px-6 pb-8 text-center">
          <p className="text-xs text-ink-600">
            The screen goes dark on its own. Playing continues when it locks.
          </p>
        </footer>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink-950">
      <Link href="/" className="text-sm text-ink-400">
        Nothing selected — back to the library
      </Link>
    </div>
  );
}
