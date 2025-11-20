// src/app/flashcards-state.service.ts

import { Injectable } from '@angular/core';
import {
  CardSideContent,
  Deck,
  DifficultyLevel,
  Flashcard,
  FlashcardsState,
} from './models';

const STORAGE_KEY = 'flashcards-app-state-v1';

/**
 * Service verwaltet den kompletten Zustand der App
 * (Stapel, Karten, Schwierigkeitsgrade) und speichert
 * alles in localStorage.
 */
@Injectable({
  providedIn: 'root',
})
export class FlashcardsStateService {
  private state: FlashcardsState;

  constructor() {
    const loaded = this.loadFromStorage();
    this.state = loaded ? loaded : this.createInitialState();
    this.saveToStorage();
  }

  // ----------------------------------------------------
  // Public API – wird später vom UI genutzt
  // ----------------------------------------------------

  /** Liefert eine Kopie des aktuellen Zustands. */
  getState(): FlashcardsState {
    return this.deepClone(this.state);
  }

  /** Alle Stapel. */
  getDecks(): Deck[] {
    return this.deepClone(this.state.decks);
  }

  /** Einzelnen Stapel per ID holen. */
  getDeckById(deckId: string): Deck | undefined {
    for (const deck of this.state.decks) {
      if (deck.id === deckId) {
        return this.deepClone(deck);
      }
    }
    return undefined;
  }

  /** Neuen Stapel anlegen. */
  createDeck(name: string, description?: string): Deck {
    const newDeck: Deck = {
      id: this.generateId(),
      name: name.trim(),
      description: description ? description.trim() : undefined,
      cards: [],
    };

    this.state.decks.push(newDeck);
    this.persist();
    return this.deepClone(newDeck);
  }

  /** Stapel umbenennen / Beschreibung ändern. */
  updateDeck(
    deckId: string,
    updates: Partial<Pick<Deck, 'name' | 'description'>>
  ): Deck | undefined {
    const deck = this.findDeck(deckId);
    if (!deck) return undefined;

    if (typeof updates.name === 'string') {
      deck.name = updates.name.trim();
    }
    if (typeof updates.description === 'string') {
      deck.description = updates.description.trim();
    }

    this.persist();
    return this.deepClone(deck);
  }

  /** Stapel löschen. */
  deleteDeck(deckId: string): void {
    const newDecks: Deck[] = [];
    for (const deck of this.state.decks) {
      if (deck.id !== deckId) {
        newDecks.push(deck);
      }
    }
    this.state.decks = newDecks;
    this.persist();
  }

  /** Neue Karte in einem Stapel anlegen. */
  createCard(
    deckId: string,
    front: CardSideContent,
    back: CardSideContent,
    initialDifficulty: DifficultyLevel = 5
  ): Flashcard | undefined {
    const deck = this.findDeck(deckId);
    if (!deck) return undefined;

    const now = new Date().toISOString();
    const card: Flashcard = {
      id: this.generateId(),
      front: this.normalizeSide(front),
      back: this.normalizeSide(back),
      difficulty: initialDifficulty,
      createdAt: now,
      updatedAt: now,
    };

    deck.cards.push(card);
    this.persist();
    return this.deepClone(card);
  }

  /** Existierende Karte aktualisieren (Text/Bilder). */
  updateCard(
    deckId: string,
    cardId: string,
    updates: Partial<Pick<Flashcard, 'front' | 'back'>>
  ): Flashcard | undefined {
    const deck = this.findDeck(deckId);
    if (!deck) return undefined;

    const card = this.findCard(deck, cardId);
    if (!card) return undefined;

    if (updates.front) {
      card.front = this.normalizeSide(updates.front);
    }
    if (updates.back) {
      card.back = this.normalizeSide(updates.back);
    }
    card.updatedAt = new Date().toISOString();

    this.persist();
    return this.deepClone(card);
  }

  /** Karte löschen. */
  deleteCard(deckId: string, cardId: string): void {
    const deck = this.findDeck(deckId);
    if (!deck) return;

    const newCards: Flashcard[] = [];
    for (const card of deck.cards) {
      if (card.id !== cardId) {
        newCards.push(card);
      }
    }
    deck.cards = newCards;
    this.persist();
  }

  /**
   * Schwierigkeit einer Karte nach einer Wiederholung setzen.
   * (Unterstapel 1–10 in deiner Idee).
   */
  setCardDifficulty(
    deckId: string,
    cardId: string,
    difficulty: DifficultyLevel
  ): Flashcard | undefined {
    if (difficulty < 1 || difficulty > 10) {
      throw new Error('Invalid difficulty level: ' + difficulty);
    }

    const deck = this.findDeck(deckId);
    if (!deck) return undefined;

    const card = this.findCard(deck, cardId);
    if (!card) return undefined;

    card.difficulty = difficulty;
    card.updatedAt = new Date().toISOString();
    this.persist();
    return this.deepClone(card);
  }

  // ----------------------------------------------------
  // Private Hilfsfunktionen
  // ----------------------------------------------------

  private createInitialState(): FlashcardsState {
    return {
      decks: [],
    };
  }

  private normalizeSide(side: CardSideContent): CardSideContent {
    return {
      text: (side.text || '').trim(),
      imageDataUrl: side.imageDataUrl || undefined,
    };
  }

  private findDeck(deckId: string): Deck | undefined {
    for (const deck of this.state.decks) {
      if (deck.id === deckId) {
        return deck;
      }
    }
    return undefined;
  }

  private findCard(deck: Deck, cardId: string): Flashcard | undefined {
    for (const card of deck.cards) {
      if (card.id === cardId) {
        return card;
      }
    }
    return undefined;
  }

  private deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  private loadFromStorage(): FlashcardsState | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as FlashcardsState;
      if (!parsed.decks) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Wenn localStorage z.B. im privaten Modus nicht geht, ignorieren wir den Fehler.
    }
  }

  private persist(): void {
    this.saveToStorage();
  }

  private generateId(): string {
    // einfache ID: Zeitstempel + random – reicht für lokale App völlig
    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).substring(2, 10)
    );
  }
}
