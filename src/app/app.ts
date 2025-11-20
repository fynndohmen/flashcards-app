// src/app/app.ts

import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  CardSideContent,
  Deck,
  DifficultyLevel,
  Flashcard,
} from './models';
import { FlashcardsStateService } from './flashcards-state.service';

type DeckViewMode = 'menu' | 'edit' | 'practice' | null;

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
    frontImageDataUrl: '' as string | null,
    backText: '',
    backImageDataUrl: '' as string | null,
  };

  // Practice mode
  isPracticeMode = false;
  showBackSide = false;
  practiceCards: Flashcard[] = [];
  practiceIndex = 0;
  practiceFinished = false;

  constructor(private state: FlashcardsStateService) {
    this.reloadDecks();
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
  // Card management
  // -----------------------------

  startCreateCard(): void {
    this.resetCardForm();
  }

  startEditCard(card: Flashcard): void {
    this.cardForm.editingCardId = card.id;
    this.cardForm.frontText = card.front.text;
    this.cardForm.frontImageDataUrl = card.front.imageDataUrl || null;
    this.cardForm.backText = card.back.text;
    this.cardForm.backImageDataUrl = card.back.imageDataUrl || null;
  }

  saveCard(): void {
    const deck = this.selectedDeck;
    if (!deck) return;

    const front: CardSideContent = {
      text: (this.cardForm.frontText || '').trim(),
      imageDataUrl: this.cardForm.frontImageDataUrl || undefined,
    };

    const back: CardSideContent = {
      text: (this.cardForm.backText || '').trim(),
      imageDataUrl: this.cardForm.backImageDataUrl || undefined,
    };

    // Ignore completely empty cards (no text, no images)
    if (!front.text && !front.imageDataUrl && !back.text && !back.imageDataUrl) {
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
      frontImageDataUrl: null,
      backText: '',
      backImageDataUrl: null,
    };
  }

  // -----------------------------
  // Image handling (front/back)
  // -----------------------------

  onFrontImageSelected(event: Event): void {
    this.loadImageFromEvent(event, (dataUrl) => {
      this.cardForm.frontImageDataUrl = dataUrl;
    });
  }

  clearFrontImage(): void {
    this.cardForm.frontImageDataUrl = null;
  }

  onBackImageSelected(event: Event): void {
    this.loadImageFromEvent(event, (dataUrl) => {
      this.cardForm.backImageDataUrl = dataUrl;
    });
  }

  clearBackImage(): void {
    this.cardForm.backImageDataUrl = null;
  }

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
  }

  // -----------------------------
  // Practice mode
  // -----------------------------

  startPractice(): void {
    const deck = this.selectedDeck;
    if (!deck || deck.cards.length === 0) {
      return;
    }

    this.practiceCards = this.shuffle([...deck.cards]);
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

  rateCurrentCard(level: number): void {
    const deck = this.selectedDeck;
    const card = this.currentPracticeCard;
    if (!deck || !card) return;
    if (level < 1 || level > 10) return;

    const difficulty = level as DifficultyLevel;
    this.state.setCardDifficulty(deck.id, card.id, difficulty);

    this.nextPracticeCard();
    this.reloadDecks();
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
