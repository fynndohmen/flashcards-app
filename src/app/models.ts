// src/app/models.ts

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const ALL_DIFFICULTY_LEVELS: DifficultyLevel[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * One locally stored image belonging to a card side.
 *
 * The ID is stable and independent from its position in the array.
 * This is important for multi-device sync.
 */
export interface CardImageContent {
  id: string;
  dataUrl: string;
}

/**
 * Content of one side of a flashcard.
 */
export interface CardSideContent {
  text: string;
  images: CardImageContent[];
}

/**
 * A single flashcard.
 */
export interface Flashcard {
  id: string;

  front: CardSideContent;
  back: CardSideContent;

  difficulty: DifficultyLevel;

  createdAt: string;
  updatedAt: string;

  /**
   * null:
   *   This card has never been rated/reviewed.
   *
   * ISO timestamp:
   *   Last time the card received a difficulty rating.
   *
   * Normal text/image edits do not change this field.
   */
  lastReviewedAt: string | null;
}

/**
 * A deck of flashcards.
 */
export interface Deck {
  id: string;
  name: string;
  description?: string;
  cards: Flashcard[];
}

/**
 * Global user-visible application state.
 */
export interface FlashcardsState {
  decks: Deck[];
}
