'use client';

import { asset } from '@/lib/paths';

/**
 * Finished tracks that ship with the app.
 *
 * These are real output, not demos: written from a real intake, spoken by the real voice,
 * assembled by the real pipeline, with the measured numbers each one actually hit. They
 * exist so the app is worth opening before you have generated anything, and so you can hear
 * what an hour of it is like without spending an API call.
 *
 * They stream from their URL rather than being copied into IndexedDB. Copying 17 MB of audio
 * into every visitor's storage to show them a sample would be rude, and the browser caches
 * the file anyway once it has been played.
 */

export interface ExampleTrack {
  id: string;
  name: string;
  file: string;
  mime: string;
  durationSec: number;
  bytes: number;
  /** What the track is about, in the listener's own words. */
  goals: string[];
  /** Measured on the finished file. */
  lufs: number;
  truePeakDb: number;
  voice: string;
  madeAt: string;
}

export const EXAMPLES: ExampleTrack[] = [
  {
    id: 'dream-5min',
    name: 'Four times a week — affirmations only, each said two or three times',
    file: 'dream-5min.m4a',
    mime: 'audio/mp4',
    durationSec: 300.0,
    bytes: 1221509,
    goals: [
      'Four times a week, already normal',
      'Strength I can feel, and numbers that move',
      'The bike, the freedom, money I earned',
    ],
    lufs: -25.1,
    truePeakDb: -3.5,
    voice: 'Sulafat',
    madeAt: '2026-08-12',
  },
  {
    id: 'dream-15min',
    name: 'Four times a week — the body, the bike, the life',
    file: 'dream-15min.m4a',
    mime: 'audio/mp4',
    durationSec: 930.3,
    bytes: 3823105,
    goals: [
      'Get back to the gym four times a week and stay there',
      'Get properly strong and build a body that looks like it trains',
      'Build the life I am training for — the bike, the freedom, money I earned',
    ],
    lufs: -24.5,
    truePeakDb: -3.5,
    voice: 'Sulafat',
    madeAt: '2026-08-11',
  },
  {
    id: 'gym-10min',
    name: 'Training — showing up, and the last few reps',
    file: 'gym-10min.m4a',
    mime: 'audio/mp4',
    durationSec: 623.4,
    bytes: 2555126,
    goals: [
      'Train consistently instead of going hard for two weeks then stopping',
      'Push properly on the last few reps',
      'Stop measuring my training against people who have been at it for years',
    ],
    lufs: -25.1,
    truePeakDb: -3.5,
    voice: 'Sulafat',
    madeAt: '2026-08-11',
  },
];

export function exampleUrl(track: ExampleTrack): string {
  return asset(`/examples/${track.file}`);
}

export function findExample(id: string): ExampleTrack | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
