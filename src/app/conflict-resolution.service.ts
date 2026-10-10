// src/app/conflict-resolution.service.ts

import { Injectable } from '@angular/core';

import { Deck, DifficultyLevel, Flashcard, FlashcardsState } from './models';

import { FlashcardsStateService } from './flashcards-state.service';

import {
  CardSyncSnapshot,
  DeckSyncSnapshot,
  EntitySyncRecord,
  PendingSyncOperation,
  StoredSyncMeta,
  SyncConflictRecord,
} from './sync-metadata.models';

import { SyncStorageService } from './sync-storage.service';

export type ConflictResolutionEntityType = 'deck' | 'card';

export type ConflictResolutionChoice = 'cloud' | 'this-device' | 'merge';

export interface DeckConflictMergeInput {
  name: string;
  description?: string;
}

export interface CardConflictMergeInput {
  frontText: string;
  backText: string;
  difficulty: DifficultyLevel;
  lastReviewedAt: string | null;
}

export interface ConflictResolutionResult {
  entityType: ConflictResolutionEntityType;
  entityId: string;
  choice: ConflictResolutionChoice;

  serverRevision: number;

  pendingOperation: PendingSyncOperation | null;

  requiresPush: boolean;
}

interface ConflictFingerprint {
  detectedAt: string;
  baseRevision: number;
  serverRevision: number;
}

@Injectable({
  providedIn: 'root',
})
export class ConflictResolutionService {
  constructor(
    private state: FlashcardsStateService,
    private syncStorage: SyncStorageService,
  ) {}

  async resolveWithCloud(
    entityType: ConflictResolutionEntityType,
    entityId: string,
  ): Promise<ConflictResolutionResult> {
    await this.state.whenReady();

    const meta = await this.syncStorage.getSyncMeta();

    if (entityType === 'deck') {
      return this.resolveDeckWithCloud(entityId, meta);
    }

    return this.resolveCardWithCloud(entityId, meta);
  }

  async resolveWithThisDevice(
    entityType: ConflictResolutionEntityType,
    entityId: string,
  ): Promise<ConflictResolutionResult> {
    await this.state.whenReady();

    const meta = await this.syncStorage.getSyncMeta();

    if (entityType === 'deck') {
      return this.resolveDeckWithThisDevice(entityId, meta);
    }

    return this.resolveCardWithThisDevice(entityId, meta);
  }

  async mergeDeck(
    entityId: string,
    merged: DeckConflictMergeInput,
  ): Promise<ConflictResolutionResult> {
    await this.state.whenReady();

    const meta = await this.syncStorage.getSyncMeta();

    const record = meta.decks[entityId];

    const conflict = this.requireActiveConflict('deck', entityId, record);

    const fingerprint = this.conflictFingerprint(conflict);

    const server = this.requireDeckSnapshot(conflict.server, 'server');

    const state = this.state.getState();

    const deck = state.decks.find((candidate) => candidate.id === entityId);

    if (!deck) {
      throw new Error(
        `Cannot merge deck conflict "${entityId}" because the local deck is missing.`,
      );
    }

    const name = merged.name.trim();

    if (!name) {
      throw new Error('Merged deck name must not be empty.');
    }

    const description = merged.description?.trim() || undefined;

    deck.name = name;
    deck.description = description;

    const mergedSnapshot: DeckSyncSnapshot = {
      id: entityId,
      name,
      description,
    };

    const matchesServer = this.deckSnapshotsEqual(mergedSnapshot, server);

    await this.state.replaceStateFromSync(state, (currentMeta) => {
      const currentRecord = this.requireMatchingDeckConflict(currentMeta, entityId, fingerprint);

      currentRecord.revision = conflict.serverRevision;

      currentRecord.baseRevision = conflict.serverRevision;

      currentRecord.lastSyncedSnapshot = this.clone(server);

      currentRecord.pendingOperation = matchesServer ? null : 'update';

      currentRecord.conflict = null;
    });

    return {
      entityType: 'deck',
      entityId,
      choice: 'merge',

      serverRevision: conflict.serverRevision,

      pendingOperation: matchesServer ? null : 'update',

      requiresPush: !matchesServer,
    };
  }

  async mergeCard(
    entityId: string,
    merged: CardConflictMergeInput,
  ): Promise<ConflictResolutionResult> {
    await this.state.whenReady();

    const meta = await this.syncStorage.getSyncMeta();

    const record = meta.cards[entityId];

    const conflict = this.requireActiveConflict('card', entityId, record);

    const fingerprint = this.conflictFingerprint(conflict);

    const server = this.requireCardSnapshot(conflict.server, 'server');

    const state = this.state.getState();

    const located = this.findCard(state, entityId);

    if (!located) {
      throw new Error(
        `Cannot merge card conflict "${entityId}" because the local card is missing.`,
      );
    }

    if (server.deckId !== located.deck.id) {
      throw new Error('Cross-deck card conflict resolution is not supported yet.');
    }

    if (!Number.isInteger(merged.difficulty) || merged.difficulty < 1 || merged.difficulty > 10) {
      throw new Error('Merged card difficulty must be between 1 and 10.');
    }

    const mergedSnapshot: CardSyncSnapshot = {
      id: entityId,

      deckId: located.deck.id,

      frontText: merged.frontText,

      backText: merged.backText,

      difficulty: merged.difficulty,

      lastReviewedAt: merged.lastReviewedAt,
    };

    located.card.front.text = merged.frontText;

    located.card.back.text = merged.backText;

    located.card.difficulty = merged.difficulty;

    located.card.lastReviewedAt = merged.lastReviewedAt;

    located.card.updatedAt = new Date().toISOString();

    const matchesServer = this.cardSnapshotsEqual(mergedSnapshot, server);

    await this.state.replaceStateFromSync(state, (currentMeta) => {
      const currentRecord = this.requireMatchingCardConflict(currentMeta, entityId, fingerprint);

      currentRecord.revision = conflict.serverRevision;

      currentRecord.baseRevision = conflict.serverRevision;

      currentRecord.lastSyncedSnapshot = this.clone(server);

      currentRecord.pendingOperation = matchesServer ? null : 'update';

      currentRecord.conflict = null;
    });

    return {
      entityType: 'card',
      entityId,
      choice: 'merge',

      serverRevision: conflict.serverRevision,

      pendingOperation: matchesServer ? null : 'update',

      requiresPush: !matchesServer,
    };
  }

  private async resolveDeckWithCloud(
    entityId: string,
    meta: StoredSyncMeta,
  ): Promise<ConflictResolutionResult> {
    const record = meta.decks[entityId];

    const conflict = this.requireActiveConflict('deck', entityId, record);

    const fingerprint = this.conflictFingerprint(conflict);

    const server = this.requireDeckSnapshot(conflict.server, 'server');

    const state = this.state.getState();

    const deck = state.decks.find((candidate) => candidate.id === entityId);

    if (!deck) {
      throw new Error(
        `Cannot choose Cloud for deck "${entityId}" because the local deck is missing.`,
      );
    }

    deck.name = server.name;

    deck.description = server.description;

    await this.state.replaceStateFromSync(state, (currentMeta) => {
      const currentRecord = this.requireMatchingDeckConflict(currentMeta, entityId, fingerprint);

      this.acceptServerSnapshot(currentRecord, server, conflict.serverRevision);
    });

    return {
      entityType: 'deck',
      entityId,
      choice: 'cloud',

      serverRevision: conflict.serverRevision,

      pendingOperation: null,

      requiresPush: false,
    };
  }

  private async resolveCardWithCloud(
    entityId: string,
    meta: StoredSyncMeta,
  ): Promise<ConflictResolutionResult> {
    const record = meta.cards[entityId];

    const conflict = this.requireActiveConflict('card', entityId, record);

    const fingerprint = this.conflictFingerprint(conflict);

    const server = this.requireCardSnapshot(conflict.server, 'server');

    const state = this.state.getState();

    const located = this.findCard(state, entityId);

    if (!located) {
      throw new Error(
        `Cannot choose Cloud for card "${entityId}" because the local card is missing.`,
      );
    }

    if (server.deckId !== located.deck.id) {
      throw new Error('Cross-deck card conflict resolution is not supported yet.');
    }

    located.card.front.text = server.frontText;

    located.card.back.text = server.backText;

    located.card.difficulty = server.difficulty;

    located.card.lastReviewedAt = server.lastReviewedAt;

    located.card.updatedAt = new Date().toISOString();

    await this.state.replaceStateFromSync(state, (currentMeta) => {
      const currentRecord = this.requireMatchingCardConflict(currentMeta, entityId, fingerprint);

      this.acceptServerSnapshot(currentRecord, server, conflict.serverRevision);
    });

    return {
      entityType: 'card',
      entityId,
      choice: 'cloud',

      serverRevision: conflict.serverRevision,

      pendingOperation: null,

      requiresPush: false,
    };
  }

  private async resolveDeckWithThisDevice(
    entityId: string,
    meta: StoredSyncMeta,
  ): Promise<ConflictResolutionResult> {
    const record = meta.decks[entityId];

    const conflict = this.requireActiveConflict('deck', entityId, record);

    const fingerprint = this.conflictFingerprint(conflict);

    const server = this.requireDeckSnapshot(conflict.server, 'server');

    const state = this.state.getState();

    const deck = state.decks.find((candidate) => candidate.id === entityId);

    if (!deck) {
      throw new Error(
        `Cannot choose This Device for deck "${entityId}" because the local deck is missing.`,
      );
    }

    const local = this.deckSnapshot(deck);

    const matchesServer = this.deckSnapshotsEqual(local, server);

    await this.state.replaceStateFromSync(state, (currentMeta) => {
      const currentRecord = this.requireMatchingDeckConflict(currentMeta, entityId, fingerprint);

      this.rebaseLocalSnapshot(currentRecord, server, conflict.serverRevision, matchesServer);
    });

    return {
      entityType: 'deck',
      entityId,
      choice: 'this-device',

      serverRevision: conflict.serverRevision,

      pendingOperation: matchesServer ? null : 'update',

      requiresPush: !matchesServer,
    };
  }

  private async resolveCardWithThisDevice(
    entityId: string,
    meta: StoredSyncMeta,
  ): Promise<ConflictResolutionResult> {
    const record = meta.cards[entityId];

    const conflict = this.requireActiveConflict('card', entityId, record);

    const fingerprint = this.conflictFingerprint(conflict);

    const server = this.requireCardSnapshot(conflict.server, 'server');

    const state = this.state.getState();

    const located = this.findCard(state, entityId);

    if (!located) {
      throw new Error(
        `Cannot choose This Device for card "${entityId}" because the local card is missing.`,
      );
    }

    if (server.deckId !== located.deck.id) {
      throw new Error('Cross-deck card conflict resolution is not supported yet.');
    }

    const local = this.cardSnapshot(located.deck.id, located.card);

    const matchesServer = this.cardSnapshotsEqual(local, server);

    await this.state.replaceStateFromSync(state, (currentMeta) => {
      const currentRecord = this.requireMatchingCardConflict(currentMeta, entityId, fingerprint);

      this.rebaseLocalSnapshot(currentRecord, server, conflict.serverRevision, matchesServer);
    });

    return {
      entityType: 'card',
      entityId,
      choice: 'this-device',

      serverRevision: conflict.serverRevision,

      pendingOperation: matchesServer ? null : 'update',

      requiresPush: !matchesServer,
    };
  }

  private requireActiveConflict<TSnapshot>(
    entityType: ConflictResolutionEntityType,
    entityId: string,
    record: EntitySyncRecord<TSnapshot> | undefined,
  ): SyncConflictRecord<TSnapshot> {
    if (!record?.conflict) {
      throw new Error(`No unresolved ${entityType} conflict exists for "${entityId}".`);
    }

    const conflict = record.conflict;

    /*
     * Delete-vs-active and active-vs-delete conflicts need
     * additional parent/child restoration semantics.
     *
     * We deliberately reject those for now instead of
     * silently losing descendants or resurrecting only part
     * of an entity tree.
     */
    if (conflict.localDeleted || conflict.serverDeleted) {
      throw new Error(
        `Delete conflict resolution for ${entityType} "${entityId}" is not implemented yet.`,
      );
    }

    if (!conflict.local || !conflict.server) {
      throw new Error(`Conflict "${entityId}" does not contain both active snapshots.`);
    }

    return conflict;
  }

  private acceptServerSnapshot<TSnapshot>(
    record: EntitySyncRecord<TSnapshot>,
    server: TSnapshot,
    serverRevision: number,
  ): void {
    record.revision = serverRevision;

    record.baseRevision = serverRevision;

    record.pendingOperation = null;

    record.lastSyncedSnapshot = this.clone(server);

    record.conflict = null;
  }

  private rebaseLocalSnapshot<TSnapshot>(
    record: EntitySyncRecord<TSnapshot>,
    server: TSnapshot,
    serverRevision: number,
    matchesServer: boolean,
  ): void {
    record.revision = serverRevision;

    record.baseRevision = serverRevision;

    record.lastSyncedSnapshot = this.clone(server);

    record.pendingOperation = matchesServer ? null : 'update';

    record.conflict = null;
  }

  private requireMatchingDeckConflict(
    meta: StoredSyncMeta,
    entityId: string,
    expected: ConflictFingerprint,
  ): EntitySyncRecord<DeckSyncSnapshot> {
    const record = meta.decks[entityId];

    this.assertConflictStillMatches('deck', entityId, record, expected);

    return record;
  }

  private requireMatchingCardConflict(
    meta: StoredSyncMeta,
    entityId: string,
    expected: ConflictFingerprint,
  ): EntitySyncRecord<CardSyncSnapshot> {
    const record = meta.cards[entityId];

    this.assertConflictStillMatches('card', entityId, record, expected);

    return record;
  }

  private assertConflictStillMatches<TSnapshot>(
    entityType: ConflictResolutionEntityType,
    entityId: string,
    record: EntitySyncRecord<TSnapshot> | undefined,
    expected: ConflictFingerprint,
  ): void {
    const conflict = record?.conflict;

    if (!conflict) {
      throw new Error(
        `${entityType} conflict "${entityId}" disappeared before resolution could be committed.`,
      );
    }

    if (
      conflict.detectedAt !== expected.detectedAt ||
      conflict.baseRevision !== expected.baseRevision ||
      conflict.serverRevision !== expected.serverRevision
    ) {
      throw new Error(
        `${entityType} conflict "${entityId}" changed before resolution could be committed.`,
      );
    }
  }

  private conflictFingerprint<TSnapshot>(
    conflict: SyncConflictRecord<TSnapshot>,
  ): ConflictFingerprint {
    return {
      detectedAt: conflict.detectedAt,

      baseRevision: conflict.baseRevision,

      serverRevision: conflict.serverRevision,
    };
  }

  private requireDeckSnapshot(snapshot: DeckSyncSnapshot | null, side: string): DeckSyncSnapshot {
    if (!snapshot) {
      throw new Error(`Deck conflict has no ${side} snapshot.`);
    }

    return this.clone(snapshot);
  }

  private requireCardSnapshot(snapshot: CardSyncSnapshot | null, side: string): CardSyncSnapshot {
    if (!snapshot) {
      throw new Error(`Card conflict has no ${side} snapshot.`);
    }

    return this.clone(snapshot);
  }

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

  private deckSnapshotsEqual(a: DeckSyncSnapshot, b: DeckSyncSnapshot): boolean {
    return a.id === b.id && a.name === b.name && (a.description ?? '') === (b.description ?? '');
  }

  private cardSnapshotsEqual(a: CardSyncSnapshot, b: CardSyncSnapshot): boolean {
    return (
      a.id === b.id &&
      a.deckId === b.deckId &&
      a.frontText === b.frontText &&
      a.backText === b.backText &&
      a.difficulty === b.difficulty &&
      a.lastReviewedAt === b.lastReviewedAt
    );
  }

  private findCard(
    state: FlashcardsState,
    cardId: string,
  ): {
    deck: Deck;
    card: Flashcard;
  } | null {
    for (const deck of state.decks) {
      const card = deck.cards.find((candidate) => candidate.id === cardId);

      if (card) {
        return {
          deck,
          card,
        };
      }
    }

    return null;
  }

  private clone<T>(value: T): T {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value)) as T;
    }
  }
}
