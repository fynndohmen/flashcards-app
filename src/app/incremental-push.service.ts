// src/app/incremental-push.service.ts

import { Injectable } from '@angular/core';

import { ApiCard, ApiCardImage, ApiDeck } from './sync-api.models';

import { SyncApiError, SyncApiService } from './sync-api.service';

import { FlashcardsStateService } from './flashcards-state.service';

import {
  CardSyncSnapshot,
  DeckSyncSnapshot,
  EntitySyncRecord,
  ImageSyncSnapshot,
  PendingSyncOperation,
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
}

interface ImageLocation {
  card: LocalCard;

  side: SyncImageSide;

  image: LocalImage;

  position: number;
}

interface PushCounts {
  requestsSent: number;

  decksApplied: number;

  cardsApplied: number;

  imagesApplied: number;

  conflictsCreated: number;

  existingConflictsSkipped: number;

  noLongerPendingSkipped: number;
}

export interface IncrementalPushReport {
  initialized: boolean;

  serverRevisionCursorBefore: number;

  serverRevisionCursorAfter: number;

  cursorAdvanced: false;

  pushedAnything: boolean;

  serverMayHaveAdvanced: boolean;

  counts: PushCounts;
}

@Injectable({
  providedIn: 'root',
})
export class IncrementalPushService {
  private activePush: Promise<IncrementalPushReport> | null = null;

  constructor(
    private syncApi: SyncApiService,

    private syncStorage: SyncStorageService,

    private state: FlashcardsStateService,
  ) {}

  /**
   * Push all currently pending local mutations.
   *
   * Important:
   *
   * - unresolved conflicts are NEVER pushed
   * - the global pull cursor is NEVER advanced here
   * - successful pushes update only entity metadata
   * - a later pull consumes the server revisions created here
   *
   * Dependency order:
   *
   * 1. deck creates / updates
   * 2. card creates / updates
   * 3. image creates
   * 4. image deletes
   * 5. card deletes
   * 6. deck deletes
   */
  async pushPending(): Promise<IncrementalPushReport> {
    if (this.activePush) {
      throw new Error('An incremental push is already running.');
    }

    const task = this.pushPendingInternal();

    this.activePush = task;

    try {
      return await task;
    } finally {
      this.activePush = null;
    }
  }

  async pushPendingAndLog(): Promise<IncrementalPushReport> {
    const report = await this.pushPending();

    console.group('Flashcards incremental push');

    console.log(
      'PUSH ONLY — global server cursor was not advanced. Run an incremental pull afterwards.',
    );

    console.log({
      initialized: report.initialized,

      serverRevisionCursorBefore: report.serverRevisionCursorBefore,

      serverRevisionCursorAfter: report.serverRevisionCursorAfter,

      cursorAdvanced: report.cursorAdvanced,

      pushedAnything: report.pushedAnything,

      serverMayHaveAdvanced: report.serverMayHaveAdvanced,

      counts: report.counts,
    });

    console.groupEnd();

    return report;
  }

  private async pushPendingInternal(): Promise<IncrementalPushReport> {
    await this.state.whenReady();

    const auth = await this.syncStorage.getDeviceAuth();

    if (!auth?.token) {
      throw new Error('This device is not registered with the sync server.');
    }

    const initialMeta = await this.syncStorage.getSyncMeta();

    if (!initialMeta.initialized) {
      throw new Error('Incremental push cannot run before bootstrap has completed.');
    }

    const cursorBefore = initialMeta.serverRevision;

    const counts = this.emptyPushCounts();

    /*
     * Parents must exist before children are created or
     * updated.
     */
    await this.pushDecks(['create', 'update'], auth.token, counts);

    await this.pushCards(['create', 'update'], auth.token, counts);

    await this.pushImageCreates(auth.token, counts);

    /*
     * Children are deleted before parents.
     */
    await this.pushImageDeletes(auth.token, counts);

    await this.pushCards(['delete'], auth.token, counts);

    await this.pushDecks(['delete'], auth.token, counts);

    const finalMeta = await this.syncStorage.getSyncMeta();

    if (finalMeta.serverRevision !== cursorBefore) {
      throw new Error(
        `Incremental push unexpectedly changed the global pull cursor from ${cursorBefore} to ${finalMeta.serverRevision}.`,
      );
    }

    const pushedAnything =
      counts.decksApplied > 0 || counts.cardsApplied > 0 || counts.imagesApplied > 0;

    return {
      initialized: finalMeta.initialized,

      serverRevisionCursorBefore: cursorBefore,

      serverRevisionCursorAfter: finalMeta.serverRevision,

      cursorAdvanced: false,

      pushedAnything,

      serverMayHaveAdvanced: pushedAnything || counts.conflictsCreated > 0,

      counts,
    };
  }

  // -------------------------------------------------
  // Decks
  // -------------------------------------------------

  private async pushDecks(
    operations: PendingSyncOperation[],

    token: string,

    counts: PushCounts,
  ): Promise<void> {
    const meta = await this.syncStorage.getSyncMeta();

    const ids = Object.keys(meta.decks);

    for (const id of ids) {
      const currentMeta = await this.syncStorage.getSyncMeta();

      const record = currentMeta.decks[id];

      if (!record) {
        continue;
      }

      if (record.conflict) {
        if (record.pendingOperation && operations.includes(record.pendingOperation)) {
          counts.existingConflictsSkipped += 1;
        }

        continue;
      }

      if (!record.pendingOperation || !operations.includes(record.pendingOperation)) {
        continue;
      }

      await this.pushDeck(id, record.pendingOperation, record, token, counts);
    }
  }

  private async pushDeck(
    deckId: string,

    operation: PendingSyncOperation,

    record: EntitySyncRecord<DeckSyncSnapshot>,

    token: string,

    counts: PushCounts,
  ): Promise<void> {
    const state = this.state.getState();

    const local = state.decks.find((deck) => deck.id === deckId);

    let snapshot: DeckSyncSnapshot;

    if (operation === 'delete') {
      if (!record.lastSyncedSnapshot) {
        throw new Error(`Deck "${deckId}" is pending delete but has no last synced snapshot.`);
      }

      snapshot = this.clone(record.lastSyncedSnapshot);
    } else {
      if (!local) {
        throw new Error(`Deck "${deckId}" is pending ${operation} but is missing locally.`);
      }

      snapshot = this.deckSnapshot(local);
    }

    const baseRevision = record.baseRevision;

    counts.requestsSent += 1;

    const response = await this.syncApi.pushDeck(
      {
        operation,

        base_revision: baseRevision,

        deck: {
          id: snapshot.id,

          name: snapshot.name,

          ...(snapshot.description
            ? {
                description: snapshot.description,
              }
            : {}),
        },
      },

      token,
    );

    if (response.status === 'conflict') {
      const remote = response.conflict?.server;

      if (!remote) {
        throw new Error(`Deck push conflict for "${deckId}" did not include the server deck.`);
      }

      await this.recordDeckConflict(deckId, baseRevision, remote);

      counts.conflictsCreated += 1;

      return;
    }

    if (!response.deck) {
      throw new Error(`Applied deck push for "${deckId}" did not return a deck.`);
    }

    const remote = response.deck;

    if (remote.id !== deckId) {
      throw new Error(`Deck push returned unexpected ID "${remote.id}" for "${deckId}".`);
    }

    if (operation === 'delete') {
      if (!remote.deleted_at) {
        throw new Error(
          `Deck "${deckId}" delete was reported as applied but the returned deck is active.`,
        );
      }
    } else {
      if (remote.deleted_at) {
        throw new Error(`Deck "${deckId}" ${operation} returned a deleted server deck.`);
      }

      const remoteSnapshot = this.deckSnapshotFromRemote(remote);

      if (!this.deckSnapshotsEqual(remoteSnapshot, snapshot)) {
        throw new Error(`Server deck "${deckId}" does not match the pushed local snapshot.`);
      }
    }

    await this.acknowledgeAppliedDeck(deckId, operation, baseRevision, snapshot, remote);

    counts.decksApplied += 1;
  }

  private async acknowledgeAppliedDeck(
    deckId: string,

    operation: PendingSyncOperation,

    baseRevision: number,

    sentSnapshot: DeckSyncSnapshot,

    remote: ApiDeck,
  ): Promise<void> {
    const stateNow = this.state.getState();

    const currentDeck = stateNow.decks.find((deck) => deck.id === deckId);

    const currentSnapshot = currentDeck ? this.deckSnapshot(currentDeck) : null;

    await this.syncStorage.updateSyncMeta((meta) => {
      const record = meta.decks[deckId];

      if (!record) {
        /*
         * A local delete can remove metadata for a
         * still-unacknowledged create. The server now
         * knows that deck, so recreate metadata as a
         * pending delete.
         */
        if (!currentSnapshot && operation === 'create') {
          meta.decks[deckId] = {
            revision: remote.revision,

            baseRevision: remote.revision,

            pendingOperation: 'delete',

            lastSyncedSnapshot: this.clone(sentSnapshot),

            conflict: null,
          };

          return;
        }

        throw new Error(`Deck metadata for "${deckId}" disappeared while its push was running.`);
      }

      if (record.conflict) {
        throw new Error(`Deck "${deckId}" acquired a conflict while its push was running.`);
      }

      if (record.baseRevision !== baseRevision) {
        throw new Error(`Deck "${deckId}" base revision changed while its push was running.`);
      }

      record.revision = remote.revision;

      record.lastSyncedSnapshot = this.clone(sentSnapshot);

      record.conflict = null;

      if (operation === 'delete') {
        record.baseRevision = remote.revision;

        record.pendingOperation = null;

        return;
      }

      if (!currentSnapshot) {
        record.baseRevision = remote.revision;

        record.pendingOperation = 'delete';

        return;
      }

      if (this.deckSnapshotsEqual(currentSnapshot, sentSnapshot)) {
        record.baseRevision = remote.revision;

        record.pendingOperation = null;

        return;
      }

      /*
       * The user edited this deck again while the
       * request was in flight. The pushed version is
       * now the new clean ancestor; the newer local
       * edit remains pending.
       */
      record.baseRevision = remote.revision;

      record.pendingOperation = 'update';
    });
  }

  private async recordDeckConflict(
    deckId: string,

    requestBaseRevision: number,

    remote: ApiDeck,
  ): Promise<void> {
    const localDeck = this.state.getState().decks.find((deck) => deck.id === deckId);

    await this.syncStorage.updateSyncMeta((meta) => {
      const record = meta.decks[deckId];

      if (!record) {
        throw new Error(
          `Cannot store deck conflict for "${deckId}" because its metadata is missing.`,
        );
      }

      if (record.conflict) {
        return;
      }

      const conflict: SyncConflictRecord<DeckSyncSnapshot> = {
        entityType: 'deck',

        entityId: deckId,

        detectedAt: new Date().toISOString(),

        baseRevision: requestBaseRevision,

        serverRevision: remote.revision,

        base: record.lastSyncedSnapshot ? this.clone(record.lastSyncedSnapshot) : null,

        local: localDeck ? this.deckSnapshot(localDeck) : null,

        server: remote.deleted_at ? null : this.deckSnapshotFromRemote(remote),

        localDeleted: !localDeck,

        serverDeleted: !!remote.deleted_at,
      };

      record.conflict = conflict;
    });
  }

  // -------------------------------------------------
  // Cards
  // -------------------------------------------------

  private async pushCards(
    operations: PendingSyncOperation[],

    token: string,

    counts: PushCounts,
  ): Promise<void> {
    const meta = await this.syncStorage.getSyncMeta();

    const ids = Object.keys(meta.cards);

    for (const id of ids) {
      const currentMeta = await this.syncStorage.getSyncMeta();

      const record = currentMeta.cards[id];

      if (!record) {
        continue;
      }

      if (record.conflict) {
        if (record.pendingOperation && operations.includes(record.pendingOperation)) {
          counts.existingConflictsSkipped += 1;
        }

        continue;
      }

      if (!record.pendingOperation || !operations.includes(record.pendingOperation)) {
        continue;
      }

      await this.pushCard(id, record.pendingOperation, record, token, counts);
    }
  }

  private async pushCard(
    cardId: string,

    operation: PendingSyncOperation,

    record: EntitySyncRecord<CardSyncSnapshot>,

    token: string,

    counts: PushCounts,
  ): Promise<void> {
    const state = this.state.getState();

    const location = this.findCard(state, cardId);

    let snapshot: CardSyncSnapshot;

    if (operation === 'delete') {
      if (!record.lastSyncedSnapshot) {
        throw new Error(`Card "${cardId}" is pending delete but has no last synced snapshot.`);
      }

      snapshot = this.clone(record.lastSyncedSnapshot);
    } else {
      if (!location) {
        throw new Error(`Card "${cardId}" is pending ${operation} but is missing locally.`);
      }

      snapshot = this.cardSnapshot(location.deck.id, location.card);
    }

    const baseRevision = record.baseRevision;

    counts.requestsSent += 1;

    const response = await this.syncApi.pushCard(
      {
        operation,

        base_revision: baseRevision,

        card: {
          id: snapshot.id,

          deck_id: snapshot.deckId,

          front_text: snapshot.frontText,

          back_text: snapshot.backText,

          difficulty: snapshot.difficulty,

          ...(snapshot.lastReviewedAt
            ? {
                last_reviewed_at: snapshot.lastReviewedAt,
              }
            : {}),
        },
      },

      token,
    );

    if (response.status === 'conflict') {
      const remote = response.conflict?.server;

      if (!remote) {
        throw new Error(`Card push conflict for "${cardId}" did not include the server card.`);
      }

      await this.recordCardConflict(cardId, baseRevision, remote);

      counts.conflictsCreated += 1;

      return;
    }

    if (!response.card) {
      throw new Error(`Applied card push for "${cardId}" did not return a card.`);
    }

    const remote = response.card;

    if (remote.id !== cardId) {
      throw new Error(`Card push returned unexpected ID "${remote.id}" for "${cardId}".`);
    }

    if (operation === 'delete') {
      if (!remote.deleted_at) {
        throw new Error(
          `Card "${cardId}" delete was reported as applied but the returned card is active.`,
        );
      }
    } else {
      if (remote.deleted_at) {
        throw new Error(`Card "${cardId}" ${operation} returned a deleted server card.`);
      }

      const remoteSnapshot = this.cardSnapshotFromRemote(remote);

      if (!this.cardSnapshotsEqual(remoteSnapshot, snapshot)) {
        throw new Error(`Server card "${cardId}" does not match the pushed local snapshot.`);
      }
    }

    await this.acknowledgeAppliedCard(cardId, operation, baseRevision, snapshot, remote);

    counts.cardsApplied += 1;
  }

  private async acknowledgeAppliedCard(
    cardId: string,

    operation: PendingSyncOperation,

    baseRevision: number,

    sentSnapshot: CardSyncSnapshot,

    remote: ApiCard,
  ): Promise<void> {
    const stateNow = this.state.getState();

    const currentLocation = this.findCard(stateNow, cardId);

    const currentSnapshot = currentLocation
      ? this.cardSnapshot(currentLocation.deck.id, currentLocation.card)
      : null;

    await this.syncStorage.updateSyncMeta((meta) => {
      const record = meta.cards[cardId];

      if (!record) {
        if (!currentSnapshot && operation === 'create') {
          meta.cards[cardId] = {
            revision: remote.revision,

            baseRevision: remote.revision,

            pendingOperation: 'delete',

            lastSyncedSnapshot: this.clone(sentSnapshot),

            conflict: null,
          };

          return;
        }

        throw new Error(`Card metadata for "${cardId}" disappeared while its push was running.`);
      }

      if (record.conflict) {
        throw new Error(`Card "${cardId}" acquired a conflict while its push was running.`);
      }

      if (record.baseRevision !== baseRevision) {
        throw new Error(`Card "${cardId}" base revision changed while its push was running.`);
      }

      record.revision = remote.revision;

      record.lastSyncedSnapshot = this.clone(sentSnapshot);

      record.conflict = null;

      if (operation === 'delete') {
        record.baseRevision = remote.revision;

        record.pendingOperation = null;

        return;
      }

      if (!currentSnapshot) {
        record.baseRevision = remote.revision;

        record.pendingOperation = 'delete';

        return;
      }

      if (this.cardSnapshotsEqual(currentSnapshot, sentSnapshot)) {
        record.baseRevision = remote.revision;

        record.pendingOperation = null;

        return;
      }

      record.baseRevision = remote.revision;

      record.pendingOperation = 'update';
    });
  }

  private async recordCardConflict(
    cardId: string,

    requestBaseRevision: number,

    remote: ApiCard,
  ): Promise<void> {
    const location = this.findCard(this.state.getState(), cardId);

    await this.syncStorage.updateSyncMeta((meta) => {
      const record = meta.cards[cardId];

      if (!record) {
        throw new Error(
          `Cannot store card conflict for "${cardId}" because its metadata is missing.`,
        );
      }

      if (record.conflict) {
        return;
      }

      record.conflict = {
        entityType: 'card',

        entityId: cardId,

        detectedAt: new Date().toISOString(),

        baseRevision: requestBaseRevision,

        serverRevision: remote.revision,

        base: record.lastSyncedSnapshot ? this.clone(record.lastSyncedSnapshot) : null,

        local: location ? this.cardSnapshot(location.deck.id, location.card) : null,

        server: remote.deleted_at ? null : this.cardSnapshotFromRemote(remote),

        localDeleted: !location,

        serverDeleted: !!remote.deleted_at,
      };
    });
  }

  // -------------------------------------------------
  // Image creates
  // -------------------------------------------------

  private async pushImageCreates(
    token: string,

    counts: PushCounts,
  ): Promise<void> {
    const meta = await this.syncStorage.getSyncMeta();

    const ids = Object.keys(meta.images);

    for (const imageId of ids) {
      const currentMeta = await this.syncStorage.getSyncMeta();

      const record = currentMeta.images[imageId];

      if (!record) {
        continue;
      }

      if (record.conflict) {
        if (record.pendingOperation === 'create') {
          counts.existingConflictsSkipped += 1;
        }

        continue;
      }

      if (record.pendingOperation !== 'create') {
        continue;
      }

      const location = this.findImage(this.state.getState(), imageId);

      if (!location) {
        /*
         * A pending create that disappeared locally should
         * normally have had its metadata removed by the
         * state service.
         */
        counts.noLongerPendingSkipped += 1;

        continue;
      }

      const snapshot = this.imageSnapshot(location);

      const blob = await this.dataUrlToBlob(location.image.dataUrl);

      if (!this.isSupportedImageMimeType(blob.type)) {
        throw new Error(
          `Local image "${imageId}" has unsupported MIME type "${blob.type || 'unknown'}".`,
        );
      }

      const sha256 = await this.sha256Blob(blob);

      counts.requestsSent += 1;

      let remote: ApiCardImage;

      try {
        remote = await this.syncApi.uploadImage(
          {
            id: snapshot.id,

            cardId: snapshot.cardId,

            side: snapshot.side,

            position: snapshot.position,

            blob,

            fileName: `${snapshot.id}.${this.imageFileExtension(blob.type)}`,
          },

          token,
        );
      } catch (error) {
        if (!(error instanceof SyncApiError) || error.status !== 409) {
          throw error;
        }

        /*
         * The multipart create endpoint does not return the
         * structured sync conflict response. Recover the
         * current server entity with a full pull and store a
         * normal conflict instead of silently adopting it.
         */
        const pull = await this.syncApi.pull(0, token);

        const existing = pull.images.find((image) => image.id === imageId);

        if (!existing) {
          throw new Error(
            `Image create for "${imageId}" returned HTTP 409, but the image could not be found on the server.`,
          );
        }

        await this.recordImageConflict(imageId, record.baseRevision, existing);

        counts.conflictsCreated += 1;

        continue;
      }

      if (remote.deleted_at) {
        throw new Error(`Image create for "${imageId}" returned a deleted image.`);
      }

      if (!this.remoteImageMatchesSnapshot(remote, snapshot)) {
        throw new Error(
          `Server image metadata for "${imageId}" does not match the uploaded local image.`,
        );
      }

      if (!remote.sha256 || remote.sha256.toLowerCase() !== sha256) {
        throw new Error(
          `Server SHA-256 for uploaded image "${imageId}" does not match the local image bytes.`,
        );
      }

      await this.acknowledgeAppliedImageCreate(imageId, snapshot, remote);

      counts.imagesApplied += 1;
    }
  }

  private async acknowledgeAppliedImageCreate(
    imageId: string,

    sentSnapshot: ImageSyncSnapshot,

    remote: ApiCardImage,
  ): Promise<void> {
    const currentLocation = this.findImage(this.state.getState(), imageId);

    await this.syncStorage.updateSyncMeta((meta) => {
      const record = meta.images[imageId];

      if (!record) {
        /*
         * The image was removed locally while upload was
         * running. It now exists on the server, so its
         * next local operation must be delete.
         */
        if (!currentLocation) {
          meta.images[imageId] = {
            revision: remote.revision,

            baseRevision: remote.revision,

            pendingOperation: 'delete',

            lastSyncedSnapshot: this.clone(sentSnapshot),

            conflict: null,
          };

          return;
        }

        throw new Error(
          `Image metadata for "${imageId}" disappeared while its create was running.`,
        );
      }

      if (record.conflict) {
        throw new Error(`Image "${imageId}" acquired a conflict while its upload was running.`);
      }

      record.revision = remote.revision;

      record.lastSyncedSnapshot = this.clone(sentSnapshot);

      record.conflict = null;

      if (!currentLocation) {
        record.baseRevision = remote.revision;

        record.pendingOperation = 'delete';

        return;
      }

      const currentSnapshot = this.imageSnapshot(currentLocation);

      if (this.imageSnapshotsEqual(currentSnapshot, sentSnapshot)) {
        record.baseRevision = remote.revision;

        record.pendingOperation = null;

        return;
      }

      /*
       * There is no image-update endpoint. A position or
       * parent change while upload was in flight cannot
       * be silently converted into an update.
       */
      record.baseRevision = remote.revision;

      record.pendingOperation = null;

      record.conflict = {
        entityType: 'image',

        entityId: imageId,

        detectedAt: new Date().toISOString(),

        baseRevision: remote.revision,

        serverRevision: remote.revision,

        base: this.clone(sentSnapshot),

        local: this.clone(currentSnapshot),

        server: this.clone(sentSnapshot),

        localDeleted: false,

        serverDeleted: false,
      };
    });
  }

  // -------------------------------------------------
  // Image deletes
  // -------------------------------------------------

  private async pushImageDeletes(
    token: string,

    counts: PushCounts,
  ): Promise<void> {
    const meta = await this.syncStorage.getSyncMeta();

    const ids = Object.keys(meta.images);

    for (const imageId of ids) {
      const currentMeta = await this.syncStorage.getSyncMeta();

      const record = currentMeta.images[imageId];

      if (!record) {
        continue;
      }

      if (record.conflict) {
        if (record.pendingOperation === 'delete') {
          counts.existingConflictsSkipped += 1;
        }

        continue;
      }

      if (record.pendingOperation !== 'delete') {
        continue;
      }

      const baseRevision = record.baseRevision;

      counts.requestsSent += 1;

      const response = await this.syncApi.deleteImage(
        {
          operation: 'delete',

          base_revision: baseRevision,

          image: {
            id: imageId,
          },
        },

        token,
      );

      if (response.status === 'conflict') {
        const remote = response.conflict?.server;

        if (!remote) {
          throw new Error(
            `Image delete conflict for "${imageId}" did not include the server image.`,
          );
        }

        await this.recordImageConflict(imageId, baseRevision, remote);

        counts.conflictsCreated += 1;

        continue;
      }

      if (!response.image) {
        throw new Error(`Applied image delete for "${imageId}" did not return an image.`);
      }

      const remote = response.image;

      if (!remote.deleted_at) {
        throw new Error(
          `Image "${imageId}" delete was reported as applied but the server image is active.`,
        );
      }

      await this.syncStorage.updateSyncMeta((nextMeta) => {
        const current = nextMeta.images[imageId];

        if (!current) {
          throw new Error(
            `Image metadata for "${imageId}" disappeared while its delete was running.`,
          );
        }

        if (current.conflict) {
          throw new Error(`Image "${imageId}" acquired a conflict while its delete was running.`);
        }

        if (current.baseRevision !== baseRevision) {
          throw new Error(`Image "${imageId}" base revision changed while its delete was running.`);
        }

        current.revision = remote.revision;

        current.baseRevision = remote.revision;

        current.pendingOperation = null;

        current.lastSyncedSnapshot = this.imageSnapshotFromRemote(remote);

        current.conflict = null;
      });

      counts.imagesApplied += 1;
    }
  }

  private async recordImageConflict(
    imageId: string,

    requestBaseRevision: number,

    remote: ApiCardImage,
  ): Promise<void> {
    const location = this.findImage(this.state.getState(), imageId);

    await this.syncStorage.updateSyncMeta((meta) => {
      const record = meta.images[imageId];

      if (!record) {
        throw new Error(
          `Cannot store image conflict for "${imageId}" because its metadata is missing.`,
        );
      }

      if (record.conflict) {
        return;
      }

      record.conflict = {
        entityType: 'image',

        entityId: imageId,

        detectedAt: new Date().toISOString(),

        baseRevision: requestBaseRevision,

        serverRevision: remote.revision,

        base: record.lastSyncedSnapshot ? this.clone(record.lastSyncedSnapshot) : null,

        local: location ? this.imageSnapshot(location) : null,

        server: remote.deleted_at ? null : this.imageSnapshotFromRemote(remote),

        localDeleted: !location,

        serverDeleted: !!remote.deleted_at,
      };
    });
  }

  // -------------------------------------------------
  // Local graph helpers
  // -------------------------------------------------

  private findCard(
    state: LocalState,

    cardId: string,
  ): CardLocation | null {
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

  private findImage(
    state: LocalState,

    imageId: string,
  ): ImageLocation | null {
    for (const deck of state.decks) {
      for (const card of deck.cards) {
        const frontIndex = card.front.images.findIndex((image) => image.id === imageId);

        if (frontIndex >= 0) {
          return {
            card,

            side: 'front',

            image: card.front.images[frontIndex],

            position: frontIndex,
          };
        }

        const backIndex = card.back.images.findIndex((image) => image.id === imageId);

        if (backIndex >= 0) {
          return {
            card,

            side: 'back',

            image: card.back.images[backIndex],

            position: backIndex,
          };
        }
      }
    }

    return null;
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

      position: location.position,
    };
  }

  private deckSnapshotFromRemote(remote: ApiDeck): DeckSyncSnapshot {
    return {
      id: remote.id,

      name: remote.name,

      description: remote.description?.trim() || undefined,
    };
  }

  private cardSnapshotFromRemote(remote: ApiCard): CardSyncSnapshot {
    return {
      id: remote.id,

      deckId: remote.deck_id,

      frontText: remote.front_text,

      backText: remote.back_text,

      difficulty: remote.difficulty as CardSyncSnapshot['difficulty'],

      lastReviewedAt: remote.last_reviewed_at ?? null,
    };
  }

  private imageSnapshotFromRemote(remote: ApiCardImage): ImageSyncSnapshot {
    return {
      id: remote.id,

      cardId: remote.card_id,

      side: remote.side,

      position: remote.position,
    };
  }

  // -------------------------------------------------
  // Snapshot comparisons
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

  private remoteImageMatchesSnapshot(
    remote: ApiCardImage,

    snapshot: ImageSyncSnapshot,
  ): boolean {
    return (
      remote.id === snapshot.id &&
      remote.card_id === snapshot.cardId &&
      remote.side === snapshot.side &&
      remote.position === snapshot.position
    );
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

  private async dataUrlToBlob(dataUrl: string): Promise<Blob> {
    if (!dataUrl.startsWith('data:')) {
      throw new Error('Local image is not stored as a data URL.');
    }

    const response = await fetch(dataUrl);

    if (!response.ok) {
      throw new Error('Could not decode local image data URL.');
    }

    return response.blob();
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

  private isSupportedImageMimeType(mime: string): boolean {
    return (
      mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp'
    );
  }

  private imageFileExtension(mime: string): string {
    switch (mime) {
      case 'image/png':
        return 'png';

      case 'image/jpeg':
        return 'jpg';

      case 'image/gif':
        return 'gif';

      case 'image/webp':
        return 'webp';

      default:
        throw new Error(`Unsupported image MIME type "${mime}".`);
    }
  }

  // -------------------------------------------------
  // Generic helpers
  // -------------------------------------------------

  private emptyPushCounts(): PushCounts {
    return {
      requestsSent: 0,

      decksApplied: 0,

      cardsApplied: 0,

      imagesApplied: 0,

      conflictsCreated: 0,

      existingConflictsSkipped: 0,

      noLongerPendingSkipped: 0,
    };
  }

  private clone<T>(value: T): T {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value)) as T;
    }
  }
}
