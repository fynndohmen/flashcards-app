// src/app/flashcards-state.service.ts

import { Injectable } from '@angular/core';

import {
  ALL_DIFFICULTY_LEVELS,
  CardImageContent,
  CardSideContent,
  Deck,
  DifficultyLevel,
  Flashcard,
  FlashcardsState,
} from './models';

import {
  CardSyncSnapshot,
  DeckSyncSnapshot,
  EntitySyncRecord,
  ImageSyncSnapshot,
  StoredSyncMeta,
} from './sync-metadata.models';

import { SyncStorageService } from './sync-storage.service';

const LEGACY_STORAGE_KEY = 'flashcards-app-state-v1';

const DB_NAME = 'flashcards-app-db';
const DB_VERSION = 1;
const STORE_NAME = 'key_value_store';
const STATE_KEY = 'flashcards-state-v2';

type CardSideName = 'front' | 'back';

@Injectable({
  providedIn: 'root',
})
export class FlashcardsStateService {
  private state: FlashcardsState = {
    decks: [],
  };

  private readyPromise: Promise<void>;

  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private syncStorage: SyncStorageService) {
    this.readyPromise = this.load();
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  // -------------------------------------------------
  // Loading / persistence / legacy migration
  // -------------------------------------------------

  private async load(): Promise<void> {
    try {
      const indexedDbState = await this.readStateFromIndexedDb();

      if (indexedDbState) {
        const needsMigration = this.stateNeedsMigration(indexedDbState);

        this.state = this.normalizeState(indexedDbState);

        if (needsMigration) {
          await this.writeStateToIndexedDb(this.state);
        }

        return;
      }

      const legacyState = this.loadFromLocalStorage();

      if (legacyState) {
        this.state = this.normalizeState(legacyState);

        await this.persist();

        return;
      }

      this.state = {
        decks: [],
      };
    } catch (err) {
      console.error('Failed to load flashcards state', err);

      this.state = {
        decks: [],
      };
    }
  }

  private loadFromLocalStorage(): FlashcardsState | null {
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);

      if (!raw) {
        return null;
      }

      return JSON.parse(raw) as FlashcardsState;
    } catch (err) {
      console.error('Failed to load legacy localStorage state', err);

      return null;
    }
  }

  private queuePersist(): Promise<void> {
    this.persistQueue = this.persistQueue
      .then(() => this.persist())
      .catch((err) => {
        console.error('Failed to persist flashcards state', err);
      });

    return this.persistQueue;
  }

  private async persist(): Promise<void> {
    const normalized = this.normalizeState(this.state);

    this.state = normalized;

    await this.writeStateToIndexedDb(normalized);
  }

  /**
   * Local user mutations use this instead of queuePersist().
   *
   * Visible state and sync metadata are committed atomically.
   */
  private async commitLocalMutation(mutateMeta: (meta: StoredSyncMeta) => void): Promise<void> {
    const normalized = this.normalizeState(this.state);

    this.state = normalized;

    await this.syncStorage.commitStateAndSyncMeta(normalized, mutateMeta);
  }

  // -------------------------------------------------
  // State normalization
  // -------------------------------------------------

  private stateNeedsMigration(raw: any): boolean {
    if (!Array.isArray(raw?.decks)) {
      return true;
    }

    for (const deck of raw.decks) {
      if (!Array.isArray(deck?.cards)) {
        return true;
      }

      for (const card of deck.cards) {
        if (typeof card?.updatedAt !== 'string' || !card.updatedAt) {
          return true;
        }

        if (!Object.prototype.hasOwnProperty.call(card, 'lastReviewedAt')) {
          return true;
        }

        if (
          card.lastReviewedAt !== null &&
          (typeof card.lastReviewedAt !== 'string' || !card.lastReviewedAt)
        ) {
          return true;
        }

        if (this.cardSideNeedsMigration(card?.front) || this.cardSideNeedsMigration(card?.back)) {
          return true;
        }
      }
    }

    return false;
  }

  private cardSideNeedsMigration(side: any): boolean {
    if (typeof side?.text !== 'string') {
      return true;
    }

    if (!Array.isArray(side?.images)) {
      return true;
    }

    return side.images.some(
      (image: any) =>
        typeof image?.id !== 'string' ||
        !image.id ||
        typeof image?.dataUrl !== 'string' ||
        !image.dataUrl,
    );
  }

  private normalizeCardSide(side: any, cardId: string, sideName: CardSideName): CardSideContent {
    const text = typeof side?.text === 'string' ? side.text : '';

    const images: CardImageContent[] = [];

    const usedIds = new Set<string>();

    if (Array.isArray(side?.images)) {
      side.images.forEach((rawImage: any, position: number) => {
        const dataUrl = typeof rawImage?.dataUrl === 'string' ? rawImage.dataUrl : '';

        if (!dataUrl) {
          return;
        }

        let id = typeof rawImage?.id === 'string' ? rawImage.id.trim() : '';

        if (!id || usedIds.has(id)) {
          id = this.deterministicLegacyImageId(cardId, sideName, position, dataUrl);
        }

        usedIds.add(id);

        images.push({
          id,
          dataUrl,
        });
      });

      return {
        text,
        images,
      };
    }

    let legacyDataUrls: string[] = [];

    if (Array.isArray(side?.imageDataUrls)) {
      legacyDataUrls = side.imageDataUrls.filter(
        (url: unknown): url is string => typeof url === 'string' && !!url,
      );
    } else if (typeof side?.imageDataUrl === 'string' && side.imageDataUrl) {
      legacyDataUrls = [side.imageDataUrl];
    }

    legacyDataUrls.forEach((dataUrl, position) => {
      images.push({
        id: this.deterministicLegacyImageId(cardId, sideName, position, dataUrl),

        dataUrl,
      });
    });

    return {
      text,
      images,
    };
  }

  private normalizeCard(raw: any): Flashcard {
    const cardId = typeof raw?.id === 'string' && raw.id ? raw.id : this.generateId();

    const createdAt =
      typeof raw?.createdAt === 'string' && raw.createdAt
        ? raw.createdAt
        : new Date().toISOString();

    const updatedAt =
      typeof raw?.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : createdAt;

    let lastReviewedAt: string | null;

    if (raw?.lastReviewedAt === null) {
      lastReviewedAt = null;
    } else if (typeof raw?.lastReviewedAt === 'string' && raw.lastReviewedAt) {
      lastReviewedAt = raw.lastReviewedAt;
    } else {
      lastReviewedAt = updatedAt === createdAt ? null : updatedAt;
    }

    const difficultyRaw = raw?.difficulty;

    const difficulty: DifficultyLevel = ALL_DIFFICULTY_LEVELS.includes(difficultyRaw)
      ? (difficultyRaw as DifficultyLevel)
      : 5;

    return {
      id: cardId,

      front: this.normalizeCardSide(raw?.front, cardId, 'front'),

      back: this.normalizeCardSide(raw?.back, cardId, 'back'),

      difficulty,
      createdAt,
      updatedAt,
      lastReviewedAt,
    };
  }

  private normalizeDeck(raw: any): Deck {
    const cardsArray: any[] = Array.isArray(raw?.cards) ? raw.cards : [];

    return {
      id: typeof raw?.id === 'string' && raw.id ? raw.id : this.generateId(),

      name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name : 'Untitled deck',

      description:
        typeof raw?.description === 'string' && raw.description.trim()
          ? raw.description
          : undefined,

      cards: cardsArray.map((card) => this.normalizeCard(card)),
    };
  }

  private normalizeState(raw: any): FlashcardsState {
    const decksArray: any[] = Array.isArray(raw?.decks) ? raw.decks : [];

    return {
      decks: decksArray.map((deck) => this.normalizeDeck(deck)),
    };
  }

  // -------------------------------------------------
  // IndexedDB legacy state helpers
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

  private async readStateFromIndexedDb(): Promise<FlashcardsState | null> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');

      const store = transaction.objectStore(STORE_NAME);

      const request = store.get(STATE_KEY);

      request.onerror = () => {
        db.close();

        reject(request.error ?? new Error('Could not read state from IndexedDB.'));
      };

      request.onsuccess = () => {
        const result = request.result as FlashcardsState | undefined;

        db.close();

        resolve(result ?? null);
      };
    });
  }

  private async writeStateToIndexedDb(state: FlashcardsState): Promise<void> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');

      const store = transaction.objectStore(STORE_NAME);

      store.put(state, STATE_KEY);

      transaction.oncomplete = () => {
        db.close();
        resolve();
      };

      transaction.onerror = () => {
        db.close();

        reject(transaction.error ?? new Error('Could not write state to IndexedDB.'));
      };

      transaction.onabort = () => {
        db.close();

        reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
      };
    });
  }

  // -------------------------------------------------
  // Public read API
  // -------------------------------------------------

  getState(): FlashcardsState {
    return this.clone(this.state);
  }

  getDecks(): Deck[] {
    return this.getState().decks;
  }

  getDeckById(deckId: string): Deck | undefined {
    return this.getState().decks.find((deck) => deck.id === deckId);
  }

  // -------------------------------------------------
  // Decks
  // -------------------------------------------------

  async createDeck(name: string, description?: string): Promise<Deck> {
    const newDeck: Deck = {
      id: this.generateId(),

      name: name.trim(),

      description: description?.trim() || undefined,

      cards: [],
    };

    this.state.decks.push(newDeck);

    try {
      await this.commitLocalMutation((meta) => {
        this.markLocalCreate(meta.decks, newDeck.id, this.deckSnapshot(newDeck));
      });
    } catch (err) {
      this.state.decks = this.state.decks.filter((deck) => deck.id !== newDeck.id);

      throw err;
    }

    return this.clone(newDeck);
  }

  async updateDeck(
    deckId: string,
    updates: Partial<Pick<Deck, 'name' | 'description'>>,
  ): Promise<Deck | undefined> {
    const deck = this.state.decks.find((candidate) => candidate.id === deckId);

    if (!deck) {
      return undefined;
    }

    const before = this.clone(deck);

    if (typeof updates.name === 'string') {
      deck.name = updates.name.trim();
    }

    if (typeof updates.description === 'string') {
      deck.description = updates.description.trim() || undefined;
    }

    try {
      await this.commitLocalMutation((meta) => {
        this.markLocalUpdate(meta.decks, deck.id, this.deckSnapshot(deck));
      });
    } catch (err) {
      Object.assign(deck, before);

      throw err;
    }

    return this.clone(deck);
  }

  async deleteDeck(deckId: string): Promise<void> {
    const index = this.state.decks.findIndex((deck) => deck.id === deckId);

    if (index < 0) {
      return;
    }

    const removedDeck = this.clone(this.state.decks[index]);

    this.state.decks.splice(index, 1);

    try {
      await this.commitLocalMutation((meta) => {
        const deckRecord = meta.decks[removedDeck.id];

        if (deckRecord?.pendingOperation === 'create') {
          delete meta.decks[removedDeck.id];
        } else if (!deckRecord && !meta.initialized) {
          /*
           * Existing pre-sync local deck deleted before
           * bootstrap: the server has never been told
           * about it, so no tombstone is needed.
           */
        } else {
          this.markLocalDelete(meta.decks, removedDeck.id, this.deckSnapshot(removedDeck));
        }

        for (const card of removedDeck.cards) {
          delete meta.cards[card.id];

          for (const image of card.front.images) {
            delete meta.images[image.id];
          }

          for (const image of card.back.images) {
            delete meta.images[image.id];
          }
        }
      });
    } catch (err) {
      this.state.decks.splice(index, 0, removedDeck);

      throw err;
    }
  }

  // -------------------------------------------------
  // Cards
  // -------------------------------------------------

  async createCard(
    deckId: string,
    front: CardSideContent,
    back: CardSideContent,
    difficulty: DifficultyLevel,
  ): Promise<Flashcard | undefined> {
    const deck = this.state.decks.find((candidate) => candidate.id === deckId);

    if (!deck) {
      return undefined;
    }

    const now = new Date().toISOString();

    const cardId = this.generateId();

    const newCard: Flashcard = {
      id: cardId,

      front: this.normalizeCardSide(front, cardId, 'front'),

      back: this.normalizeCardSide(back, cardId, 'back'),

      difficulty,

      createdAt: now,
      updatedAt: now,

      lastReviewedAt: null,
    };

    deck.cards.push(newCard);

    try {
      await this.commitLocalMutation((meta) => {
        this.markLocalCreate(meta.cards, newCard.id, this.cardSnapshot(deck.id, newCard));

        this.markNewCardImages(meta, newCard);
      });
    } catch (err) {
      deck.cards = deck.cards.filter((card) => card.id !== newCard.id);

      throw err;
    }

    return this.clone(newCard);
  }

  async updateCard(
    deckId: string,
    cardId: string,
    updates: Partial<Pick<Flashcard, 'front' | 'back'>>,
  ): Promise<Flashcard | undefined> {
    const deck = this.state.decks.find((candidate) => candidate.id === deckId);

    if (!deck) {
      return undefined;
    }

    const card = deck.cards.find((candidate) => candidate.id === cardId);

    if (!card) {
      return undefined;
    }

    const before = this.clone(card);

    if (updates.front) {
      card.front = this.normalizeCardSide(updates.front, card.id, 'front');
    }

    if (updates.back) {
      card.back = this.normalizeCardSide(updates.back, card.id, 'back');
    }

    card.updatedAt = new Date().toISOString();

    try {
      await this.commitLocalMutation((meta) => {
        this.markLocalUpdate(meta.cards, card.id, this.cardSnapshot(deck.id, card));

        this.markImageDifferences(meta, before, card);
      });
    } catch (err) {
      Object.assign(card, before);

      throw err;
    }

    return this.clone(card);
  }

  async deleteCard(deckId: string, cardId: string): Promise<void> {
    const deck = this.state.decks.find((candidate) => candidate.id === deckId);

    if (!deck) {
      return;
    }

    const index = deck.cards.findIndex((card) => card.id === cardId);

    if (index < 0) {
      return;
    }

    const removedCard = this.clone(deck.cards[index]);

    deck.cards.splice(index, 1);

    try {
      await this.commitLocalMutation((meta) => {
        const record = meta.cards[removedCard.id];

        if (record?.pendingOperation === 'create') {
          delete meta.cards[removedCard.id];
        } else if (!record && !meta.initialized) {
          // Pre-bootstrap local-only card.
        } else {
          this.markLocalDelete(meta.cards, removedCard.id, this.cardSnapshot(deck.id, removedCard));
        }

        /*
         * Server-side card deletion tombstones all
         * child images, so they must not be pushed
         * independently afterwards.
         */
        for (const image of removedCard.front.images) {
          delete meta.images[image.id];
        }

        for (const image of removedCard.back.images) {
          delete meta.images[image.id];
        }
      });
    } catch (err) {
      deck.cards.splice(index, 0, removedCard);

      throw err;
    }
  }

  async setCardDifficulty(
    deckId: string,
    cardId: string,
    difficulty: DifficultyLevel,
  ): Promise<void> {
    const deck = this.state.decks.find((candidate) => candidate.id === deckId);

    if (!deck) {
      return;
    }

    const card = deck.cards.find((candidate) => candidate.id === cardId);

    if (!card) {
      return;
    }

    const before = this.clone(card);

    const now = new Date().toISOString();

    card.difficulty = difficulty;

    card.updatedAt = now;

    card.lastReviewedAt = now;

    try {
      await this.commitLocalMutation((meta) => {
        this.markLocalUpdate(meta.cards, card.id, this.cardSnapshot(deck.id, card));
      });
    } catch (err) {
      Object.assign(card, before);

      throw err;
    }
  }

  // -------------------------------------------------
  // Export / import
  // -------------------------------------------------

  exportState(): FlashcardsState {
    return this.getState();
  }

  async importState(newState: FlashcardsState): Promise<void> {
    this.state = this.normalizeState(newState);

    /*
     * Import remains a local-state replacement for now.
     *
     * We deliberately do not mark every imported entity
     * dirty until the initial/bootstrap algorithm is
     * implemented in the next sync-engine stage.
     */
    await this.queuePersist();
  }

  // -------------------------------------------------
  // Sync snapshot / dirty helpers
  // -------------------------------------------------

  private deckSnapshot(deck: Deck): DeckSyncSnapshot {
    return {
      id: deck.id,
      name: deck.name,
      description: deck.description,
    };
  }

  private cardSnapshot(deckId: string, card: Flashcard): CardSyncSnapshot {
    return {
      id: card.id,
      deckId,

      frontText: card.front.text,

      backText: card.back.text,

      difficulty: card.difficulty,

      lastReviewedAt: card.lastReviewedAt,
    };
  }

  private imageSnapshot(
    image: CardImageContent,
    cardId: string,
    side: CardSideName,
    position: number,
  ): ImageSyncSnapshot {
    return {
      id: image.id,
      cardId,
      side,
      position,
    };
  }

  private markNewCardImages(meta: StoredSyncMeta, card: Flashcard): void {
    card.front.images.forEach((image, position) => {
      this.markLocalCreate(
        meta.images,
        image.id,
        this.imageSnapshot(image, card.id, 'front', position),
      );
    });

    card.back.images.forEach((image, position) => {
      this.markLocalCreate(
        meta.images,
        image.id,
        this.imageSnapshot(image, card.id, 'back', position),
      );
    });
  }

  private markImageDifferences(meta: StoredSyncMeta, before: Flashcard, after: Flashcard): void {
    this.markImageSideDifferences(
      meta,
      before.id,
      'front',
      before.front.images,
      after.front.images,
    );

    this.markImageSideDifferences(meta, before.id, 'back', before.back.images, after.back.images);
  }

  private markImageSideDifferences(
    meta: StoredSyncMeta,
    cardId: string,
    side: CardSideName,
    beforeImages: CardImageContent[],
    afterImages: CardImageContent[],
  ): void {
    const beforeById = new Map(
      beforeImages.map((image, position) => [
        image.id,
        {
          image,
          position,
        },
      ]),
    );

    const afterById = new Map(
      afterImages.map((image, position) => [
        image.id,
        {
          image,
          position,
        },
      ]),
    );

    for (const [imageId, afterEntry] of afterById) {
      if (beforeById.has(imageId)) {
        continue;
      }

      this.markLocalCreate(
        meta.images,
        imageId,
        this.imageSnapshot(afterEntry.image, cardId, side, afterEntry.position),
      );
    }

    for (const [imageId, beforeEntry] of beforeById) {
      if (afterById.has(imageId)) {
        continue;
      }

      const record = meta.images[imageId];

      if (record?.pendingOperation === 'create') {
        delete meta.images[imageId];

        continue;
      }

      if (!record && !meta.initialized) {
        /*
         * Legacy/pre-bootstrap local image removed before
         * the server ever knew about it.
         */
        continue;
      }

      this.markLocalDelete(
        meta.images,
        imageId,
        this.imageSnapshot(beforeEntry.image, cardId, side, beforeEntry.position),
      );
    }
  }

  private markLocalCreate<TSnapshot>(
    map: Record<string, EntitySyncRecord<TSnapshot>>,
    entityId: string,
    localSnapshot: TSnapshot,
  ): void {
    const existing = map[entityId];

    if (!existing) {
      map[entityId] = {
        revision: 0,
        baseRevision: 0,
        pendingOperation: 'create',
        lastSyncedSnapshot: null,
        conflict: null,
      };

      return;
    }

    /*
     * If this ID already has server history, creating the
     * same ID is unsafe. Keep the existing base rather than
     * silently erasing its ancestry; the eventual push will
     * surface a conflict.
     */
    if (existing.revision > 0 || existing.lastSyncedSnapshot) {
      if (existing.pendingOperation === null) {
        existing.baseRevision = existing.revision;
      }

      existing.pendingOperation = 'update';

      this.updateConflictLocal(existing, localSnapshot, false);

      return;
    }

    existing.revision = 0;
    existing.baseRevision = 0;

    existing.pendingOperation = 'create';

    existing.lastSyncedSnapshot = null;

    existing.conflict = null;
  }

  private markLocalUpdate<TSnapshot>(
    map: Record<string, EntitySyncRecord<TSnapshot>>,
    entityId: string,
    localSnapshot: TSnapshot,
  ): void {
    const existing = map[entityId];

    if (!existing) {
      /*
       * No known server ancestry means this is effectively
       * a local create. This is exactly what we need for
       * old pre-sync data during bootstrap.
       */
      map[entityId] = {
        revision: 0,
        baseRevision: 0,
        pendingOperation: 'create',
        lastSyncedSnapshot: null,
        conflict: null,
      };

      return;
    }

    if (existing.pendingOperation === 'create') {
      existing.baseRevision = 0;

      this.updateConflictLocal(existing, localSnapshot, false);

      return;
    }

    if (existing.pendingOperation === null) {
      existing.baseRevision = existing.revision;

      existing.pendingOperation = 'update';
    }

    /*
     * update -> update:
     * keep the original frozen baseRevision.
     *
     * delete -> edit should normally be impossible because
     * the visible entity is gone, so we intentionally do
     * not transform delete back into update here.
     */
    this.updateConflictLocal(existing, localSnapshot, false);
  }

  private markLocalDelete<TSnapshot>(
    map: Record<string, EntitySyncRecord<TSnapshot>>,
    entityId: string,
    localSnapshot: TSnapshot,
  ): void {
    const existing = map[entityId];

    if (existing?.pendingOperation === 'create') {
      delete map[entityId];

      return;
    }

    if (!existing) {
      map[entityId] = {
        revision: 0,
        baseRevision: 0,
        pendingOperation: 'delete',
        lastSyncedSnapshot: null,
        conflict: null,
      };

      return;
    }

    if (existing.pendingOperation === null) {
      existing.baseRevision = existing.revision;
    }

    existing.pendingOperation = 'delete';

    this.updateConflictLocal(existing, localSnapshot, true);
  }

  private updateConflictLocal<TSnapshot>(
    record: EntitySyncRecord<TSnapshot>,
    localSnapshot: TSnapshot,
    deleted: boolean,
  ): void {
    if (!record.conflict) {
      return;
    }

    record.conflict.local = deleted ? null : this.clone(localSnapshot);

    record.conflict.localDeleted = deleted;
  }

  // -------------------------------------------------
  // IDs / helpers
  // -------------------------------------------------

  private generateId(): string {
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

  private deterministicLegacyImageId(
    cardId: string,
    sideName: CardSideName,
    position: number,
    dataUrl: string,
  ): string {
    const input = `${cardId}\u0000` + `${sideName}\u0000` + `${position}\u0000` + dataUrl;

    let h1 = 1779033703;
    let h2 = 3144134277;
    let h3 = 1013904242;
    let h4 = 2773480762;

    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i);

      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);

      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);

      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);

      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
    }

    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);

    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);

    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);

    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);

    h1 ^= h2 ^ h3 ^ h4;
    h2 ^= h1;
    h3 ^= h1;
    h4 ^= h1;

    const hex = [h1, h2, h3, h4]
      .map((value) => (value >>> 0).toString(16).padStart(8, '0'))
      .join('');

    return `legacy-${hex}`;
  }

  private clone<T>(value: T): T {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value)) as T;
    }
  }
}
