// src/app/models.ts

// Schwierigkeit 1–10 als eigener Typ
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

// Hilfsarray für Schleifen im UI (Buttons 1–10 etc.)
export const ALL_DIFFICULTY_LEVELS: DifficultyLevel[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
];

// Inhalt einer Kartenseite (Vorder- oder Rückseite)
export interface CardSideContent {
  /** Text auf dieser Seite der Karte. */
  text: string;

  /**
   * Optionales Bild auf dieser Seite der Karte.
   * Wir speichern das als Data-URL (z.B. "data:image/png;base64,..."),
   * damit alles lokal in localStorage gesichert werden kann.
   */
  imageDataUrl?: string;
}

// Eine einzelne Karteikarte
export interface Flashcard {
  /** Eindeutige ID der Karte. */
  id: string;

  /** Vorderseite der Karte (mit Text + optionalem Bild). */
  front: CardSideContent;

  /** Rückseite der Karte (mit Text + optionalem Bild). */
  back: CardSideContent;

  /**
   * Schwierigkeit 1 (sehr leicht) bis 10 (sehr schwer).
   * Nach jedem Anschauen ordnen wir die Karte in einen dieser "Unterstapel" ein.
   */
  difficulty: DifficultyLevel;

  /** Erstellzeitpunkt als ISO-String, z.B. new Date().toISOString(). */
  createdAt: string;

  /** Optional: letzter Änderungszeitpunkt. */
  updatedAt?: string;
}

// Ein Stapel (Deck) von Karteikarten
export interface Deck {
  /** Eindeutige ID des Stapels. */
  id: string;

  /** Name des Stapels, z.B. "Spanisch – Verben". */
  name: string;

  /** Optionale Beschreibung für die Übersicht. */
  description?: string;

  /** Alle Karten dieses Stapels. */
  cards: Flashcard[];
}

/**
 * Gesamter Zustand der App.
 * Diese Struktur legen wir später 1:1 in localStorage ab.
 */
export interface FlashcardsState {
  decks: Deck[];
}
