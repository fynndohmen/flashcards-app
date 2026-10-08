// src/app/app.ts

import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  CardSideContent,
  Deck,
  DifficultyLevel,
  Flashcard,
  FlashcardsState,
} from './models';
import { FlashcardsStateService } from './flashcards-state.service';

type DeckViewMode = 'menu' | 'edit' | 'practice' | null;
// allow number so template assignments like "practiceDifficultyFilter = level" are valid
type PracticeDifficultyFilter = 'all' | 'unrated' | number;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class AppComponent {
  // App title (not heavily used, but we keep it)
  title = 'flashcards-app';

  // App is loaded from IndexedDB asynchronously
  isAppReady = false;

  // -----------------------------
  // Overall state for the UI
  // -----------------------------
  decks: Deck[] = [];
  selectedDeckId: string | null = null;
  deckViewMode: DeckViewMode = null; // 'menu' | 'edit' | 'practice'

  // Form for new deck
  newDeckName = '';
  newDeckDescription = '';

  // Form for card (create or edit)
  cardForm = {
    editingCardId: null as string | null,
    frontText: '',
    frontImageDataUrls: [] as string[],
    backText: '',
    backImageDataUrls: [] as string[],
  };

  // Practice mode
  isPracticeMode = false;
  showBackSide = false;
  practiceCards: Flashcard[] = [];
  practiceIndex = 0;
  practiceFinished = false;

  // Practice difficulty filter: 'all', 'unrated', or a specific level 1–10
  practiceDifficultyFilter: PracticeDifficultyFilter = 'all';

  constructor(private state: FlashcardsStateService) {
    void this.initializeApp();
  }

  private async initializeApp(): Promise<void> {
    try {
      await this.state.whenReady();
      this.reloadDecks();
      this.isAppReady = true;
    } catch (err) {
      console.error('Failed to initialize app', err);
      alert('The app could not load saved data. Please check the console for details.');
      this.isAppReady = true;
    }
  }

  // Currently selected deck
  get selectedDeck(): Deck | undefined {
    if (!this.selectedDeckId) return undefined;
    return this.decks.find((d) => d.id === this.selectedDeckId);
  }

  // Current card in practice mode
  get currentPracticeCard(): Flashcard | undefined {
    if (!this.isPracticeMode) return undefined;
    if (this.practiceIndex < 0 || this.practiceIndex >= this.practiceCards.length) {
      return undefined;
    }
    return this.practiceCards[this.practiceIndex];
  }

  // -----------------------------
  // Deck management
  // -----------------------------

  reloadDecks(): void {
    this.decks = this.state.getDecks();
    if (
      this.selectedDeckId &&
      !this.decks.some((d) => d.id === this.selectedDeckId)
    ) {
      this.selectedDeckId = null;
      this.deckViewMode = null;
    }
  }

  createDeck(): void {
    const name = this.newDeckName.trim();
    if (!name) {
      return;
    }

    this.state.createDeck(name, this.newDeckDescription);
    this.newDeckName = '';
    this.newDeckDescription = '';
    this.reloadDecks();
  }

  selectDeck(deck: Deck): void {
    this.selectedDeckId = deck.id;
    this.deckViewMode = 'menu'; // show mode selection first
    this.exitPracticeMode();
    this.resetCardForm();
  }

  backToDeckList(): void {
    this.selectedDeckId = null;
    this.deckViewMode = null;
    this.exitPracticeMode();
    this.resetCardForm();
  }

  goToEditMode(): void {
    if (!this.selectedDeck) return;
    this.deckViewMode = 'edit';
    this.exitPracticeMode();
  }

  goToPracticeMode(): void {
    if (!this.selectedDeck) return;
    this.deckViewMode = 'practice';
    this.exitPracticeMode();
  }

  backToDeckMenu(): void {
    if (!this.selectedDeck) {
      this.backToDeckList();
      return;
    }
    this.exitPracticeMode();
    this.deckViewMode = 'menu';
  }

  deleteDeck(deck: Deck): void {
    if (!confirm(`Really delete deck "${deck.name}"?`)) {
      return;
    }
    this.state.deleteDeck(deck.id);
    this.reloadDecks();
    this.backToDeckList();
  }

  // -----------------------------
  // Export / Import
  // -----------------------------

  /** Download current state as JSON file. */
  exportData(): void {
    try {
      const state = this.state.exportState();
      const json = JSON.stringify(state, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `flashcards-backup-${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed', err);
      alert('Export failed. Please check the console for details.');
    }
  }

  /**
   * Handle selection of a JSON file and import its contents.
   * Bound to a hidden <input type="file"> in the template.
   */
  importDataFromFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) {
      return;
    }
    const file = input.files[0];

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = reader.result;
        if (typeof text !== 'string') {
          throw new Error('Unexpected file content');
        }

        const parsed = JSON.parse(text) as FlashcardsState;

        const ok = confirm(
          'Importing this backup will replace all decks and cards on this device. Continue?'
        );
        if (!ok) {
          return;
        }

        // Important: wait until IndexedDB has actually saved the imported state.
        await this.state.importState(parsed);

        this.reloadDecks();
        this.selectedDeckId = null;
        this.deckViewMode = null;
        this.exitPracticeMode();
        this.resetCardForm();

        alert('Import successful.');
      } catch (err) {
        console.error('Import failed', err);
        alert('Import failed. Please make sure you selected a valid backup file.');
      }
    };

    reader.readAsText(file);

    // Allow selecting the same file again later
    input.value = '';
  }

  // -----------------------------
  // Card management
  // -----------------------------

  startCreateCard(): void {
    this.resetCardForm();
  }

  startEditCard(card: Flashcard): void {
    this.cardForm.editingCardId = card.id;
    this.cardForm.frontText = card.front.text;
    this.cardForm.frontImageDataUrls = [...(card.front.imageDataUrls || [])];
    this.cardForm.backText = card.back.text;
    this.cardForm.backImageDataUrls = [...(card.back.imageDataUrls || [])];
  }

  saveCard(): void {
    const deck = this.selectedDeck;
    if (!deck) return;

    const front: CardSideContent = {
      text: (this.cardForm.frontText || '').trim(),
      imageDataUrls: [...this.cardForm.frontImageDataUrls],
    };

    const back: CardSideContent = {
      text: (this.cardForm.backText || '').trim(),
      imageDataUrls: [...this.cardForm.backImageDataUrls],
    };

    // Ignore completely empty cards (no text, no images)
    if (
      !front.text &&
      front.imageDataUrls.length === 0 &&
      !back.text &&
      back.imageDataUrls.length === 0
    ) {
      return;
    }

    if (this.cardForm.editingCardId) {
      this.state.updateCard(deck.id, this.cardForm.editingCardId, {
        front,
        back,
      });
    } else {
      const defaultDifficulty: DifficultyLevel = 5;
      this.state.createCard(deck.id, front, back, defaultDifficulty);
    }

    this.resetCardForm();
    this.reloadDecks();
  }

  deleteCard(card: Flashcard): void {
    const deck = this.selectedDeck;
    if (!deck) return;

    if (!confirm('Really delete this card?')) {
      return;
    }

    this.state.deleteCard(deck.id, card.id);
    this.reloadDecks();
  }

  resetCardForm(): void {
    this.cardForm = {
      editingCardId: null,
      frontText: '',
      frontImageDataUrls: [],
      backText: '',
      backImageDataUrls: [],
    };
  }

  // -----------------------------
  // Image handling (front/back)
  // -----------------------------

  onFrontImageSelected(event: Event): void {
    this.loadImageFromEvent(event, (dataUrl) => {
      this.cardForm.frontImageDataUrls = [
        ...this.cardForm.frontImageDataUrls,
        dataUrl,
      ];
    });
  }

  clearFrontImages(): void {
    this.cardForm.frontImageDataUrls = [];
  }

  removeFrontImage(index: number): void {
    this.cardForm.frontImageDataUrls = this.cardForm.frontImageDataUrls.filter(
      (_img, i) => i !== index
    );
  }

  onBackImageSelected(event: Event): void {
    this.loadImageFromEvent(event, (dataUrl) => {
      this.cardForm.backImageDataUrls = [
        ...this.cardForm.backImageDataUrls,
        dataUrl,
      ];
    });
  }

  clearBackImages(): void {
    this.cardForm.backImageDataUrls = [];
  }

  removeBackImage(index: number): void {
    this.cardForm.backImageDataUrls = this.cardForm.backImageDataUrls.filter(
      (_img, i) => i !== index
    );
  }

  /**
   * Reads a single image file from a file input and returns the Data URL.
   * Choose images multiple times to add multiple screenshots.
   */
  private loadImageFromEvent(
    event: Event,
    onLoaded: (dataUrl: string) => void
  ): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) {
      return;
    }
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        onLoaded(result);
      }
    };
    reader.readAsDataURL(file);

    // Allow selecting the same file again later
    input.value = '';
  }

  // -----------------------------
  // Practice mode
  // -----------------------------

  startPractice(): void {
    const deck = this.selectedDeck;
    if (!deck || deck.cards.length === 0) {
      return;
    }

    // Build pool based on selected difficulty filter
    let pool: Flashcard[] = deck.cards;

    if (this.practiceDifficultyFilter === 'unrated') {
      // "Unsorted": cards that were never updated after creation.
      pool = deck.cards.filter((card) => {
        const updated = card.updatedAt ?? card.createdAt;
        return updated === card.createdAt;
      });
    } else if (this.practiceDifficultyFilter !== 'all') {
      const target = this.practiceDifficultyFilter as DifficultyLevel;
      pool = deck.cards.filter((card) => card.difficulty === target);
    }

    if (pool.length === 0) {
      alert('No cards match the selected difficulty filter.');
      return;
    }

    this.practiceCards = this.shuffle([...pool]);
    this.practiceIndex = 0;
    this.practiceFinished = false;
    this.isPracticeMode = true;
    this.showBackSide = false;
  }

  exitPracticeMode(): void {
    this.isPracticeMode = false;
    this.practiceCards = [];
    this.practiceIndex = 0;
    this.practiceFinished = false;
    this.showBackSide = false;
  }

  flipCard(): void {
    if (!this.isPracticeMode || !this.currentPracticeCard) return;
    this.showBackSide = !this.showBackSide;
  }

  async rateCurrentCard(level: number): Promise<void> {
    const deck = this.selectedDeck;
    const card = this.currentPracticeCard;
    if (!deck || !card) return;
    if (level < 1 || level > 10) return;

    const difficulty = level as DifficultyLevel;

    try {
      // Important: wait until IndexedDB has actually saved the difficulty.
      await this.state.setCardDifficulty(deck.id, card.id, difficulty);

      this.nextPracticeCard();
      this.reloadDecks();
    } catch (err) {
      console.error('Failed to save difficulty', err);
      alert('Could not save the difficulty rating. Please try again.');
    }
  }

  private nextPracticeCard(): void {
    if (this.practiceIndex + 1 >= this.practiceCards.length) {
      this.practiceFinished = true;
      this.isPracticeMode = false;
      return;
    }
    this.practiceIndex += 1;
    this.showBackSide = false;
  }

  // -----------------------------
  // Counts for difficulty chips
  // -----------------------------

  /** Total cards in the given deck. */
  getTotalCount(deck: Deck): number {
    return deck.cards.length;
  }

  /** Cards that are "unsorted/unrated" (never updated after creation). */
  getUnratedCount(deck: Deck): number {
    return deck.cards.filter((card) => {
      const updated = card.updatedAt ?? card.createdAt;
      return updated === card.createdAt;
    }).length;
  }

  /** Cards with a specific difficulty level. */
  getDifficultyCount(deck: Deck, level: number): number {
    return deck.cards.filter((card) => card.difficulty === level).length;
  }

  // -----------------------------
  // Utils
  // -----------------------------

  private shuffle<T>(items: T[]): T[] {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}