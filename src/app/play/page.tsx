'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getAudio, getTrack } from '@/lib/db';
import { exampleUrl, findExample } from '@/lib/examples';
import { Scrubber } from '@/components/scrubber';
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
  const params = useSearchParams();
  const trackId = params.get('t');
  const exampleId = params.get('ex');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // A shipped example is known synchronously from the URL, so it is derived during render
  // rather than pushed in from an effect.
  const example = exampleId ? findExample(exampleId) : undefined;
  const [storedMeta, setMeta] = useState<TrackMeta | null>(null);
  const [storedUrl, setUrl] = useState<string | null>(null);

  // Memoised so the object identity is stable — an effect below depends on `meta`, and a
  // fresh object every render would restart the Media Session on every tick. `Date.parse`
  // of a fixed string is pure; the `Date.now()` fallback is not, so it is not used here.
  const exampleMeta = useMemo<TrackMeta | null>(
    () =>
      example
        ? ({
            id: example.id,
            name: example.name,
            createdAt: Date.parse(example.madeAt) || 0,
            durationSec: example.durationSec,
            bytes: example.bytes,
            mime: example.mime,
          } as TrackMeta)
        : null,
    [example],
  );
  const meta: TrackMeta | null = exampleMeta ?? storedMeta;
  const url = example ? exampleUrl(example) : storedUrl;
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    if (typeof localStorage === 'undefined') return 0.7;
    const saved = Number(localStorage.getItem('nightscript.volume'));
    return Number.isFinite(saved) && saved > 0 ? Math.min(1, saved) : 0.7;
  });
  const [timerMin, setTimerMin] = useState<number>(0);
  const [dim, setDim] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // A shipped example streams from its own URL (handled above); a generated track comes
    // out of IndexedDB as a blob. Everything downstream — controls, timer, lock screen — is
    // identical either way.
    if (exampleId || !trackId) return;
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
  }, [trackId, exampleId]);

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

  const seek = useCallback((sec: number) => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(sec)) return;
    el.currentTime = Math.min(Math.max(0, sec), el.duration || sec);
    setPosition(el.currentTime);
  }, []);

  const skip = useCallback(
    (delta: number) => seek((audioRef.current?.currentTime ?? 0) + delta),
    [seek],
  );

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
    // Seeking from the lock screen, so you do not have to unlock the phone to move a minute
    // back. Still no next/previous — there is nothing to skip to.
    navigator.mediaSession.setActionHandler('seekbackward', (d) => skip(-(d.seekOffset ?? 60)));
    navigator.mediaSession.setActionHandler('seekforward', (d) => skip(d.seekOffset ?? 60));
    try {
      navigator.mediaSession.setActionHandler('seekto', (d) => {
        if (d.seekTime != null) seek(d.seekTime);
      });
    } catch {
      // Older browsers do not know 'seekto'; the offsets above still work.
    }
    return () => {
      for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'] as const) {
        try {
          navigator.mediaSession.setActionHandler(a, null);
        } catch {
          /* ignore actions this browser does not support */
        }
      }
    };
  }, [meta, seek, skip]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    // Without this the lock-screen scrubber sits at zero and cannot be dragged.
    if (duration > 0 && 'setPositionState' in navigator.mediaSession) {
      try {
        navigator.mediaSession.setPositionState({
          duration,
          position: Math.min(position, duration),
          playbackRate: 1,
        });
      } catch {
        /* a position briefly out of range while seeking is not worth throwing over */
      }
    }
  }, [playing, position, duration]);

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

  if (!trackId && !exampleId) return <Empty />;

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
          </div>

          <div className="flex items-center gap-6">
            <button
              onClick={() => skip(-60)}
              aria-label="Back one minute"
              className="flex h-16 w-16 items-center justify-center rounded-full border border-ink-800 text-sm text-ink-400 active:bg-ink-850"
            >
              −1m
            </button>

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

            <button
              onClick={() => skip(60)}
              aria-label="Forward one minute"
              className="flex h-16 w-16 items-center justify-center rounded-full border border-ink-800 text-sm text-ink-400 active:bg-ink-850"
            >
              +1m
            </button>
          </div>

          <div className="w-full max-w-md">
            <Scrubber
              position={position}
              duration={duration || meta?.durationSec || 0}
              onSeek={seek}
              disabled={!url}
            />
          </div>

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
                localStorage.setItem('nightscript.volume', String(v));
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
