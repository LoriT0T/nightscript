'use client';

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Intake, Script, TrackMeta, TrackSettings } from './types';

/**
 * Local-first storage. Everything the listener writes and everything generated for them
 * lives in IndexedDB on their own device. Nothing about their goals is stored on a server;
 * the server is a stateless proxy that holds the API key and runs ffmpeg.
 */

export interface Draft {
  id: string;
  name: string;
  updatedAt: number;
  intake: Intake;
  settings: TrackSettings;
  script?: Script;
}

interface NightscriptDB extends DBSchema {
  tracks: { key: string; value: TrackMeta; indexes: { createdAt: number } };
  audio: { key: string; value: { id: string; blob: Blob; mime: string } };
  drafts: { key: string; value: Draft; indexes: { updatedAt: number } };
  /** Spoken chunks, keyed by a hash of everything that can change the audio. */
  chunks: { key: string; value: { hash: string; pcm: ArrayBuffer; at: number } };
}

let dbp: Promise<IDBPDatabase<NightscriptDB>> | null = null;

function db() {
  if (!dbp) {
    dbp = openDB<NightscriptDB>('nightscript', 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          const tracks = d.createObjectStore('tracks', { keyPath: 'id' });
          tracks.createIndex('createdAt', 'createdAt');
          d.createObjectStore('audio', { keyPath: 'id' });
          const drafts = d.createObjectStore('drafts', { keyPath: 'id' });
          drafts.createIndex('updatedAt', 'updatedAt');
        }
        if (oldVersion < 2) {
          d.createObjectStore('chunks', { keyPath: 'hash' });
        }
      },
    });
  }
  return dbp;
}

export async function listTracks(): Promise<TrackMeta[]> {
  const d = await db();
  const all = await d.getAllFromIndex('tracks', 'createdAt');
  return all.reverse();
}

export async function getTrack(id: string): Promise<TrackMeta | undefined> {
  return (await db()).get('tracks', id);
}

export async function saveTrack(meta: TrackMeta, blob: Blob): Promise<void> {
  const d = await db();
  await d.put('tracks', meta);
  await d.put('audio', { id: meta.id, blob, mime: meta.mime });
}

export async function updateTrack(meta: TrackMeta): Promise<void> {
  await (await db()).put('tracks', meta);
}

export async function getAudio(id: string): Promise<Blob | undefined> {
  return (await (await db()).get('audio', id))?.blob;
}

export async function deleteTrack(id: string): Promise<void> {
  const d = await db();
  await d.delete('tracks', id);
  await d.delete('audio', id);
}

export async function listDrafts(): Promise<Draft[]> {
  const d = await db();
  return (await d.getAllFromIndex('drafts', 'updatedAt')).reverse();
}

export async function getDraft(id: string): Promise<Draft | undefined> {
  return (await db()).get('drafts', id);
}

export async function saveDraft(draft: Draft): Promise<void> {
  await (await db()).put('drafts', { ...draft, updatedAt: Date.now() });
}

export async function deleteDraft(id: string): Promise<void> {
  await (await db()).delete('drafts', id);
}

/**
 * Spoken-chunk cache.
 *
 * Editing one line of a script must not re-spend the whole hour of speech. Chunks are keyed
 * by a hash of everything that can change the audio — voice, model, section and the exact
 * text — so an edit only invalidates the chunks that line is actually in, and regenerating
 * a track after a small change is close to free.
 */
export async function getCachedChunk(hash: string): Promise<Int16Array | null> {
  const row = await (await db()).get('chunks', hash);
  return row ? new Int16Array(row.pcm) : null;
}

export async function putCachedChunk(hash: string, pcm: Int16Array): Promise<void> {
  const copy = pcm.slice();
  await (await db()).put('chunks', {
    hash,
    pcm: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
    at: Date.now(),
  });
}

/** Drop cached speech older than the given age. Nothing calls this automatically yet. */
export async function pruneChunks(maxAgeMs = 90 * 24 * 60 * 60 * 1000): Promise<number> {
  const d = await db();
  const all = await d.getAll('chunks');
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const row of all) {
    if (row.at < cutoff) {
      await d.delete('chunks', row.hash);
      removed++;
    }
  }
  return removed;
}

/** Rough storage footprint, so the library can show it without guessing. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

export const newId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
