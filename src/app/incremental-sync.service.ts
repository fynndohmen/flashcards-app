// src/app/incremental-sync.service.ts

import { Injectable } from '@angular/core';

import { DifficultyLevel, FlashcardsState } from './models';

import { ApiCard, ApiCardImage, ApiDeck, PullResponse } from './sync-api.models';

import { SyncApiService } from './sync-api.service';

import { FlashcardsStateService } from './flashcards-state.service';

import {
  CardSyncSnapshot,
  DeckSyncSnapshot,
  EntitySyncRecord,
  ImageSyncSnapshot,
  StoredSyncMeta,
  SyncConflictRecord,
  SyncEntityType,
  SyncImageSide,
} from './sync-metadata.models';

import { SyncStorageService } from './sync-storage.service';

type LocalState = ReturnType<FlashcardsStateService['getState']>;

type LocalDeck = LocalState['decks'][number];

type LocalCard = LocalDeck['cards'][number];

type LocalImage = LocalCard['front']['images'][number];

interface CardLocation {
  deck: LocalDeck;

  card: LocalCard;

  cardIndex: number;
}

interface ImageLocation {
  deck: LocalDeck;

  card: LocalCard;

  side: SyncImageSide;

  image: LocalImage;

  imageIndex: number;
}

interface PullChangeCounts {
  decksAdded: number;
  decksUpdated: number;
  decksDeleted: number;

  cardsAdded: number;
  cardsUpdated: number;
  cardsDeleted: number;

  imagesAdded: number;
  imagesUpdated: number;
  imagesDeleted: number;

  tombstonesRecorded: number;

  conflictsCreated: number;
  conflictsUpdated: number;

  ignoredKnown: number;

  imageDownloads: number;
}

export interface IncrementalPullReport {
  requestSince: number;

  serverRevisionBefore: number;

  serverRevisionAfter: number;

  initialized: boolean;

  remote: {
    decks: number;
    cards: number;
    images: number;
  };

  changes: PullChangeCounts;

  changedLocalState: boolean;

  changedSyncMetadata: boolean;

  advancedCursor: boolean;

  pushedAnything: false;
}

@Injectable({
  providedIn: 'root',
})
export class IncrementalSyncService {
  constructor(
    private syncApi: SyncApiService,

    private syncStorage: SyncStorageService,

    private state: FlashcardsStateService,
  ) {}

  /**
   * Phase 1 of normal incremental synchronization.
   *
   * This method intentionally performs ONLY:
   *
   *   pull -> validate -> apply/conflict -> advance cursor
   *
   * It does NOT push local pending changes yet.
   *
   * Every remote change is either:
   *
   * - safely applied,
   * - safely recorded as a tombstone,
   * - captured as a conflict,
   * - or ignored because the client already knows it.
   *
   * State and metadata are committed atomically.
   */
  async pullAndApply(): Promise<IncrementalPullReport> {
    await this.state.whenReady();

    const auth = await this.syncStorage.getDeviceAuth();

    if (!auth?.token) {
      throw new Error('This device is not registered with the sync server.');
    }

    const initialMeta = await this.syncStorage.getSyncMeta();

    if (!initialMeta.initialized) {
      throw new Error('Incremental sync cannot run before bootstrap has completed.');
    }

    const initialState = this.state.getState();

    const since = initialMeta.serverRevision;

    const response = await this.syncApi.pull(since, auth.token);

    this.validatePullResponse(response, since);

    this.validateCascadeCoverage(response, initialState, initialMeta);

    const counts = this.emptyChangeCounts();

    if (
      response.server_revision === since &&
      response.decks.length === 0 &&
      response.cards.length === 0 &&
      response.images.length === 0
    ) {
      return {
        requestSince: since,

        serverRevisionBefore: since,

        serverRevisionAfter: since,

        initialized: true,

        remote: {
          decks: 0,

          cards: 0,

          images: 0,
        },

        changes: counts,

        changedLocalState: false,

        changedSyncMetadata: false,

        advancedCursor: false,

        pushedAnything: false,
      };
    }

    const nextState = this.clone(initialState);

    const nextMeta = this.clone(initialMeta);

    /*
     * Apply active parents first.
     *
     * That guarantees that a newly created card can attach
     * to a newly created deck from the same pull.
     */
    for (const deck of response.decks
      .filter((item) => !item.deleted_at)
      .sort((a, b) => a.revision - b.revision)) {
      this.applyActiveDeck(deck, nextState, nextMeta, counts);
    }

    for (const card of response.cards
      .filter((item) => !item.deleted_at)
      .sort((a, b) => a.revision - b.revision)) {
      this.applyActiveCard(card, nextState, nextMeta, counts);
    }

    /*
     * Active images may require bytes from the server.
     */
    for (const image of response.images
      .filter((item) => !item.deleted_at)
      .sort((a, b) => a.revision - b.revision)) {
      await this.applyActiveImage(image, nextState, nextMeta, counts, auth.token);
    }

    /*
     * Delete children before parents.
     *
     * This preserves enough local context to turn dirty
     * descendants into conflicts rather than silently
     * destroying them.
     */
    for (const image of response.images
      .filter((item) => !!item.deleted_at)
      .sort((a, b) => a.revision - b.revision)) {
      this.applyDeletedImage(image, nextState, nextMeta, counts);
    }

    for (const card of response.cards
      .filter((item) => !!item.deleted_at)
      .sort((a, b) => a.revision - b.revision)) {
      this.applyDeletedCard(card, nextState, nextMeta, counts);
    }

    for (const deck of response.decks
      .filter((item) => !!item.deleted_at)
      .sort((a, b) => a.revision - b.revision)) {
      this.applyDeletedDeck(deck, nextState, nextMeta, counts);
    }

    /*
     * It is safe to advance the global cursor even when
     * conflicts were found:
     *
     * the conflicting server version is preserved in the
     * conflict record and therefore does not need to be
     * pulled repeatedly.
     */
    nextMeta.serverRevision = response.server_revision;

    /*
     * Do NOT update lastSuccessfulSyncAt yet.
     *
     * This development phase only implements the pull half
     * of a full sync cycle. Once push is implemented, the
     * timestamp will represent a complete pull/push/pull.
     */
    const changedLocalState = !this.deepEqual(initialState, nextState);

    const changedSyncMetadata = !this.deepEqual(initialMeta, nextMeta);

    /*
     * Downloads can take time. Make sure the user did not
     * edit anything locally while this pull was running.
     */
    const currentState = this.state.getState();

    if (!this.deepEqual(currentState, initialState)) {
      throw new Error(
        'Local flashcard data changed while the incremental pull was running. No pulled state was committed.',
      );
    }

    if (changedLocalState || changedSyncMetadata) {
      await this.state.replaceStateFromSync(
        nextState,

        (meta) => {
          /*
           * Local mutations also modify sync metadata.
           * Refuse to overwrite any mutation that happened
           * after this pull started.
           */
          if (!this.deepEqual(meta, initialMeta)) {
            throw new Error(
              'Sync metadata changed while the incremental pull was running. No pulled state was committed.',
            );
          }

          meta.schemaVersion = nextMeta.schemaVersion;

          meta.initialized = nextMeta.initialized;

          meta.serverRevision = nextMeta.serverRevision;

          meta.lastSuccessfulSyncAt = nextMeta.lastSuccessfulSyncAt;

          meta.decks = this.clone(nextMeta.decks);

          meta.cards = this.clone(nextMeta.cards);

          meta.images = this.clone(nextMeta.images);
        },
      );
    }

    return {
      requestSince: since,

      serverRevisionBefore: since,

      serverRevisionAfter: response.server_revision,

      initialized: true,

      remote: {
        decks: response.decks.length,

        cards: response.cards.length,

        images: response.images.length,
      },

      changes: counts,

      changedLocalState,

      changedSyncMetadata,

      advancedCursor: response.server_revision !== since,

      pushedAnything: false,
    };
  }

  async pullAndApplyAndLog(): Promise<IncrementalPullReport> {
    const report = await this.pullAndApply();

    console.group('Flashcards incremental pull');

    console.log('PULL/APPLY ONLY — no local changes were pushed to the server.');

    console.log({
      requestSince: report.requestSince,

      serverRevisionBefore: report.serverRevisionBefore,

      serverRevisionAfter: report.serverRevisionAfter,

      initialized: report.initialized,

      remote: report.remote,

      changes: report.changes,

      changedLocalState: report.changedLocalState,

      changedSyncMetadata: report.changedSyncMetadata,

      advancedCursor: report.advancedCursor,

      pushedAnything: report.pushedAnything,
    });

    console.groupEnd();

    return report;
  }

  // -------------------------------------------------
  // Active decks
  // -------------------------------------------------

  private applyActiveDeck(
    remote: ApiDeck,

    state: LocalState,

    meta: StoredSyncMeta,

    counts: PullChangeCounts,
  ): void {
    const local = state.decks.find((deck) => deck.id === remote.id);

    const record = meta.decks[remote.id];

    const serverSnapshot = this.deckSnapshotFromRemote(remote);

    if (record?.conflict) {
      this.updateExistingConflict(record, remote.revision, serverSnapshot, false, counts);

      return;
    }

    if (record?.pendingOperation) {
      if (remote.revision > record.baseRevision) {
        this.createConflict(
          'deck',
          remote.id,
          record,
          local ? this.deckSnapshot(local) : null,
          serverSnapshot,
          !local,
          false,
          remote.revision,
        );

        counts.conflictsCreated += 1;
      } else {
        counts.ignoredKnown += 1;
      }

      return;
    }

    if (!record) {
      if (local) {
        const newRecord = this.createUntrackedRecord<DeckSyncSnapshot>();

        meta.decks[remote.id] = newRecord;

        this.createConflict(
          'deck',
          remote.id,
          newRecord,
          this.deckSnapshot(local),
          serverSnapshot,
          false,
          false,
          remote.revision,
        );

        counts.conflictsCreated += 1;

        return;
      }

      state.decks.push({
        id: remote.id,

        name: remote.name,

        description: remote.description?.trim() || undefined,

        cards: [],
      });

      meta.decks[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);

      counts.decksAdded += 1;

      return;
    }

    if (remote.revision <= record.revision) {
      counts.ignoredKnown += 1;

      return;
    }

    if (
      local &&
      record.lastSyncedSnapshot &&
      !this.deckSnapshotsEqual(this.deckSnapshot(local), record.lastSyncedSnapshot)
    ) {
      this.createConflict(
        'deck',
        remote.id,
        record,
        this.deckSnapshot(local),
        serverSnapshot,
        false,
        false,
        remote.revision,
      );

      counts.conflictsCreated += 1;

      return;
    }

    if (local) {
      local.name = remote.name;

      local.description = remote.description?.trim() || undefined;

      counts.decksUpdated += 1;
    } else {
      state.decks.push({
        id: remote.id,

        name: remote.name,

        description: remote.description?.trim() || undefined,

        cards: [],
      });

      counts.decksAdded += 1;
    }

    meta.decks[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);
  }

  // -------------------------------------------------
  // Active cards
  // -------------------------------------------------

  private applyActiveCard(
    remote: ApiCard,

    state: LocalState,

    meta: StoredSyncMeta,

    counts: PullChangeCounts,
  ): void {
    const targetDeck = state.decks.find((deck) => deck.id === remote.deck_id);

    if (!targetDeck) {
      throw new Error(
        `Remote card "${remote.id}" references deck "${remote.deck_id}", which is unavailable locally after applying deck changes.`,
      );
    }

    const location = this.findCard(state, remote.id);

    const local = location?.card;

    const record = meta.cards[remote.id];

    const serverSnapshot = this.cardSnapshotFromRemote(remote);

    if (record?.conflict) {
      this.updateExistingConflict(record, remote.revision, serverSnapshot, false, counts);

      return;
    }

    if (record?.pendingOperation) {
      if (remote.revision > record.baseRevision) {
        this.createConflict(
          'card',
          remote.id,
          record,
          location ? this.cardSnapshot(location.deck.id, location.card) : null,
          serverSnapshot,
          !location,
          false,
          remote.revision,
        );

        counts.conflictsCreated += 1;
      } else {
        counts.ignoredKnown += 1;
      }

      return;
    }

    if (!record) {
      if (location) {
        const newRecord = this.createUntrackedRecord<CardSyncSnapshot>();

        meta.cards[remote.id] = newRecord;

        this.createConflict(
          'card',
          remote.id,
          newRecord,
          this.cardSnapshot(location.deck.id, location.card),
          serverSnapshot,
          false,
          false,
          remote.revision,
        );

        counts.conflictsCreated += 1;

        return;
      }

      const card = this.createLocalCardFromRemote(remote);

      targetDeck.cards.push(card);

      meta.cards[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);

      counts.cardsAdded += 1;

      return;
    }

    if (remote.revision <= record.revision) {
      counts.ignoredKnown += 1;

      return;
    }

    if (
      location &&
      record.lastSyncedSnapshot &&
      !this.cardSnapshotsEqual(
        this.cardSnapshot(location.deck.id, location.card),
        record.lastSyncedSnapshot,
      )
    ) {
      this.createConflict(
        'card',
        remote.id,
        record,
        this.cardSnapshot(location.deck.id, location.card),
        serverSnapshot,
        false,
        false,
        remote.revision,
      );

      counts.conflictsCreated += 1;

      return;
    }

    if (location) {
      const imagesFront = location.card.front.images;

      const imagesBack = location.card.back.images;

      location.card.front = {
        text: remote.front_text,

        images: imagesFront,
      };

      location.card.back = {
        text: remote.back_text,

        images: imagesBack,
      };

      location.card.difficulty = remote.difficulty as DifficultyLevel;

      location.card.createdAt = remote.created_at;

      location.card.updatedAt = remote.updated_at;

      location.card.lastReviewedAt = remote.last_reviewed_at ?? null;

      if (location.deck.id !== remote.deck_id) {
        location.deck.cards.splice(location.cardIndex, 1);

        targetDeck.cards.push(location.card);
      }

      counts.cardsUpdated += 1;
    } else {
      targetDeck.cards.push(this.createLocalCardFromRemote(remote));

      counts.cardsAdded += 1;
    }

    meta.cards[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);
  }

  // -------------------------------------------------
  // Active images
  // -------------------------------------------------

  private async applyActiveImage(
    remote: ApiCardImage,

    state: LocalState,

    meta: StoredSyncMeta,

    counts: PullChangeCounts,

    token: string,
  ): Promise<void> {
    const targetCard = this.findCard(state, remote.card_id);

    if (!targetCard) {
      throw new Error(
        `Remote image "${remote.id}" references card "${remote.card_id}", which is unavailable locally after applying card changes.`,
      );
    }

    const location = this.findImage(state, remote.id);

    const record = meta.images[remote.id];

    const serverSnapshot = this.imageSnapshotFromRemote(remote);

    if (record?.conflict) {
      this.updateExistingConflict(record, remote.revision, serverSnapshot, false, counts);

      return;
    }

    if (record?.pendingOperation) {
      if (remote.revision > record.baseRevision) {
        this.createConflict(
          'image',
          remote.id,
          record,
          location ? this.imageSnapshot(location) : null,
          serverSnapshot,
          !location,
          false,
          remote.revision,
        );

        counts.conflictsCreated += 1;
      } else {
        counts.ignoredKnown += 1;
      }

      return;
    }

    if (!record) {
      if (location) {
        const newRecord = this.createUntrackedRecord<ImageSyncSnapshot>();

        meta.images[remote.id] = newRecord;

        this.createConflict(
          'image',
          remote.id,
          newRecord,
          this.imageSnapshot(location),
          serverSnapshot,
          false,
          false,
          remote.revision,
        );

        counts.conflictsCreated += 1;

        return;
      }

      const dataUrl = await this.downloadImage(remote, token);

      counts.imageDownloads += 1;

      this.insertImage(state, remote, {
        id: remote.id,

        dataUrl,
      });

      meta.images[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);

      counts.imagesAdded += 1;

      return;
    }

    if (remote.revision <= record.revision) {
      counts.ignoredKnown += 1;

      return;
    }

    if (
      location &&
      record.lastSyncedSnapshot &&
      !this.imageSnapshotsEqual(this.imageSnapshot(location), record.lastSyncedSnapshot)
    ) {
      this.createConflict(
        'image',
        remote.id,
        record,
        this.imageSnapshot(location),
        serverSnapshot,
        false,
        false,
        remote.revision,
      );

      counts.conflictsCreated += 1;

      return;
    }

    let image: LocalImage;

    if (location) {
      await this.verifyLocalImageBytes(location.image, remote);

      image = location.image;

      this.removeImageById(state, remote.id);

      counts.imagesUpdated += 1;
    } else {
      const dataUrl = await this.downloadImage(remote, token);

      counts.imageDownloads += 1;

      image = {
        id: remote.id,

        dataUrl,
      };

      counts.imagesAdded += 1;
    }

    this.insertImage(state, remote, image);

    meta.images[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);
  }

  // -------------------------------------------------
  // Deleted images
  // -------------------------------------------------

  private applyDeletedImage(
    remote: ApiCardImage,

    state: LocalState,

    meta: StoredSyncMeta,

    counts: PullChangeCounts,
  ): void {
    const location = this.findImage(state, remote.id);

    const record = meta.images[remote.id];

    const serverSnapshot = this.imageSnapshotFromRemote(remote);

    if (record?.conflict) {
      this.updateExistingConflict(record, remote.revision, null, true, counts);

      return;
    }

    if (record?.pendingOperation) {
      if (remote.revision > record.baseRevision) {
        this.createConflict(
          'image',
          remote.id,
          record,
          location ? this.imageSnapshot(location) : null,
          null,
          !location,
          true,
          remote.revision,
        );

        counts.conflictsCreated += 1;
      } else {
        counts.ignoredKnown += 1;
      }

      return;
    }

    if (!record) {
      if (location) {
        const newRecord = this.createUntrackedRecord<ImageSyncSnapshot>();

        meta.images[remote.id] = newRecord;

        this.createConflict(
          'image',
          remote.id,
          newRecord,
          this.imageSnapshot(location),
          null,
          false,
          true,
          remote.revision,
        );

        counts.conflictsCreated += 1;

        return;
      }

      meta.images[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);

      counts.tombstonesRecorded += 1;

      return;
    }

    if (remote.revision <= record.revision) {
      counts.ignoredKnown += 1;

      return;
    }

    if (
      location &&
      record.lastSyncedSnapshot &&
      !this.imageSnapshotsEqual(this.imageSnapshot(location), record.lastSyncedSnapshot)
    ) {
      this.createConflict(
        'image',
        remote.id,
        record,
        this.imageSnapshot(location),
        null,
        false,
        true,
        remote.revision,
      );

      counts.conflictsCreated += 1;

      return;
    }

    if (location) {
      this.removeImageById(state, remote.id);

      counts.imagesDeleted += 1;
    } else {
      counts.tombstonesRecorded += 1;
    }

    meta.images[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);
  }

  // -------------------------------------------------
  // Deleted cards
  // -------------------------------------------------

  private applyDeletedCard(
    remote: ApiCard,

    state: LocalState,

    meta: StoredSyncMeta,

    counts: PullChangeCounts,
  ): void {
    const location = this.findCard(state, remote.id);

    const record = meta.cards[remote.id];

    const serverSnapshot = this.cardSnapshotFromRemote(remote);

    if (record?.conflict) {
      this.updateExistingConflict(record, remote.revision, null, true, counts);

      return;
    }

    if (record?.pendingOperation) {
      if (remote.revision > record.baseRevision) {
        this.createConflict(
          'card',
          remote.id,
          record,
          location ? this.cardSnapshot(location.deck.id, location.card) : null,
          null,
          !location,
          true,
          remote.revision,
        );

        counts.conflictsCreated += 1;
      } else {
        counts.ignoredKnown += 1;
      }

      return;
    }

    if (!record) {
      if (location) {
        const newRecord = this.createUntrackedRecord<CardSyncSnapshot>();

        meta.cards[remote.id] = newRecord;

        this.createConflict(
          'card',
          remote.id,
          newRecord,
          this.cardSnapshot(location.deck.id, location.card),
          null,
          false,
          true,
          remote.revision,
        );

        counts.conflictsCreated += 1;

        return;
      }

      meta.cards[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);

      counts.tombstonesRecorded += 1;

      return;
    }

    if (remote.revision <= record.revision) {
      counts.ignoredKnown += 1;

      return;
    }

    if (location && this.cardHasDirtyImages(location.card, meta)) {
      this.createConflict(
        'card',
        remote.id,
        record,
        this.cardSnapshot(location.deck.id, location.card),
        null,
        false,
        true,
        remote.revision,
      );

      counts.conflictsCreated += 1;

      return;
    }

    if (
      location &&
      record.lastSyncedSnapshot &&
      !this.cardSnapshotsEqual(
        this.cardSnapshot(location.deck.id, location.card),
        record.lastSyncedSnapshot,
      )
    ) {
      this.createConflict(
        'card',
        remote.id,
        record,
        this.cardSnapshot(location.deck.id, location.card),
        null,
        false,
        true,
        remote.revision,
      );

      counts.conflictsCreated += 1;

      return;
    }

    if (location) {
      location.deck.cards.splice(location.cardIndex, 1);

      counts.cardsDeleted += 1;
    } else {
      counts.tombstonesRecorded += 1;
    }

    meta.cards[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);
  }

  // -------------------------------------------------
  // Deleted decks
  // -------------------------------------------------

  private applyDeletedDeck(
    remote: ApiDeck,

    state: LocalState,

    meta: StoredSyncMeta,

    counts: PullChangeCounts,
  ): void {
    const deckIndex = state.decks.findIndex((deck) => deck.id === remote.id);

    const local = deckIndex >= 0 ? state.decks[deckIndex] : undefined;

    const record = meta.decks[remote.id];

    const serverSnapshot = this.deckSnapshotFromRemote(remote);

    if (record?.conflict) {
      this.updateExistingConflict(record, remote.revision, null, true, counts);

      return;
    }

    if (record?.pendingOperation) {
      if (remote.revision > record.baseRevision) {
        this.createConflict(
          'deck',
          remote.id,
          record,
          local ? this.deckSnapshot(local) : null,
          null,
          !local,
          true,
          remote.revision,
        );

        counts.conflictsCreated += 1;
      } else {
        counts.ignoredKnown += 1;
      }

      return;
    }

    if (!record) {
      if (local) {
        const newRecord = this.createUntrackedRecord<DeckSyncSnapshot>();

        meta.decks[remote.id] = newRecord;

        this.createConflict(
          'deck',
          remote.id,
          newRecord,
          this.deckSnapshot(local),
          null,
          false,
          true,
          remote.revision,
        );

        counts.conflictsCreated += 1;

        return;
      }

      meta.decks[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);

      counts.tombstonesRecorded += 1;

      return;
    }

    if (remote.revision <= record.revision) {
      counts.ignoredKnown += 1;

      return;
    }

    if (local && this.deckHasDirtyDescendants(local, meta)) {
      this.createConflict(
        'deck',
        remote.id,
        record,
        this.deckSnapshot(local),
        null,
        false,
        true,
        remote.revision,
      );

      counts.conflictsCreated += 1;

      return;
    }

    if (
      local &&
      record.lastSyncedSnapshot &&
      !this.deckSnapshotsEqual(this.deckSnapshot(local), record.lastSyncedSnapshot)
    ) {
      this.createConflict(
        'deck',
        remote.id,
        record,
        this.deckSnapshot(local),
        null,
        false,
        true,
        remote.revision,
      );

      counts.conflictsCreated += 1;

      return;
    }

    if (deckIndex >= 0) {
      state.decks.splice(deckIndex, 1);

      counts.decksDeleted += 1;
    } else {
      counts.tombstonesRecorded += 1;
    }

    meta.decks[remote.id] = this.cleanRecord(remote.revision, serverSnapshot);
  }

  // -------------------------------------------------
  // Conflict helpers
  // -------------------------------------------------

  private createConflict<TSnapshot>(
    entityType: SyncEntityType,

    entityId: string,

    record: EntitySyncRecord<TSnapshot>,

    local: TSnapshot | null,

    server: TSnapshot | null,

    localDeleted: boolean,

    serverDeleted: boolean,

    serverRevision: number,
  ): void {
    const conflict: SyncConflictRecord<TSnapshot> = {
      entityType,

      entityId,

      detectedAt: new Date().toISOString(),

      baseRevision: record.baseRevision,

      serverRevision,

      base: record.lastSyncedSnapshot ? this.clone(record.lastSyncedSnapshot) : null,

      local: local ? this.clone(local) : null,

      server: server ? this.clone(server) : null,

      localDeleted,

      serverDeleted,
    };

    record.conflict = conflict;
  }

  private updateExistingConflict<TSnapshot>(
    record: EntitySyncRecord<TSnapshot>,

    remoteRevision: number,

    serverSnapshot: TSnapshot | null,

    serverDeleted: boolean,

    counts: PullChangeCounts,
  ): void {
    if (!record.conflict) {
      return;
    }

    if (remoteRevision <= record.conflict.serverRevision) {
      counts.ignoredKnown += 1;

      return;
    }

    record.conflict.serverRevision = remoteRevision;

    record.conflict.server = serverSnapshot ? this.clone(serverSnapshot) : null;

    record.conflict.serverDeleted = serverDeleted;

    counts.conflictsUpdated += 1;
  }

  private createUntrackedRecord<TSnapshot>(): EntitySyncRecord<TSnapshot> {
    return {
      revision: 0,

      baseRevision: 0,

      pendingOperation: 'create',

      lastSyncedSnapshot: null,

      conflict: null,
    };
  }

  private cleanRecord<TSnapshot>(
    revision: number,

    snapshot: TSnapshot,
  ): EntitySyncRecord<TSnapshot> {
    return {
      revision,

      baseRevision: revision,

      pendingOperation: null,

      lastSyncedSnapshot: this.clone(snapshot),

      conflict: null,
    };
  }

  // -------------------------------------------------
  // Dirty descendant protection
  // -------------------------------------------------

  private cardHasDirtyImages(
    card: LocalCard,

    meta: StoredSyncMeta,
  ): boolean {
    for (const image of card.front.images) {
      if (this.recordIsDirty(meta.images[image.id])) {
        return true;
      }
    }

    for (const image of card.back.images) {
      if (this.recordIsDirty(meta.images[image.id])) {
        return true;
      }
    }

    return false;
  }

  private deckHasDirtyDescendants(
    deck: LocalDeck,

    meta: StoredSyncMeta,
  ): boolean {
    for (const card of deck.cards) {
      if (this.recordIsDirty(meta.cards[card.id])) {
        return true;
      }

      if (this.cardHasDirtyImages(card, meta)) {
        return true;
      }
    }

    return false;
  }

  private recordIsDirty<TSnapshot>(record: EntitySyncRecord<TSnapshot> | undefined): boolean {
    return !!(record && (record.pendingOperation !== null || record.conflict !== null));
  }

  // -------------------------------------------------
  // Cascade validation
  // -------------------------------------------------

  private validateCascadeCoverage(
    response: PullResponse,

    state: LocalState,

    meta: StoredSyncMeta,
  ): void {
    const deletedCardIds = new Set(
      response.cards.filter((card) => !!card.deleted_at).map((card) => card.id),
    );

    const deletedImageIds = new Set(
      response.images.filter((image) => !!image.deleted_at).map((image) => image.id),
    );

    for (const remoteCard of response.cards.filter((card) => !!card.deleted_at)) {
      const location = this.findCard(state, remoteCard.id);

      if (!location) {
        continue;
      }

      for (const image of [...location.card.front.images, ...location.card.back.images]) {
        const record = meta.images[image.id];

        if (record?.pendingOperation === 'create') {
          continue;
        }

        if (record && record.revision > 0 && !deletedImageIds.has(image.id)) {
          throw new Error(
            `Server deleted card "${remoteCard.id}", but server-known image "${image.id}" has no tombstone in the same pull.`,
          );
        }
      }
    }

    for (const remoteDeck of response.decks.filter((deck) => !!deck.deleted_at)) {
      const deck = state.decks.find((candidate) => candidate.id === remoteDeck.id);

      if (!deck) {
        continue;
      }

      for (const card of deck.cards) {
        const cardRecord = meta.cards[card.id];

        if (cardRecord?.pendingOperation === 'create') {
          continue;
        }

        if (cardRecord && cardRecord.revision > 0 && !deletedCardIds.has(card.id)) {
          throw new Error(
            `Server deleted deck "${remoteDeck.id}", but server-known card "${card.id}" has no tombstone in the same pull.`,
          );
        }
      }
    }

    const deletedDeckIds = new Set(
      response.decks.filter((deck) => !!deck.deleted_at).map((deck) => deck.id),
    );

    const activeCards = response.cards.filter((card) => !card.deleted_at);

    for (const card of activeCards) {
      if (deletedDeckIds.has(card.deck_id)) {
        throw new Error(
          `Pull contains active card "${card.id}" below deleted deck "${card.deck_id}".`,
        );
      }
    }

    const activeImages = response.images.filter((image) => !image.deleted_at);

    for (const image of activeImages) {
      if (deletedCardIds.has(image.card_id)) {
        throw new Error(
          `Pull contains active image "${image.id}" below deleted card "${image.card_id}".`,
        );
      }
    }
  }

  // -------------------------------------------------
  // Local graph helpers
  // -------------------------------------------------

  private findCard(
    state: LocalState,

    cardId: string,
  ): CardLocation | null {
    for (const deck of state.decks) {
      const cardIndex = deck.cards.findIndex((card) => card.id === cardId);

      if (cardIndex >= 0) {
        return {
          deck,

          card: deck.cards[cardIndex],

          cardIndex,
        };
      }
    }

    return null;
  }

  private findImage(
    state: LocalState,

    imageId: string,
  ): ImageLocation | null {
    for (const deck of state.decks) {
      for (const card of deck.cards) {
        const frontIndex = card.front.images.findIndex((image) => image.id === imageId);

        if (frontIndex >= 0) {
          return {
            deck,
            card,

            side: 'front',

            image: card.front.images[frontIndex],

            imageIndex: frontIndex,
          };
        }

        const backIndex = card.back.images.findIndex((image) => image.id === imageId);

        if (backIndex >= 0) {
          return {
            deck,
            card,

            side: 'back',

            image: card.back.images[backIndex],

            imageIndex: backIndex,
          };
        }
      }
    }

    return null;
  }

  private removeImageById(
    state: LocalState,

    imageId: string,
  ): LocalImage | null {
    const location = this.findImage(state, imageId);

    if (!location) {
      return null;
    }

    const array =
      location.side === 'front' ? location.card.front.images : location.card.back.images;

    const [removed] = array.splice(location.imageIndex, 1);

    return removed ?? null;
  }

  private insertImage(
    state: LocalState,

    remote: ApiCardImage,

    image: LocalImage,
  ): void {
    const location = this.findCard(state, remote.card_id);

    if (!location) {
      throw new Error(
        `Cannot insert remote image "${remote.id}" because card "${remote.card_id}" does not exist.`,
      );
    }

    const array = remote.side === 'front' ? location.card.front.images : location.card.back.images;

    if (remote.position > array.length) {
      throw new Error(
        `Remote image "${remote.id}" position ${remote.position} is beyond local side length ${array.length}.`,
      );
    }

    array.splice(remote.position, 0, image);
  }

  private createLocalCardFromRemote(remote: ApiCard): LocalCard {
    return {
      id: remote.id,

      front: {
        text: remote.front_text,

        images: [],
      },

      back: {
        text: remote.back_text,

        images: [],
      },

      difficulty: remote.difficulty as DifficultyLevel,

      createdAt: remote.created_at,

      updatedAt: remote.updated_at,

      lastReviewedAt: remote.last_reviewed_at ?? null,
    };
  }

  // -------------------------------------------------
  // Snapshot helpers
  // -------------------------------------------------

  private deckSnapshot(deck: LocalDeck): DeckSyncSnapshot {
    return {
      id: deck.id,

      name: deck.name,

      description: deck.description,
    };
  }

  private cardSnapshot(
    deckId: string,

    card: LocalCard,
  ): CardSyncSnapshot {
    return {
      id: card.id,

      deckId,

      frontText: card.front.text,

      backText: card.back.text,

      difficulty: card.difficulty,

      lastReviewedAt: card.lastReviewedAt,
    };
  }

  private imageSnapshot(location: ImageLocation): ImageSyncSnapshot {
    return {
      id: location.image.id,

      cardId: location.card.id,

      side: location.side,

      position: location.imageIndex,
    };
  }

  private deckSnapshotFromRemote(deck: ApiDeck): DeckSyncSnapshot {
    return {
      id: deck.id,

      name: deck.name,

      description: deck.description?.trim() || undefined,
    };
  }

  private cardSnapshotFromRemote(card: ApiCard): CardSyncSnapshot {
    return {
      id: card.id,

      deckId: card.deck_id,

      frontText: card.front_text,

      backText: card.back_text,

      difficulty: card.difficulty as DifficultyLevel,

      lastReviewedAt: card.last_reviewed_at ?? null,
    };
  }

  private imageSnapshotFromRemote(image: ApiCardImage): ImageSyncSnapshot {
    return {
      id: image.id,

      cardId: image.card_id,

      side: image.side,

      position: image.position,
    };
  }

  // -------------------------------------------------
  // Snapshot comparison
  // -------------------------------------------------

  private deckSnapshotsEqual(
    a: DeckSyncSnapshot,

    b: DeckSyncSnapshot,
  ): boolean {
    return (
      a.id === b.id &&
      a.name === b.name &&
      (a.description ?? undefined) === (b.description ?? undefined)
    );
  }

  private cardSnapshotsEqual(
    a: CardSyncSnapshot,

    b: CardSyncSnapshot,
  ): boolean {
    return (
      a.id === b.id &&
      a.deckId === b.deckId &&
      a.frontText === b.frontText &&
      a.backText === b.backText &&
      a.difficulty === b.difficulty &&
      this.timestampsEqual(a.lastReviewedAt, b.lastReviewedAt)
    );
  }

  private imageSnapshotsEqual(
    a: ImageSyncSnapshot,

    b: ImageSyncSnapshot,
  ): boolean {
    return a.id === b.id && a.cardId === b.cardId && a.side === b.side && a.position === b.position;
  }

  private timestampsEqual(
    a: string | null | undefined,

    b: string | null | undefined,
  ): boolean {
    const left = a ?? null;

    const right = b ?? null;

    if (left === null || right === null) {
      return left === right;
    }

    const leftTime = Date.parse(left);

    const rightTime = Date.parse(right);

    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return leftTime === rightTime;
    }

    return left === right;
  }

  // -------------------------------------------------
  // Image bytes
  // -------------------------------------------------

  private async downloadImage(
    remote: ApiCardImage,

    token: string,
  ): Promise<string> {
    this.validateRemoteImageMetadata(remote);

    const downloaded = await this.syncApi.downloadImage(remote.id, token);

    const expectedType = remote.mime_type!.toLowerCase();

    const actualType = downloaded.type.toLowerCase();

    if (actualType && actualType !== expectedType) {
      throw new Error(
        `Downloaded image "${remote.id}" MIME type "${actualType}" does not match server metadata "${expectedType}".`,
      );
    }

    const blob = actualType ? downloaded : downloaded.slice(0, downloaded.size, expectedType);

    const hash = await this.sha256Blob(blob);

    if (hash !== remote.sha256!.toLowerCase()) {
      throw new Error(`Downloaded image "${remote.id}" failed SHA-256 verification.`);
    }

    return this.blobToDataUrl(blob);
  }

  private async verifyLocalImageBytes(
    image: LocalImage,

    remote: ApiCardImage,
  ): Promise<void> {
    this.validateRemoteImageMetadata(remote);

    const blob = await this.dataUrlToBlob(image.dataUrl);

    const hash = await this.sha256Blob(blob);

    if (hash !== remote.sha256!.toLowerCase()) {
      throw new Error(
        `Local image "${remote.id}" bytes do not match the server SHA-256. Sync stopped instead of silently replacing image bytes.`,
      );
    }
  }

  private validateRemoteImageMetadata(image: ApiCardImage): void {
    const mime = image.mime_type?.toLowerCase();

    if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
      throw new Error(
        `Remote image "${image.id}" has unsupported MIME type "${image.mime_type ?? 'missing'}".`,
      );
    }

    if (!image.sha256 || !/^[0-9a-f]{64}$/i.test(image.sha256)) {
      throw new Error(`Remote image "${image.id}" has no valid SHA-256 digest.`);
    }
  }

  private async dataUrlToBlob(dataUrl: string): Promise<Blob> {
    const response = await fetch(dataUrl);

    if (!response.ok) {
      throw new Error('Could not decode local image data URL.');
    }

    return response.blob();
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onerror = () => {
        reject(reader.error ?? new Error('Could not convert downloaded image to a data URL.'));
      };

      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reject(new Error('Downloaded image conversion did not produce a data URL.'));

          return;
        }

        resolve(reader.result);
      };

      reader.readAsDataURL(blob);
    });
  }

  private async sha256Blob(blob: Blob): Promise<string> {
    if (!globalThis.crypto?.subtle) {
      throw new Error('Web Crypto SHA-256 is unavailable.');
    }

    const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());

    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  // -------------------------------------------------
  // Pull validation
  // -------------------------------------------------

  private validatePullResponse(
    response: PullResponse,

    expectedSince: number,
  ): void {
    if (response.since !== expectedSince) {
      throw new Error(`Sync server returned since=${response.since}, expected ${expectedSince}.`);
    }

    if (
      !Number.isSafeInteger(response.server_revision) ||
      response.server_revision < expectedSince
    ) {
      throw new Error(`Sync server returned invalid server revision ${response.server_revision}.`);
    }

    if (
      !Array.isArray(response.decks) ||
      !Array.isArray(response.cards) ||
      !Array.isArray(response.images)
    ) {
      throw new Error('Sync server returned an invalid pull payload.');
    }

    this.validateRemoteEntities('deck', response.decks, expectedSince, response.server_revision);

    this.validateRemoteEntities('card', response.cards, expectedSince, response.server_revision);

    this.validateRemoteEntities('image', response.images, expectedSince, response.server_revision);
  }

  private validateRemoteEntities(
    type: SyncEntityType,

    entities: Array<{
      id: string;
      revision: number;
    }>,

    since: number,

    serverRevision: number,
  ): void {
    const ids = new Set<string>();

    for (const entity of entities) {
      if (!entity.id || ids.has(entity.id)) {
        throw new Error(`Sync server returned duplicate or empty ${type} ID "${entity.id}".`);
      }

      ids.add(entity.id);

      if (
        !Number.isSafeInteger(entity.revision) ||
        entity.revision <= since ||
        entity.revision > serverRevision
      ) {
        throw new Error(
          `Sync server returned invalid ${type} revision ${entity.revision} for "${entity.id}".`,
        );
      }
    }
  }

  // -------------------------------------------------
  // Generic helpers
  // -------------------------------------------------

  private emptyChangeCounts(): PullChangeCounts {
    return {
      decksAdded: 0,

      decksUpdated: 0,

      decksDeleted: 0,

      cardsAdded: 0,

      cardsUpdated: 0,

      cardsDeleted: 0,

      imagesAdded: 0,

      imagesUpdated: 0,

      imagesDeleted: 0,

      tombstonesRecorded: 0,

      conflictsCreated: 0,

      conflictsUpdated: 0,

      ignoredKnown: 0,

      imageDownloads: 0,
    };
  }

  private deepEqual(
    a: unknown,

    b: unknown,
  ): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private clone<T>(value: T): T {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value)) as T;
    }
  }
}
