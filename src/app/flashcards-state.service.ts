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

const LEGACY_STORAGE_KEY = 'flashcards-app-state-v1';

const DB_NAME = 'flashcards-app-db';
const DB_VERSION = 1;
const STORE_NAME = 'key_value_store';
const STATE_KEY = 'flashcards-state-v2';

type CardSideName = 'front' | 'back';

@Injectable({ providedIn: 'root' })
export class FlashcardsStateService {
  private state: FlashcardsState = {
    decks: [],
  };

  private readyPromise: Promise<void>;

  private persistQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.readyPromise = this.load();
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  // -------------------------------------------------
  // Loading / persistence / migration
  // -------------------------------------------------

  private async load(): Promise<void> {
    try {
      const indexedDbState = await this.readStateFromIndexedDb();

      if (indexedDbState) {
        const needsMigration = this.stateNeedsMigration(indexedDbState);

        this.state = this.normalizeState(indexedDbState);

        /*
         * Persist an old-format state exactly once after
         * normalization so stable image IDs and
         * lastReviewedAt survive future reloads.
         */
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
    try {
      const normalized = this.normalizeState(this.state);

      this.state = normalized;

      await this.writeStateToIndexedDb(normalized);
    } catch (err) {
      console.error('Failed to persist flashcards state to IndexedDB', err);

      throw err;
    }
  }

  /**
   * Returns true when a stored state still uses any of
   * the pre-sync formats.
   */
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

  /**
   * Normalizes one card side.
   *
   * Supported input formats:
   *
   * New:
   *   images: [{ id, dataUrl }]
   *
   * Previous:
   *   imageDataUrls: ["data:...", ...]
   *
   * Very old:
   *   imageDataUrl: "data:..."
   */
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
      const id = this.deterministicLegacyImageId(cardId, sideName, position, dataUrl);

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

  /**
   * Normalizes one card.
   *
   * Old cards did not have lastReviewedAt.
   * To preserve the old UI's visible behavior:
   *
   * updatedAt === createdAt
   *   => never reviewed
   *
   * updatedAt !== createdAt
   *   => considered reviewed
   *
   * We cannot reconstruct the exact historical review
   * time, so updatedAt is used as the best available
   * timestamp for migrated reviewed cards.
   */
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
  // IndexedDB
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

  createDeck(name: string, description?: string): Deck {
    const newDeck: Deck = {
      id: this.generateId(),

      name: name.trim(),

      description: description?.trim() || undefined,

      cards: [],
    };

    this.state.decks.push(newDeck);

    void this.queuePersist();

    return this.clone(newDeck);
  }

  updateDeck(
    deckId: string,
    updates: Partial<Pick<Deck, 'name' | 'description'>>,
  ): Deck | undefined {
    const deck = this.state.decks.find((candidate) => candidate.id === deckId);

    if (!deck) {
      return undefined;
    }

    if (typeof updates.name === 'string') {
      deck.name = updates.name.trim();
    }

    if (typeof updates.description === 'string') {
      deck.description = updates.description.trim() || undefined;
    }

    void this.queuePersist();

    return this.clone(deck);
  }

  deleteDeck(deckId: string): void {
    this.state.decks = this.state.decks.filter((deck) => deck.id !== deckId);

    void this.queuePersist();
  }

  // -------------------------------------------------
  // Cards
  // -------------------------------------------------

  createCard(
    deckId: string,
    front: CardSideContent,
    back: CardSideContent,
    difficulty: DifficultyLevel,
  ): Flashcard | undefined {
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

    void this.queuePersist();

    return this.clone(newCard);
  }

  updateCard(
    deckId: string,
    cardId: string,
    updates: Partial<Pick<Flashcard, 'front' | 'back'>>,
  ): Flashcard | undefined {
    const deck = this.state.decks.find((candidate) => candidate.id === deckId);

    if (!deck) {
      return undefined;
    }

    const card = deck.cards.find((candidate) => candidate.id === cardId);

    if (!card) {
      return undefined;
    }

    if (updates.front) {
      card.front = this.normalizeCardSide(updates.front, card.id, 'front');
    }

    if (updates.back) {
      card.back = this.normalizeCardSide(updates.back, card.id, 'back');
    }

    /*
     * Normal content edits change updatedAt only.
     * They do NOT make an unrated card reviewed.
     */
    card.updatedAt = new Date().toISOString();

    void this.queuePersist();

    return this.clone(card);
  }

  deleteCard(deckId: string, cardId: string): void {
    const deck = this.state.decks.find((candidate) => candidate.id === deckId);

    if (!deck) {
      return;
    }

    deck.cards = deck.cards.filter((card) => card.id !== cardId);

    void this.queuePersist();
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

    const now = new Date().toISOString();

    card.difficulty = difficulty;

    card.updatedAt = now;

    card.lastReviewedAt = now;

    await this.queuePersist();
  }

  // -------------------------------------------------
  // Export / import
  // -------------------------------------------------

  exportState(): FlashcardsState {
    return this.getState();
  }

  async importState(newState: FlashcardsState): Promise<void> {
    this.state = this.normalizeState(newState);

    await this.queuePersist();
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

  /**
   * Stable 128-bit non-cryptographic hash for legacy
   * image migration.
   *
   * It is used only as an identity generator, not for
   * security. The complete card ID, side, old position
   * and image data all contribute to the result.
   */
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
