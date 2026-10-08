// src/app/models.ts

// Difficulty 1–10 as its own type
export type DifficultyLevel =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10;

// Helper array for loops in the UI (buttons 1–10 etc.)
export const ALL_DIFFICULTY_LEVELS: DifficultyLevel[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
];

/**
 * Content of a single card side (front or back).
 *
 * - text: text on this side
 * - imageDataUrls: zero or more images, stored as data URLs
 */
export interface CardSideContent {
  /** Text on this side of the card. */
  text: string;

  /**
   * Optional images on this side of the card.
   * We store them as Data-URLs (e.g. "data:image/png;base64,..."),
   * so everything can be saved locally (localStorage / export).
   */
  imageDataUrls: string[];
}

// A single flashcard
export interface Flashcard {
  /** Unique ID of the card. */
  id: string;

  /** Front side of the card (text + images). */
  front: CardSideContent;

  /** Back side of the card (text + images). */
  back: CardSideContent;

  /**
   * Difficulty 1 (very easy) to 10 (very hard).
   * After each review we assign the card to one of these "sub-stacks".
   */
  difficulty: DifficultyLevel;

  /** Creation timestamp as ISO string, e.g. new Date().toISOString(). */
  createdAt: string;

  /** Optional: last modification timestamp. */
  updatedAt?: string;
}

// A deck (stack) of flashcards
export interface Deck {
  /** Unique ID of the deck. */
  id: string;

  /** Name of the deck, e.g. "Spanish – Verbs". */
  name: string;

  /** Optional description shown in the overview. */
  description?: string;

  /** All cards in this deck. */
  cards: Flashcard[];
}

/**
 * Global app state.
 * We store this structure 1:1 in localStorage / export backups.
 */
export interface FlashcardsState {
  decks: Deck[];
}
