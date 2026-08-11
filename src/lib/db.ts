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
}

let dbp: Promise<IDBPDatabase<NightscriptDB>> | null = null;

function db() {
  if (!dbp) {
    dbp = openDB<NightscriptDB>('nightscript', 1, {
      upgrade(d) {
        const tracks = d.createObjectStore('tracks', { keyPath: 'id' });
        tracks.createIndex('createdAt', 'createdAt');
        d.createObjectStore('audio', { keyPath: 'id' });
        const drafts = d.createObjectStore('drafts', { keyPath: 'id' });
        drafts.createIndex('updatedAt', 'updatedAt');
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

/** Rough storage footprint, so the library can show it without guessing. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

export const newId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
