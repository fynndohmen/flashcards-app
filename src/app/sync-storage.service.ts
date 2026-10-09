// src/app/sync-storage.service.ts

import { Injectable } from '@angular/core';

import {
  EntitySyncRecord,
  StoredSyncMeta,
  SyncConflictRecord,
  SyncEntityType,
  SYNC_META_SCHEMA_VERSION,
  createEmptySyncMeta,
} from './sync-metadata.models';

const DB_NAME = 'flashcards-app-db';

const DB_VERSION = 1;

const STORE_NAME = 'key_value_store';

const DEVICE_IDENTITY_KEY = 'flashcards-device-identity-v1';

const DEVICE_AUTH_KEY = 'flashcards-device-auth-v1';

const SYNC_META_KEY = 'flashcards-sync-meta-v1';

export interface StoredDeviceIdentity {
  deviceId: string;
  deviceName: string;
  createdAt: string;
}

export interface StoredDeviceAuth {
  deviceId: string;
  deviceName: string;
  token: string;
  registeredAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class SyncStorageService {
  /**
   * Serializes sync-meta modifications so two local
   * mutations cannot overwrite each other's metadata.
   */
  private syncMetaQueue: Promise<void> = Promise.resolve();

  constructor() {
    /*
     * The service is already instantiated by AppComponent
     * for device enrollment.
     *
     * Therefore we can safely ensure that the metadata key
     * exists without starting any network synchronization.
     */
    void this.ensureSyncMetaExists();
  }

  // -------------------------------------------------
  // Device identity
  // -------------------------------------------------

  async getOrCreateDeviceIdentity(defaultName: string): Promise<StoredDeviceIdentity> {
    const existing = await this.readValue<StoredDeviceIdentity>(DEVICE_IDENTITY_KEY);

    if (
      existing &&
      typeof existing.deviceId === 'string' &&
      existing.deviceId &&
      typeof existing.deviceName === 'string' &&
      existing.deviceName
    ) {
      return this.clone(existing);
    }

    const identity: StoredDeviceIdentity = {
      deviceId: this.generateDeviceId(),

      deviceName: defaultName.trim() || 'Flashcards device',

      createdAt: new Date().toISOString(),
    };

    await this.writeValue(DEVICE_IDENTITY_KEY, identity);

    return this.clone(identity);
  }

  async saveDeviceIdentity(identity: StoredDeviceIdentity): Promise<void> {
    const normalized: StoredDeviceIdentity = {
      deviceId: identity.deviceId,

      deviceName: identity.deviceName,

      createdAt: identity.createdAt,
    };

    await this.writeValue(DEVICE_IDENTITY_KEY, normalized);
  }

  // -------------------------------------------------
  // Device authentication
  // -------------------------------------------------

  async getDeviceAuth(): Promise<StoredDeviceAuth | null> {
    const auth = await this.readValue<StoredDeviceAuth>(DEVICE_AUTH_KEY);

    if (!auth) {
      return null;
    }

    if (
      typeof auth.deviceId !== 'string' ||
      !auth.deviceId ||
      typeof auth.deviceName !== 'string' ||
      !auth.deviceName ||
      typeof auth.token !== 'string' ||
      !auth.token
    ) {
      return null;
    }

    return this.clone(auth);
  }

  async saveDeviceAuth(auth: StoredDeviceAuth): Promise<void> {
    const normalized: StoredDeviceAuth = {
      deviceId: auth.deviceId,

      deviceName: auth.deviceName,

      token: auth.token,

      registeredAt: auth.registeredAt,
    };

    await this.writeValue(DEVICE_AUTH_KEY, normalized);
  }

  async clearDeviceAuth(): Promise<void> {
    await this.deleteValue(DEVICE_AUTH_KEY);
  }

  // -------------------------------------------------
  // Sync metadata
  // -------------------------------------------------

  /**
   * Returns a cloned and normalized copy.
   *
   * Old metadata containing only serverRevision is
   * automatically upgraded in memory.
   */
  async getSyncMeta(): Promise<StoredSyncMeta> {
    await this.syncMetaQueue;

    return this.readSyncMetaDirect();
  }

  /**
   * Replaces the complete metadata document.
   *
   * Writes are serialized with updateSyncMeta().
   */
  async saveSyncMeta(meta: StoredSyncMeta): Promise<void> {
    const task = this.syncMetaQueue.then(async () => {
      const normalized = this.normalizeSyncMeta(meta);

      await this.writeValue(SYNC_META_KEY, normalized);
    });

    this.syncMetaQueue = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  }

  /**
   * Safely performs a read-modify-write cycle.
   *
   * This will later be used by local deck/card/image
   * mutations as well as by the sync engine.
   */
  async updateSyncMeta(mutate: (meta: StoredSyncMeta) => void): Promise<StoredSyncMeta> {
    let updated: StoredSyncMeta | null = null;

    const task = this.syncMetaQueue.then(async () => {
      const current = await this.readSyncMetaDirect();

      mutate(current);

      const normalized = this.normalizeSyncMeta(current);

      await this.writeValue(SYNC_META_KEY, normalized);

      updated = this.clone(normalized);
    });

    this.syncMetaQueue = task.then(
      () => undefined,
      () => undefined,
    );

    await task;

    if (!updated) {
      throw new Error('Sync metadata update did not produce a result.');
    }

    return updated;
  }

  /**
   * Only for deliberate development/reset operations.
   *
   * Device identity and bearer auth are NOT touched.
   */
  async clearSyncMeta(): Promise<void> {
    const task = this.syncMetaQueue.then(async () => {
      await this.deleteValue(SYNC_META_KEY);
    });

    this.syncMetaQueue = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  }

  private async ensureSyncMetaExists(): Promise<void> {
    try {
      const task = this.syncMetaQueue.then(async () => {
        const raw = await this.readValue<unknown>(SYNC_META_KEY);

        const normalized = this.normalizeSyncMeta(raw);

        await this.writeValue(SYNC_META_KEY, normalized);
      });

      this.syncMetaQueue = task.then(
        () => undefined,
        () => undefined,
      );

      await task;
    } catch (err) {
      console.error('Failed to initialize sync metadata', err);
    }
  }

  private async readSyncMetaDirect(): Promise<StoredSyncMeta> {
    const raw = await this.readValue<unknown>(SYNC_META_KEY);

    return this.normalizeSyncMeta(raw);
  }

  // -------------------------------------------------
  // Sync metadata normalization
  // -------------------------------------------------

  private normalizeSyncMeta(raw: unknown): StoredSyncMeta {
    const empty = createEmptySyncMeta();

    if (!raw || typeof raw !== 'object') {
      return empty;
    }

    const source = raw as Record<string, unknown>;

    return {
      schemaVersion: SYNC_META_SCHEMA_VERSION,

      initialized: source['initialized'] === true,

      serverRevision: this.normalizeRevision(source['serverRevision']),

      lastSuccessfulSyncAt:
        typeof source['lastSuccessfulSyncAt'] === 'string'
          ? (source['lastSuccessfulSyncAt'] as string)
          : null,

      decks: this.normalizeEntityMap(source['decks'], 'deck'),

      cards: this.normalizeEntityMap(source['cards'], 'card'),

      images: this.normalizeEntityMap(source['images'], 'image'),
    };
  }

  private normalizeEntityMap<TSnapshot>(
    raw: unknown,
    entityType: SyncEntityType,
  ): Record<string, EntitySyncRecord<TSnapshot>> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }

    const source = raw as Record<string, unknown>;

    const result: Record<string, EntitySyncRecord<TSnapshot>> = {};

    for (const [entityId, rawRecord] of Object.entries(source)) {
      if (!entityId || !rawRecord || typeof rawRecord !== 'object') {
        continue;
      }

      result[entityId] = this.normalizeEntityRecord<TSnapshot>(rawRecord, entityType, entityId);
    }

    return result;
  }

  private normalizeEntityRecord<TSnapshot>(
    raw: unknown,
    entityType: SyncEntityType,
    entityId: string,
  ): EntitySyncRecord<TSnapshot> {
    const source = raw as Record<string, unknown>;

    const revision = this.normalizeRevision(source['revision']);

    let baseRevision = this.normalizeRevision(source['baseRevision']);

    const pendingOperation =
      source['pendingOperation'] === 'create' ||
      source['pendingOperation'] === 'update' ||
      source['pendingOperation'] === 'delete'
        ? source['pendingOperation']
        : null;

    /*
     * A server-backed dirty entity must never accidentally
     * advance its baseRevision while local edits are pending.
     *
     * For clean entries we keep baseRevision aligned with
     * the current known server revision.
     */
    if (pendingOperation === null) {
      baseRevision = revision;
    }

    if (pendingOperation === 'create') {
      baseRevision = 0;
    }

    const lastSyncedSnapshot = this.normalizeSnapshot<TSnapshot>(source['lastSyncedSnapshot']);

    const conflict = this.normalizeConflict<TSnapshot>(source['conflict'], entityType, entityId);

    return {
      revision,
      baseRevision,
      pendingOperation,
      lastSyncedSnapshot,
      conflict,
    };
  }

  private normalizeConflict<TSnapshot>(
    raw: unknown,
    entityType: SyncEntityType,
    entityId: string,
  ): SyncConflictRecord<TSnapshot> | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const source = raw as Record<string, unknown>;

    const detectedAt =
      typeof source['detectedAt'] === 'string'
        ? (source['detectedAt'] as string)
        : new Date().toISOString();

    return {
      entityType,

      entityId,

      detectedAt,

      baseRevision: this.normalizeRevision(source['baseRevision']),

      serverRevision: this.normalizeRevision(source['serverRevision']),

      base: this.normalizeSnapshot<TSnapshot>(source['base']),

      local: this.normalizeSnapshot<TSnapshot>(source['local']),

      server: this.normalizeSnapshot<TSnapshot>(source['server']),

      localDeleted: source['localDeleted'] === true,

      serverDeleted: source['serverDeleted'] === true,
    };
  }

  private normalizeSnapshot<TSnapshot>(raw: unknown): TSnapshot | null {
    if (raw === null || raw === undefined) {
      return null;
    }

    if (typeof raw !== 'object') {
      return null;
    }

    return this.clone(raw as TSnapshot);
  }

  private normalizeRevision(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return 0;
    }

    return value;
  }

  // -------------------------------------------------
  // IndexedDB helpers
  // -------------------------------------------------

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is not supported in this browser.'));

        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(request.error ?? new Error('Could not open IndexedDB.'));
      };

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  private async readValue<T>(key: string): Promise<T | null> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');

      const store = tx.objectStore(STORE_NAME);

      const request = store.get(key);

      request.onerror = () => {
        db.close();

        reject(request.error ?? new Error(`Could not read IndexedDB key "${key}".`));
      };

      request.onsuccess = () => {
        const result = request.result as T | undefined;

        db.close();

        resolve(result ?? null);
      };
    });
  }

  private async writeValue<T>(key: string, value: T): Promise<void> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');

      const store = tx.objectStore(STORE_NAME);

      store.put(value, key);

      tx.oncomplete = () => {
        db.close();
        resolve();
      };

      tx.onerror = () => {
        db.close();

        reject(tx.error ?? new Error(`Could not write IndexedDB key "${key}".`));
      };

      tx.onabort = () => {
        db.close();

        reject(tx.error ?? new Error(`IndexedDB transaction for "${key}" was aborted.`));
      };
    });
  }

  private async deleteValue(key: string): Promise<void> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');

      const store = tx.objectStore(STORE_NAME);

      store.delete(key);

      tx.oncomplete = () => {
        db.close();
        resolve();
      };

      tx.onerror = () => {
        db.close();

        reject(tx.error ?? new Error(`Could not delete IndexedDB key "${key}".`));
      };

      tx.onabort = () => {
        db.close();

        reject(tx.error ?? new Error(`IndexedDB delete for "${key}" was aborted.`));
      };
    });
  }

  // -------------------------------------------------
  // Helpers
  // -------------------------------------------------

  private generateDeviceId(): string {
    if (
      typeof globalThis.crypto !== 'undefined' &&
      typeof globalThis.crypto.randomUUID === 'function'
    ) {
      return globalThis.crypto.randomUUID();
    }

    if (
      typeof globalThis.crypto !== 'undefined' &&
      typeof globalThis.crypto.getRandomValues === 'function'
    ) {
      const bytes = new Uint8Array(16);

      globalThis.crypto.getRandomValues(bytes);

      return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
    }

    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2)
    );
  }

  private clone<T>(value: T): T {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value)) as T;
    }
  }
}
