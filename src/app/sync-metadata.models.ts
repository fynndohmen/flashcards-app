// src/app/sync-metadata.models.ts

import { DifficultyLevel } from './models';

export const SYNC_META_SCHEMA_VERSION = 1;

export type SyncEntityType = 'deck' | 'card' | 'image';

export type PendingSyncOperation = 'create' | 'update' | 'delete';

export type SyncImageSide = 'front' | 'back';

/**
 * Minimal representation of a deck relevant to sync.
 *
 * Cards are deliberately NOT nested here because decks,
 * cards and images are independent revisioned server entities.
 */
export interface DeckSyncSnapshot {
  id: string;
  name: string;
  description?: string;
}

/**
 * Minimal representation of a card relevant to sync.
 *
 * Images are separate entities and therefore not included here.
 */
export interface CardSyncSnapshot {
  id: string;
  deckId: string;

  frontText: string;
  backText: string;

  difficulty: DifficultyLevel;

  lastReviewedAt: string | null;
}

/**
 * Image metadata relevant to sync.
 *
 * The data URL is deliberately not duplicated here.
 * Image bytes remain in the normal local flashcard state.
 */
export interface ImageSyncSnapshot {
  id: string;
  cardId: string;

  side: SyncImageSide;

  position: number;
}

/**
 * A conflict contains everything needed for a later
 * Cloud / This Device / Merge decision.
 *
 * base:
 *   Last clean snapshot known by this device.
 *
 * local:
 *   Local version at the moment the conflict was detected.
 *   null means the local device deleted the entity.
 *
 * server:
 *   Version returned by the server.
 *   null may represent a server-side deletion when applicable.
 */
export interface SyncConflictRecord<TSnapshot> {
  entityType: SyncEntityType;

  entityId: string;

  detectedAt: string;

  baseRevision: number;
  serverRevision: number;

  base: TSnapshot | null;

  local: TSnapshot | null;

  server: TSnapshot | null;

  localDeleted: boolean;
  serverDeleted: boolean;
}

/**
 * Sync state belonging to one server entity.
 *
 * revision:
 *   Latest server revision this device has accepted for
 *   this entity.
 *
 * baseRevision:
 *   Revision against which the pending local mutation
 *   must be pushed.
 *
 * Once an entity becomes dirty, baseRevision remains
 * frozen until the mutation is accepted or resolved.
 *
 * pendingOperation:
 *   null     = clean
 *   create   = local object has never existed on server
 *   update   = local edits wait to be pushed
 *   delete   = local tombstone waits to be pushed
 *
 * lastSyncedSnapshot:
 *   Clean ancestor used later for three-way conflict
 *   resolution.
 */
export interface EntitySyncRecord<TSnapshot> {
  revision: number;

  baseRevision: number;

  pendingOperation: PendingSyncOperation | null;

  lastSyncedSnapshot: TSnapshot | null;

  conflict: SyncConflictRecord<TSnapshot> | null;
}

export interface StoredSyncMeta {
  schemaVersion: number;

  /**
   * false until the device has deliberately completed
   * its first sync/bootstrap procedure.
   *
   * This prevents us from confusing "never initialized"
   * with "fully synchronized at revision 0".
   */
  initialized: boolean;

  /**
   * Global server cursor used by:
   *
   * GET /api/sync/pull?since=...
   */
  serverRevision: number;

  /**
   * Timestamp of the last completely successful sync cycle.
   */
  lastSuccessfulSyncAt: string | null;

  decks: Record<string, EntitySyncRecord<DeckSyncSnapshot>>;

  cards: Record<string, EntitySyncRecord<CardSyncSnapshot>>;

  images: Record<string, EntitySyncRecord<ImageSyncSnapshot>>;
}

export function createEmptySyncMeta(): StoredSyncMeta {
  return {
    schemaVersion: SYNC_META_SCHEMA_VERSION,

    initialized: false,

    serverRevision: 0,

    lastSuccessfulSyncAt: null,

    decks: {},
    cards: {},
    images: {},
  };
}

export function createEmptyEntitySyncRecord<TSnapshot>(): EntitySyncRecord<TSnapshot> {
  return {
    revision: 0,

    baseRevision: 0,

    pendingOperation: null,

    lastSyncedSnapshot: null,

    conflict: null,
  };
}

export function hasPendingSyncChange<TSnapshot>(record: EntitySyncRecord<TSnapshot>): boolean {
  return record.pendingOperation !== null || record.conflict !== null;
}
