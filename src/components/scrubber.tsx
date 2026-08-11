'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ARC, formatDuration } from '@/lib/script/plan';

/**
 * Seek bar.
 *
 * The player deliberately had no scrubber: the brief asked for play, pause, timer, volume and
 * nothing else, on the grounds that anything more invites fiddling at 2am. Being able to move
 * around a sixty-minute track is a fair thing to want anyway, so the compromise is a control
 * that is easy to hit deliberately and hard to hit by accident — a hairline track with a
 * 44-pixel touch band around it, no bright fill, and a handle that only appears once you are
 * actually dragging.
 *
 * The section marks are the useful part. A track has a known shape — arrival, downshift, core,
 * second pass, dissolution, fade — so the ticks let you jump straight to the affirmations
 * rather than hunting for where the body scan ends.
 */

export interface Section {
  label: string;
  startSec: number;
}

/**
 * Section boundaries for a track of this length. The assembler lands every section on its
 * budgeted share of the runtime, so the boundaries are those shares of the real duration.
 */
export function sectionsFor(durationSec: number): Section[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  let t = 0;
  const out: Section[] = [];
  for (const spec of ARC) {
    out.push({ label: spec.label, startSec: t });
    t += spec.share * durationSec;
  }
  return out;
}

/**
 * Where a loop should restart.
 *
 * Not zero. The opening two sections are a breath cue and a body scan whose whole job is to
 * get you from awake to nearly-asleep; hearing them again at 2am would be starting the
 * settling-down process over on someone who is already settled. The affirmations are the part
 * worth repeating, so a loop rejoins at the core section.
 */
export function loopStartSec(durationSec: number): number {
  const core = sectionsFor(durationSec).find((s) => s.label === 'Core affirmations');
  return core ? core.startSec : 0;
}

export function Scrubber({
  position,
  duration,
  onSeek,
  disabled,
}: {
  position: number;
  duration: number;
  onSeek: (sec: number) => void;
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);

  const shown = preview ?? position;
  const pct = duration > 0 ? Math.min(1, Math.max(0, shown / duration)) : 0;
  const sections = sectionsFor(duration);

  const secondsAt = useCallback(
    (clientX: number): number | null => {
      const el = trackRef.current;
      if (!el || duration <= 0) return null;
      const box = el.getBoundingClientRect();
      // A zero-width box means the bar is not laid out — hidden tab, collapsed pane, mid
      // transition. Dividing by it yields NaN, which clamps to 0 and silently throws the
      // listener back to the start of the track. Refuse instead.
      if (box.width <= 0) return null;
      const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
      return ratio * duration;
    },
    [duration],
  );

  // Listeners live on the window so a drag that leaves the bar keeps working instead of
  // stopping dead — the usual failure of a hand-rolled slider.
  //
  // Note that the seek happens on pointer*down*, not on release. Waiting for release meant a
  // quick tap did nothing at all: the listeners below are attached by an effect, which does
  // not run until after the render that `setDragging` triggers, so a fast tap's `pointerup`
  // landed before anything was listening. Seeking on press also just feels better — the
  // track jumps where you touched it rather than when you let go.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const t = secondsAt(e.clientX);
      if (t === null) return;
      setPreview(t);
      onSeek(t);
    };
    const up = (e: PointerEvent) => {
      const t = secondsAt(e.clientX);
      if (t !== null) onSeek(t);
      setDragging(false);
      setPreview(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, onSeek, secondsAt]);

  return (
    <div className="w-full">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Position in track"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={formatDuration(shown)}
        onPointerDown={(e) => {
          if (disabled) return;
          const t = secondsAt(e.clientX);
          if (t === null) return;
          setDragging(true);
          setPreview(t);
          onSeek(t);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          const step = e.shiftKey ? 300 : 30;
          if (e.key === 'ArrowLeft') onSeek(Math.max(0, position - step));
          else if (e.key === 'ArrowRight') onSeek(Math.min(duration, position + step));
          else if (e.key === 'Home') onSeek(0);
          else return;
          e.preventDefault();
        }}
        // Tall invisible band: easy to hit in the dark, without a fat bright bar on screen.
        className="relative flex h-11 w-full cursor-pointer touch-none items-center"
      >
        <div className="relative h-px w-full bg-ink-700">
          <div className="absolute inset-y-0 left-0 bg-ink-500" style={{ width: `${pct * 100}%` }} />

          {sections.map((s) => (
            <span
              key={s.label}
              title={`${s.label} — ${formatDuration(s.startSec)}`}
              className="absolute -top-1 h-[9px] w-px bg-ink-600"
              style={{ left: `${duration > 0 ? (s.startSec / duration) * 100 : 0}%` }}
            />
          ))}

          <span
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-300 transition-[height,width] ${
              dragging ? 'h-4 w-4' : 'h-2.5 w-2.5'
            }`}
            style={{ left: `${pct * 100}%` }}
          />
        </div>
      </div>

      <div className="flex items-baseline justify-between text-xs tabular-nums text-ink-500">
        <span>{formatDuration(shown)}</span>
        <span className="text-ink-600">
          {sections.length > 0 && duration > 0
            ? [...sections].reverse().find((s) => shown >= s.startSec - 0.001)?.label
            : ''}
        </span>
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  );
}
