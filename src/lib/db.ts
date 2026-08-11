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

const DB_NAME = 'nightscript';
const DB_VERSION = 2;

/**
 * Raised when the database cannot be opened because another tab is holding an older version
 * open. Distinct from a generic failure because the fix is specific and the user can do it.
 */
export class DatabaseBlockedError extends Error {
  constructor() {
    super(
      'Another tab has an older version of Nightscript open, which is stopping this one from ' +
        'starting. Close the other Nightscript tabs and reload.',
    );
    this.name = 'DatabaseBlockedError';
  }
}

let dbp: Promise<IDBPDatabase<NightscriptDB>> | null = null;

/**
 * Open the database.
 *
 * Three things here are scar tissue, all from the same incident: a schema version was
 * deployed while the app was open in a tab, and every page that touched storage hung on
 * "Loading…" forever with no error and no way back.
 *
 *  1. `blocking` — this tab is the one holding the OLD version open and stopping another tab
 *     from upgrading. Close our connection so the other tab can proceed.
 *  2. `blocked` — we are the tab trying to upgrade and someone else is in the way. Fail with
 *     a message that names the actual fix instead of hanging.
 *  3. The promise is no longer memoised through a rejection. Caching a rejected promise made
 *     a single transient failure permanent for the life of the page.
 */
function db(): Promise<IDBPDatabase<NightscriptDB>> {
  if (!dbp) {
    dbp = openDB<NightscriptDB>(DB_NAME, DB_VERSION, {
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
      blocked() {
        // Another tab is holding an older version. openDB's promise would otherwise never
        // settle; rejecting turns an infinite spinner into a message.
        throw new DatabaseBlockedError();
      },
      blocking() {
        // We are the stale tab. Get out of the way so the newer one can upgrade.
        void dbp?.then((d) => d.close()).catch(() => {});
        dbp = null;
      },
      terminated() {
        dbp = null;
      },
    }).catch((e) => {
      // Never leave a rejected promise cached, or the page can never recover.
      dbp = null;
      throw e;
    });
  }
  return dbp;
}

/**
 * Open the database, or explain why not. UI calls this so a storage failure surfaces as a
 * sentence rather than a permanent spinner.
 */
export async function openDatabase(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await db();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
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
