// src/app/app.ts

import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { CardSideContent, Deck, DifficultyLevel, Flashcard, FlashcardsState } from './models';

import { FlashcardsStateService } from './flashcards-state.service';
import { SyncApiError, SyncApiService } from './sync-api.service';

import { StoredDeviceAuth, SyncStorageService } from './sync-storage.service';

type DeckViewMode = 'menu' | 'edit' | 'practice' | null;

type PracticeDifficultyFilter = 'all' | 'unrated' | number;

type SyncServerStatus = 'checking' | 'online' | 'offline';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class AppComponent {
  title = 'flashcards-app';

  isAppReady = false;

  decks: Deck[] = [];
  selectedDeckId: string | null = null;
  deckViewMode: DeckViewMode = null;

  newDeckName = '';
  newDeckDescription = '';

  cardForm = {
    editingCardId: null as string | null,
    frontText: '',
    frontImageDataUrls: [] as string[],
    backText: '',
    backImageDataUrls: [] as string[],
  };

  isPracticeMode = false;
  showBackSide = false;
  practiceCards: Flashcard[] = [];
  practiceIndex = 0;
  practiceFinished = false;

  practiceDifficultyFilter: PracticeDifficultyFilter = 'all';

  syncServerStatus: SyncServerStatus = 'checking';

  syncServerMessage = 'Checking home sync server...';

  deviceId = '';
  deviceName = '';
  enrollmentSecret = '';

  isDeviceRegistered = false;
  registeredDeviceName = '';

  isRegisteringDevice = false;

  syncRegistrationMessage = '';
  syncRegistrationError = '';

  constructor(
    private state: FlashcardsStateService,
    private syncApi: SyncApiService,
    private syncStorage: SyncStorageService,
  ) {
    void this.initializeApp();
  }

  private async initializeApp(): Promise<void> {
    try {
      await this.state.whenReady();

      this.reloadDecks();
    } catch (err) {
      console.error('Failed to initialize app', err);

      alert('The app could not load saved data. Please check the console for details.');
    }

    this.isAppReady = true;

    void this.initializeSyncEnrollment();
  }

  private async initializeSyncEnrollment(): Promise<void> {
    try {
      const storedAuth = await this.syncStorage.getDeviceAuth();

      if (storedAuth && storedAuth.deviceId && storedAuth.deviceName && storedAuth.token) {
        this.deviceId = storedAuth.deviceId;

        this.deviceName = storedAuth.deviceName;

        this.registeredDeviceName = storedAuth.deviceName;

        this.isDeviceRegistered = true;

        await this.syncStorage.saveDeviceIdentity({
          deviceId: storedAuth.deviceId,
          deviceName: storedAuth.deviceName,
          createdAt: storedAuth.registeredAt || new Date().toISOString(),
        });
      } else {
        const identity = await this.syncStorage.getOrCreateDeviceIdentity(this.guessDeviceName());

        this.deviceId = identity.deviceId;

        this.deviceName = identity.deviceName;
      }
    } catch (err) {
      console.error('Failed to initialize sync device identity', err);

      this.syncRegistrationError = 'Could not load the local sync device identity.';
    }

    await this.checkSyncServer();
  }

  async checkSyncServer(): Promise<void> {
    this.syncServerStatus = 'checking';
    this.syncServerMessage = 'Checking home sync server...';

    try {
      const health = await this.syncApi.health();

      if (health.status === 'ok' && health.database === 'ok') {
        this.syncServerStatus = 'online';
        this.syncServerMessage = 'Home sync server is reachable.';
        return;
      }

      this.syncServerStatus = 'offline';
      this.syncServerMessage = 'Home sync server responded, but is not healthy.';
    } catch (err) {
      console.error('Sync server health check failed', err);

      this.syncServerStatus = 'offline';
      this.syncServerMessage = 'Home sync server is not reachable from this device.';
    }
  }

  async registerSyncDevice(): Promise<void> {
    const name = this.deviceName.trim();
    const secret = this.enrollmentSecret.trim();

    this.syncRegistrationMessage = '';
    this.syncRegistrationError = '';

    if (!this.deviceId) {
      this.syncRegistrationError = 'Device ID is not ready yet.';
      return;
    }

    if (!name) {
      this.syncRegistrationError = 'Please enter a device name.';
      return;
    }

    if (!secret) {
      this.syncRegistrationError = 'Please enter the enrollment secret.';
      return;
    }

    const rotatingToken = this.isDeviceRegistered;

    if (rotatingToken) {
      const confirmed = confirm(
        'This device is already registered. Re-registering it will rotate the device token and invalidate the previous token for this device. Continue?',
      );

      if (!confirmed) {
        return;
      }
    }

    this.isRegisteringDevice = true;

    try {
      const result = await this.syncApi.registerDevice(this.deviceId, name, secret);

      const registeredAt = new Date().toISOString();

      const auth: StoredDeviceAuth = {
        deviceId: result.device.id,
        deviceName: result.device.name,
        token: result.token,
        registeredAt,
      };

      await this.syncStorage.saveDeviceAuth(auth);

      await this.syncStorage.saveDeviceIdentity({
        deviceId: result.device.id,
        deviceName: result.device.name,
        createdAt: registeredAt,
      });

      this.deviceId = result.device.id;

      this.deviceName = result.device.name;

      this.registeredDeviceName = result.device.name;

      this.isDeviceRegistered = true;

      this.enrollmentSecret = '';

      this.syncServerStatus = 'online';
      this.syncServerMessage = 'Home sync server is reachable.';

      this.syncRegistrationMessage = rotatingToken
        ? 'Device re-registered successfully. The device token was rotated.'
        : 'Device registered successfully.';
    } catch (err) {
      console.error('Device registration failed', err);

      this.syncRegistrationError = this.describeSyncError(err);
    } finally {
      this.isRegisteringDevice = false;
    }
  }

  private describeSyncError(error: unknown): string {
    if (error instanceof SyncApiError) {
      if (error.status === 401) {
        return 'Registration failed: the enrollment secret was rejected.';
      }

      return `${error.message} (HTTP ${error.status})`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown sync error.';
  }

  private guessDeviceName(): string {
    const platform = navigator.platform || '';

    const userAgent = navigator.userAgent || '';

    if (/iPad/i.test(userAgent) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      return 'iPad';
    }

    if (/Mac/i.test(platform)) {
      return 'MacBook';
    }

    if (/Linux/i.test(platform)) {
      return 'Linux device';
    }

    if (/Win/i.test(platform)) {
      return 'Windows device';
    }

    return 'Flashcards device';
  }

  get selectedDeck(): Deck | undefined {
    if (!this.selectedDeckId) {
      return undefined;
    }

    return this.decks.find((deck) => deck.id === this.selectedDeckId);
  }

  get currentPracticeCard(): Flashcard | undefined {
    if (!this.isPracticeMode) {
      return undefined;
    }

    if (this.practiceIndex < 0 || this.practiceIndex >= this.practiceCards.length) {
      return undefined;
    }

    return this.practiceCards[this.practiceIndex];
  }

  reloadDecks(): void {
    this.decks = this.state.getDecks();

    if (this.selectedDeckId && !this.decks.some((deck) => deck.id === this.selectedDeckId)) {
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
    this.deckViewMode = 'menu';

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
    if (!this.selectedDeck) {
      return;
    }

    this.deckViewMode = 'edit';
    this.exitPracticeMode();
  }

  goToPracticeMode(): void {
    if (!this.selectedDeck) {
      return;
    }

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

  exportData(): void {
    try {
      const state = this.state.exportState();

      const json = JSON.stringify(state, null, 2);

      const blob = new Blob([json], {
        type: 'application/json',
      });

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
          'Importing this backup will replace all decks and cards on this device. Continue?',
        );

        if (!ok) {
          return;
        }

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

    input.value = '';
  }

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

    if (!deck) {
      return;
    }

    const front: CardSideContent = {
      text: (this.cardForm.frontText || '').trim(),

      imageDataUrls: [...this.cardForm.frontImageDataUrls],
    };

    const back: CardSideContent = {
      text: (this.cardForm.backText || '').trim(),

      imageDataUrls: [...this.cardForm.backImageDataUrls],
    };

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

    if (!deck) {
      return;
    }

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

  onFrontImageSelected(event: Event): void {
    this.loadImageFromEvent(event, (dataUrl) => {
      this.cardForm.frontImageDataUrls = [...this.cardForm.frontImageDataUrls, dataUrl];
    });
  }

  clearFrontImages(): void {
    this.cardForm.frontImageDataUrls = [];
  }

  removeFrontImage(index: number): void {
    this.cardForm.frontImageDataUrls = this.cardForm.frontImageDataUrls.filter(
      (_img, i) => i !== index,
    );
  }

  onBackImageSelected(event: Event): void {
    this.loadImageFromEvent(event, (dataUrl) => {
      this.cardForm.backImageDataUrls = [...this.cardForm.backImageDataUrls, dataUrl];
    });
  }

  clearBackImages(): void {
    this.cardForm.backImageDataUrls = [];
  }

  removeBackImage(index: number): void {
    this.cardForm.backImageDataUrls = this.cardForm.backImageDataUrls.filter(
      (_img, i) => i !== index,
    );
  }

  private loadImageFromEvent(event: Event, onLoaded: (dataUrl: string) => void): void {
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

    input.value = '';
  }

  startPractice(): void {
    const deck = this.selectedDeck;

    if (!deck || deck.cards.length === 0) {
      return;
    }

    let pool: Flashcard[] = deck.cards;

    if (this.practiceDifficultyFilter === 'unrated') {
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
    if (!this.isPracticeMode || !this.currentPracticeCard) {
      return;
    }

    this.showBackSide = !this.showBackSide;
  }

  async rateCurrentCard(level: number): Promise<void> {
    const deck = this.selectedDeck;

    const card = this.currentPracticeCard;

    if (!deck || !card) {
      return;
    }

    if (level < 1 || level > 10) {
      return;
    }

    const difficulty = level as DifficultyLevel;

    try {
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

  getTotalCount(deck: Deck): number {
    return deck.cards.length;
  }

  getUnratedCount(deck: Deck): number {
    return deck.cards.filter((card) => {
      const updated = card.updatedAt ?? card.createdAt;

      return updated === card.createdAt;
    }).length;
  }

  getDifficultyCount(deck: Deck, level: number): number {
    return deck.cards.filter((card) => card.difficulty === level).length;
  }

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
