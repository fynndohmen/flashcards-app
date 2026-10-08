// src/app/flashcards-state.service.ts

import { Injectable } from '@angular/core';
import {
  ALL_DIFFICULTY_LEVELS,
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

@Injectable({ providedIn: 'root' })
export class FlashcardsStateService {
  private state: FlashcardsState = { decks: [] };
  private readyPromise: Promise<void>;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.readyPromise = this.load();
  }

  /**
   * AppComponent should wait for this before reading decks.
   * IndexedDB is asynchronous, unlike localStorage.
   */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  // -------------------------------------------------
  // Laden / Speichern inkl. Migration alter Daten
  // -------------------------------------------------

  private async load(): Promise<void> {
    try {
      const indexedDbState = await this.readStateFromIndexedDb();

      if (indexedDbState) {
        this.state = this.normalizeState(indexedDbState);
        return;
      }

      const legacyState = this.loadFromLocalStorage();

      if (legacyState) {
        this.state = this.normalizeState(legacyState);

        // Migrate old localStorage data into IndexedDB.
        await this.persist();

        return;
      }

      this.state = { decks: [] };
    } catch (err) {
      console.error('Failed to load flashcards state', err);
      this.state = { decks: [] };
    }
  }

  private loadFromLocalStorage(): FlashcardsState | null {
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as FlashcardsState;
      return parsed;
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
      await this.writeStateToIndexedDb(this.normalizeState(this.state));
    } catch (err) {
      console.error('Failed to persist flashcards state to IndexedDB', err);
      throw err;
    }
  }

  /**
   * Normalisiert einen Kartenseiten-Content und migriert alte Strukturen:
   * - stellt sicher, dass text ein String ist
   * - wandelt altes `imageDataUrl` -> `imageDataUrls: string[]` um
   */
  private normalizeCardSide(side: any): CardSideContent {
    const text = typeof side?.text === 'string' ? side.text : '';

    let imageDataUrls: string[] = [];

    if (Array.isArray(side?.imageDataUrls)) {
      // Neue Struktur – mehrere Bilder
      imageDataUrls = side.imageDataUrls.filter(
        (url: unknown) => typeof url === 'string' && !!url
      );
    } else if (typeof side?.imageDataUrl === 'string' && side.imageDataUrl) {
      // Alte Struktur – ein einzelnes Bild-Feld
      imageDataUrls = [side.imageDataUrl];
    }

    return { text, imageDataUrls };
  }

  /**
   * Normalisiert eine Karte und migriert fehlende Felder.
   */
  private normalizeCard(raw: any): Flashcard {
    const createdAt: string =
      typeof raw?.createdAt === 'string' && raw.createdAt
        ? raw.createdAt
        : new Date().toISOString();

    // Wenn updatedAt fehlt, setzen wir es auf createdAt => "unrated/unverändert"
    const updatedAt: string =
      typeof raw?.updatedAt === 'string' && raw.updatedAt
        ? raw.updatedAt
        : createdAt;

    const difficultyRaw = raw?.difficulty;
    const difficulty: DifficultyLevel =
      ALL_DIFFICULTY_LEVELS.includes(difficultyRaw)
        ? (difficultyRaw as DifficultyLevel)
        : 5;

    return {
      id:
        typeof raw?.id === 'string' && raw.id
          ? raw.id
          : this.generateId(),
      front: this.normalizeCardSide(raw?.front),
      back: this.normalizeCardSide(raw?.back),
      difficulty,
      createdAt,
      updatedAt,
    };
  }

  /**
   * Normalisiert ein Deck.
   */
  private normalizeDeck(raw: any): Deck {
    const cardsArray: any[] = Array.isArray(raw?.cards) ? raw.cards : [];

    return {
      id:
        typeof raw?.id === 'string' && raw.id
          ? raw.id
          : this.generateId(),
      name:
        typeof raw?.name === 'string' && raw.name.trim()
          ? raw.name
          : 'Untitled deck',
      description:
        typeof raw?.description === 'string' && raw.description.trim()
          ? raw.description
          : undefined,
      cards: cardsArray.map((c) => this.normalizeCard(c)),
    };
  }

  /**
   * Normalisiert den kompletten State.
   */
  private normalizeState(raw: any): FlashcardsState {
    const decksArray: any[] = Array.isArray(raw?.decks) ? raw.decks : [];
    return {
      decks: decksArray.map((d) => this.normalizeDeck(d)),
    };
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
  // Public API – Lesen
  // -------------------------------------------------

  /** Sichere, kopierte Version des kompletten States. */
  getState(): FlashcardsState {
    try {
      return structuredClone(this.state);
    } catch {
      return JSON.parse(JSON.stringify(this.state)) as FlashcardsState;
    }
  }

  /** Alle Decks. */
  getDecks(): Deck[] {
    return this.getState().decks;
  }

  /** Einzelnes Deck per ID. */
  getDeckById(deckId: string): Deck | undefined {
    return this.getState().decks.find((d) => d.id === deckId);
  }

  // -------------------------------------------------
  // Public API – Decks
  // -------------------------------------------------

  /** Neues Deck anlegen. */
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

  /** Deck bearbeiten (Name/Beschreibung). */
  updateDeck(
    deckId: string,
    updates: Partial<Pick<Deck, 'name' | 'description'>>
  ): Deck | undefined {
    const deck = this.state.decks.find((d) => d.id === deckId);
    if (!deck) return undefined;

    if (typeof updates.name === 'string') {
      deck.name = updates.name.trim();
    }

    if (typeof updates.description === 'string') {
      deck.description = updates.description.trim() || undefined;
    }

    void this.queuePersist();
    return this.clone(deck);
  }

  /** Deck löschen. */
  deleteDeck(deckId: string): void {
    this.state.decks = this.state.decks.filter((d) => d.id !== deckId);
    void this.queuePersist();
  }

  // -------------------------------------------------
  // Public API – Karten
  // -------------------------------------------------

  /**
   * Neue Karte in einem Deck anlegen.
   */
  createCard(
    deckId: string,
    front: CardSideContent,
    back: CardSideContent,
    difficulty: DifficultyLevel
  ): Flashcard | undefined {
    const deck = this.state.decks.find((d) => d.id === deckId);
    if (!deck) return undefined;

    const now = new Date().toISOString();

    const newCard: Flashcard = {
      id: this.generateId(),
      front: this.normalizeCardSide(front),
      back: this.normalizeCardSide(back),
      difficulty,
      createdAt: now,
      updatedAt: now,
    };

    deck.cards.push(newCard);
    void this.queuePersist();

    return this.clone(newCard);
  }

  /**
   * Existierende Karte aktualisieren (Text/Bilder).
   */
  updateCard(
    deckId: string,
    cardId: string,
    updates: Partial<Pick<Flashcard, 'front' | 'back'>>
  ): Flashcard | undefined {
    const deck = this.state.decks.find((d) => d.id === deckId);
    if (!deck) return undefined;

    const card = deck.cards.find((c) => c.id === cardId);
    if (!card) return undefined;

    if (updates.front) {
      card.front = this.normalizeCardSide(updates.front);
    }

    if (updates.back) {
      card.back = this.normalizeCardSide(updates.back);
    }

    card.updatedAt = new Date().toISOString();
    void this.queuePersist();

    return this.clone(card);
  }

  /** Karte löschen. */
  deleteCard(deckId: string, cardId: string): void {
    const deck = this.state.decks.find((d) => d.id === deckId);
    if (!deck) return;

    deck.cards = deck.cards.filter((c) => c.id !== cardId);
    void this.queuePersist();
  }

  /**
   * Schwierigkeit einer Karte nach einer Wiederholung setzen.
   * (Unterstapel 1–10 in deiner Idee.)
   */
  async setCardDifficulty(
    deckId: string,
    cardId: string,
    difficulty: DifficultyLevel
  ): Promise<void> {
    const deck = this.state.decks.find((d) => d.id === deckId);
    if (!deck) return;

    const card = deck.cards.find((c) => c.id === cardId);
    if (!card) return;

    card.difficulty = difficulty;
    card.updatedAt = new Date().toISOString();

    await this.queuePersist();
  }

  // -------------------------------------------------
  // Export / Import
  // -------------------------------------------------

  /** Zustand für Export (Backup) holen. */
  exportState(): FlashcardsState {
    return this.getState();
  }

  /**
   * Komplette App aus einem Backup überschreiben.
   */
  async importState(newState: FlashcardsState): Promise<void> {
    this.state = this.normalizeState(newState);
    await this.queuePersist();
  }

  // -------------------------------------------------
  // Hilfsfunktionen
  // -------------------------------------------------

  private generateId(): string {
    return (
      Math.random().toString(36).slice(2) +
      Date.now().toString(36)
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