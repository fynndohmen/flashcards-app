import { Injectable } from '@angular/core';

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

export interface StoredSyncMeta {
  serverRevision: number;
}

@Injectable({ providedIn: 'root' })
export class SyncStorageService {
  async getOrCreateDeviceIdentity(defaultName: string): Promise<StoredDeviceIdentity> {
    const stored = await this.readValue<StoredDeviceIdentity>(DEVICE_IDENTITY_KEY);

    if (
      stored &&
      typeof stored.deviceId === 'string' &&
      stored.deviceId &&
      typeof stored.deviceName === 'string' &&
      stored.deviceName
    ) {
      return stored;
    }

    const identity: StoredDeviceIdentity = {
      deviceId: this.generateDeviceId(),
      deviceName: defaultName.trim() || 'Flashcards device',
      createdAt: new Date().toISOString(),
    };

    await this.saveDeviceIdentity(identity);

    return identity;
  }

  async saveDeviceIdentity(identity: StoredDeviceIdentity): Promise<void> {
    await this.writeValue(DEVICE_IDENTITY_KEY, identity);
  }

  async getDeviceAuth(): Promise<StoredDeviceAuth | null> {
    return this.readValue<StoredDeviceAuth>(DEVICE_AUTH_KEY);
  }

  async saveDeviceAuth(auth: StoredDeviceAuth): Promise<void> {
    await this.writeValue(DEVICE_AUTH_KEY, auth);
  }

  async clearDeviceAuth(): Promise<void> {
    await this.deleteValue(DEVICE_AUTH_KEY);
  }

  async getSyncMeta(): Promise<StoredSyncMeta> {
    const stored = await this.readValue<StoredSyncMeta>(SYNC_META_KEY);

    if (!stored || !Number.isFinite(stored.serverRevision)) {
      return {
        serverRevision: 0,
      };
    }

    return {
      serverRevision: Math.max(0, Math.trunc(stored.serverRevision)),
    };
  }

  async saveSyncMeta(meta: StoredSyncMeta): Promise<void> {
    await this.writeValue(SYNC_META_KEY, {
      serverRevision: Math.max(0, Math.trunc(meta.serverRevision)),
    } satisfies StoredSyncMeta);
  }

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
      const transaction = db.transaction(STORE_NAME, 'readonly');

      const store = transaction.objectStore(STORE_NAME);

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
      const transaction = db.transaction(STORE_NAME, 'readwrite');

      const store = transaction.objectStore(STORE_NAME);

      store.put(value, key);

      transaction.oncomplete = () => {
        db.close();
        resolve();
      };

      transaction.onerror = () => {
        db.close();

        reject(transaction.error ?? new Error(`Could not write IndexedDB key "${key}".`));
      };

      transaction.onabort = () => {
        db.close();

        reject(transaction.error ?? new Error(`IndexedDB transaction for "${key}" was aborted.`));
      };
    });
  }

  private async deleteValue(key: string): Promise<void> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');

      const store = transaction.objectStore(STORE_NAME);

      store.delete(key);

      transaction.oncomplete = () => {
        db.close();
        resolve();
      };

      transaction.onerror = () => {
        db.close();

        reject(transaction.error ?? new Error(`Could not delete IndexedDB key "${key}".`));
      };

      transaction.onabort = () => {
        db.close();

        reject(transaction.error ?? new Error(`IndexedDB transaction for "${key}" was aborted.`));
      };
    });
  }
}
