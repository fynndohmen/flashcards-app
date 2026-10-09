// src/app/sync-engine.service.ts

import { Injectable } from '@angular/core';

import { ApiCard, ApiCardImage, ApiDeck, PullResponse } from './sync-api.models';

import { SyncApiService } from './sync-api.service';

import { FlashcardsStateService } from './flashcards-state.service';

import { EntitySyncRecord, PendingSyncOperation, StoredSyncMeta } from './sync-metadata.models';

import { SyncStorageService } from './sync-storage.service';

export type PullPreviewEntityType = 'deck' | 'card' | 'image';

export type PullPreviewAction =
  | 'would-add'
  | 'would-update'
  | 'would-delete'
  | 'would-restore-missing-local'
  | 'would-record-tombstone'
  | 'would-conflict'
  | 'would-conflict-untracked-local'
  | 'existing-conflict'
  | 'local-dirty-no-newer-server-change'
  | 'would-ignore-known'
  | 'blocked-missing-parent';

export type BootstrapMode =
  | 'already-initialized'
  | 'initialize-empty'
  | 'upload-local'
  | 'download-server'
  | 'resume-local-upload'
  | 'blocked-mixed';

export interface BootstrapAssessment {
  mode: BootstrapMode;

  safeToProceed: boolean;

  reason: string;

  localHasData: boolean;

  serverHasHistory: boolean;

  serverHasActiveData: boolean;

  resumableUploadDetected: boolean;
}

export interface PullPreviewItem {
  entityType: PullPreviewEntityType;

  id: string;

  revision: number;

  deleted: boolean;

  localExists: boolean;

  localRevision: number | null;

  localBaseRevision: number | null;

  localPendingOperation: PendingSyncOperation | null;

  action: PullPreviewAction;

  reason: string;

  needsImageDownload: boolean;
}

export interface PullPreviewReport {
  generatedAt: string;

  requestSince: number;

  serverRevision: number;

  metadataInitialized: boolean;

  bootstrap: BootstrapAssessment;

  mutatesLocalState: false;

  mutatesSyncMetadata: false;

  sendsPush: false;

  local: {
    decks: number;
    cards: number;
    images: number;
  };

  remote: {
    decks: number;
    cards: number;
    images: number;
  };

  actionCounts: Record<string, number>;

  items: PullPreviewItem[];
}

@Injectable({
  providedIn: 'root',
})
export class SyncEngineService {
  constructor(
    private syncApi: SyncApiService,

    private syncStorage: SyncStorageService,

    private state: FlashcardsStateService,
  ) {}

  /**
   * READ-ONLY sync preview.
   *
   * This method:
   *
   * - reads local state
   * - reads sync metadata
   * - reads stored device auth
   * - performs GET /api/sync/pull
   * - analyses what a future sync WOULD do
   * - classifies the required bootstrap mode
   *
   * It deliberately does NOT:
   *
   * - modify flashcards-state-v2
   * - modify flashcards-sync-meta-v1
   * - download image files
   * - push anything to the server
   */
  async previewPull(): Promise<PullPreviewReport> {
    await this.state.whenReady();

    const auth = await this.syncStorage.getDeviceAuth();

    if (!auth?.token) {
      throw new Error('This device is not registered with the sync server.');
    }

    const meta = await this.syncStorage.getSyncMeta();

    /*
     * An uninitialized client always previews a complete
     * bootstrap pull from revision 0.
     */
    const since = meta.initialized ? meta.serverRevision : 0;

    const localState = this.state.getState();

    const response = await this.syncApi.pull(since, auth.token);

    this.validatePullResponse(response, since);

    return this.buildPreviewReport(localState, meta, response, since);
  }

  /**
   * Convenience helper for our current development phase.
   *
   * It logs the complete preview without exposing the
   * device token.
   */
  async previewPullAndLog(): Promise<PullPreviewReport> {
    const report = await this.previewPull();

    console.group('Flashcards sync pull preview');

    console.log('READ-ONLY PREVIEW — no local state or server data was changed.');

    console.log({
      requestSince: report.requestSince,

      serverRevision: report.serverRevision,

      metadataInitialized: report.metadataInitialized,

      bootstrap: report.bootstrap,

      local: report.local,

      remote: report.remote,

      actionCounts: report.actionCounts,

      mutatesLocalState: report.mutatesLocalState,

      mutatesSyncMetadata: report.mutatesSyncMetadata,

      sendsPush: report.sendsPush,
    });

    console.table(
      report.items.map((item) => ({
        type: item.entityType,

        id: item.id,

        revision: item.revision,

        deleted: item.deleted,

        localExists: item.localExists,

        localRevision: item.localRevision,

        baseRevision: item.localBaseRevision,

        pending: item.localPendingOperation,

        action: item.action,

        imageDownload: item.needsImageDownload,

        reason: item.reason,
      })),
    );

    console.groupEnd();

    return report;
  }

  private buildPreviewReport(
    localState: ReturnType<FlashcardsStateService['getState']>,

    meta: StoredSyncMeta,

    response: PullResponse,

    since: number,
  ): PullPreviewReport {
    const localDeckIds = new Set(localState.decks.map((deck) => deck.id));

    const localCardIds = new Set<string>();

    const localImageIds = new Set<string>();

    for (const deck of localState.decks) {
      for (const card of deck.cards) {
        localCardIds.add(card.id);

        for (const image of card.front.images) {
          localImageIds.add(image.id);
        }

        for (const image of card.back.images) {
          localImageIds.add(image.id);
        }
      }
    }

    const activeRemoteDeckIds = new Set(
      response.decks.filter((deck) => !deck.deleted_at).map((deck) => deck.id),
    );

    const activeRemoteCardIds = new Set(
      response.cards.filter((card) => !card.deleted_at).map((card) => card.id),
    );

    const items: PullPreviewItem[] = [];

    for (const deck of response.decks) {
      items.push(this.previewDeck(deck, localDeckIds.has(deck.id), meta));
    }

    for (const card of response.cards) {
      const item = this.previewCard(card, localCardIds.has(card.id), meta);

      if (
        !card.deleted_at &&
        this.isSafeApplyAction(item.action) &&
        !localDeckIds.has(card.deck_id) &&
        !activeRemoteDeckIds.has(card.deck_id)
      ) {
        item.action = 'blocked-missing-parent';

        item.reason = `Card references deck "${card.deck_id}", but that deck is neither local nor included as an active remote deck in this pull.`;
      }

      items.push(item);
    }

    for (const image of response.images) {
      const item = this.previewImage(image, localImageIds.has(image.id), meta);

      if (
        !image.deleted_at &&
        this.isSafeApplyAction(item.action) &&
        !localCardIds.has(image.card_id) &&
        !activeRemoteCardIds.has(image.card_id)
      ) {
        item.action = 'blocked-missing-parent';

        item.reason = `Image references card "${image.card_id}", but that card is neither local nor included as an active remote card in this pull.`;

        item.needsImageDownload = false;
      }

      items.push(item);
    }

    const actionCounts: Record<string, number> = {};

    for (const item of items) {
      actionCounts[item.action] = (actionCounts[item.action] ?? 0) + 1;
    }

    const bootstrap = this.assessBootstrap(localState, meta, response);

    return {
      generatedAt: new Date().toISOString(),

      requestSince: since,

      serverRevision: response.server_revision,

      metadataInitialized: meta.initialized,

      bootstrap,

      mutatesLocalState: false,

      mutatesSyncMetadata: false,

      sendsPush: false,

      local: {
        decks: localDeckIds.size,

        cards: localCardIds.size,

        images: localImageIds.size,
      },

      remote: {
        decks: response.decks.length,

        cards: response.cards.length,

        images: response.images.length,
      },

      actionCounts,

      items,
    };
  }

  private assessBootstrap(
    localState: ReturnType<FlashcardsStateService['getState']>,

    meta: StoredSyncMeta,

    response: PullResponse,
  ): BootstrapAssessment {
    const localHasData = this.localStateHasData(localState);

    const serverHasHistory =
      response.server_revision > 0 ||
      response.decks.length > 0 ||
      response.cards.length > 0 ||
      response.images.length > 0;

    const serverHasActiveData =
      response.decks.some((deck) => !deck.deleted_at) ||
      response.cards.some((card) => !card.deleted_at) ||
      response.images.some((image) => !image.deleted_at);

    if (meta.initialized) {
      return {
        mode: 'already-initialized',

        safeToProceed: true,

        reason:
          'This client has already completed bootstrap. Normal incremental synchronization should be used.',

        localHasData,

        serverHasHistory,

        serverHasActiveData,

        resumableUploadDetected: false,
      };
    }

    if (!localHasData && !serverHasHistory) {
      return {
        mode: 'initialize-empty',

        safeToProceed: true,

        reason:
          'Both the local client and the server are empty. Bootstrap only needs to mark this client initialized at server revision 0.',

        localHasData,

        serverHasHistory,

        serverHasActiveData,

        resumableUploadDetected: false,
      };
    }

    if (localHasData && !serverHasHistory) {
      return {
        mode: 'upload-local',

        safeToProceed: true,

        reason:
          'Local flashcards exist and the server is empty. The local dataset can become the initial server dataset.',

        localHasData,

        serverHasHistory,

        serverHasActiveData,

        resumableUploadDetected: false,
      };
    }

    if (!localHasData && serverHasHistory) {
      return {
        mode: 'download-server',

        safeToProceed: true,

        reason:
          'The local client is empty and the server already has sync history. The server dataset can bootstrap this client.',

        localHasData,

        serverHasHistory,

        serverHasActiveData,

        resumableUploadDetected: false,
      };
    }

    const resumableUpload = this.isResumableLocalBootstrap(localState, meta, response);

    if (resumableUpload) {
      return {
        mode: 'resume-local-upload',

        safeToProceed: true,

        reason:
          'Local data and server data both exist, but the remote objects exactly match entities already acknowledged during an unfinished local-first bootstrap. The upload can safely resume.',

        localHasData,

        serverHasHistory,

        serverHasActiveData,

        resumableUploadDetected: true,
      };
    }

    return {
      mode: 'blocked-mixed',

      safeToProceed: false,

      reason:
        'Both local and server data exist on an uninitialized client, and the server state cannot be proven to belong to an interrupted local-first bootstrap. Automatic bootstrap must stop to avoid silent merging or data loss.',

      localHasData,

      serverHasHistory,

      serverHasActiveData,

      resumableUploadDetected: false,
    };
  }

  private localStateHasData(localState: ReturnType<FlashcardsStateService['getState']>): boolean {
    if (localState.decks.length > 0) {
      return true;
    }

    return false;
  }

  private isResumableLocalBootstrap(
    localState: ReturnType<FlashcardsStateService['getState']>,

    meta: StoredSyncMeta,

    response: PullResponse,
  ): boolean {
    /*
     * A local-first bootstrap never creates tombstones.
     * Seeing one means the server has history that cannot
     * be explained purely by our interrupted initial upload.
     */
    if (
      response.decks.some((deck) => !!deck.deleted_at) ||
      response.cards.some((card) => !!card.deleted_at) ||
      response.images.some((image) => !!image.deleted_at)
    ) {
      return false;
    }

    const localDecks = new Map(localState.decks.map((deck) => [deck.id, deck]));

    const localCards = new Map<
      string,
      {
        deckId: string;
        card: ReturnType<FlashcardsStateService['getState']>['decks'][number]['cards'][number];
      }
    >();

    const localImages = new Map<
      string,
      {
        cardId: string;
        side: 'front' | 'back';
        position: number;
      }
    >();

    for (const deck of localState.decks) {
      for (const card of deck.cards) {
        localCards.set(card.id, {
          deckId: deck.id,

          card,
        });

        card.front.images.forEach((image, position) => {
          localImages.set(image.id, {
            cardId: card.id,

            side: 'front',

            position,
          });
        });

        card.back.images.forEach((image, position) => {
          localImages.set(image.id, {
            cardId: card.id,

            side: 'back',

            position,
          });
        });
      }
    }

    /*
     * Every local entity must already have bootstrap
     * metadata. This is what distinguishes a deliberate,
     * resumable bootstrap from arbitrary mixed data.
     */
    for (const deck of localState.decks) {
      if (!this.isSafeBootstrapRecord(meta.decks[deck.id])) {
        return false;
      }

      for (const card of deck.cards) {
        if (!this.isSafeBootstrapRecord(meta.cards[card.id])) {
          return false;
        }

        for (const image of card.front.images) {
          if (!this.isSafeBootstrapRecord(meta.images[image.id])) {
            return false;
          }
        }

        for (const image of card.back.images) {
          if (!this.isSafeBootstrapRecord(meta.images[image.id])) {
            return false;
          }
        }
      }
    }

    /*
     * Every remote entity must exist locally and must
     * exactly match a clean server revision that this
     * client already acknowledged.
     */
    for (const deck of response.decks) {
      const local = localDecks.get(deck.id);

      const record = meta.decks[deck.id];

      if (
        !local ||
        !record ||
        record.pendingOperation !== null ||
        record.conflict !== null ||
        record.revision !== deck.revision ||
        record.baseRevision !== deck.revision ||
        !record.lastSyncedSnapshot
      ) {
        return false;
      }

      const snapshot = record.lastSyncedSnapshot;

      if (
        snapshot.id !== deck.id ||
        snapshot.name !== deck.name ||
        (snapshot.description ?? undefined) !== (deck.description ?? undefined)
      ) {
        return false;
      }
    }

    for (const card of response.cards) {
      const local = localCards.get(card.id);

      const record = meta.cards[card.id];

      if (
        !local ||
        !record ||
        record.pendingOperation !== null ||
        record.conflict !== null ||
        record.revision !== card.revision ||
        record.baseRevision !== card.revision ||
        !record.lastSyncedSnapshot
      ) {
        return false;
      }

      const snapshot = record.lastSyncedSnapshot;

      if (
        snapshot.id !== card.id ||
        snapshot.deckId !== card.deck_id ||
        snapshot.frontText !== card.front_text ||
        snapshot.backText !== card.back_text ||
        snapshot.difficulty !== card.difficulty ||
        snapshot.lastReviewedAt !== (card.last_reviewed_at ?? null)
      ) {
        return false;
      }
    }

    for (const image of response.images) {
      const local = localImages.get(image.id);

      const record = meta.images[image.id];

      if (
        !local ||
        !record ||
        record.pendingOperation !== null ||
        record.conflict !== null ||
        record.revision !== image.revision ||
        record.baseRevision !== image.revision ||
        !record.lastSyncedSnapshot
      ) {
        return false;
      }

      const snapshot = record.lastSyncedSnapshot;

      if (
        snapshot.id !== image.id ||
        snapshot.cardId !== image.card_id ||
        snapshot.side !== image.side ||
        snapshot.position !== image.position
      ) {
        return false;
      }
    }

    /*
     * There must be at least one acknowledged remote
     * entity; otherwise this is not a resume situation.
     */
    return response.decks.length > 0 || response.cards.length > 0 || response.images.length > 0;
  }

  private isSafeBootstrapRecord<TSnapshot>(
    record: EntitySyncRecord<TSnapshot> | undefined,
  ): boolean {
    if (!record) {
      return false;
    }

    if (record.conflict) {
      return false;
    }

    if (record.pendingOperation === 'create') {
      return (
        record.revision === 0 && record.baseRevision === 0 && record.lastSyncedSnapshot === null
      );
    }

    if (record.pendingOperation === null) {
      return (
        record.revision > 0 &&
        record.baseRevision === record.revision &&
        record.lastSyncedSnapshot !== null
      );
    }

    return false;
  }

  private previewDeck(
    deck: ApiDeck,

    localExists: boolean,

    meta: StoredSyncMeta,
  ): PullPreviewItem {
    return this.previewEntity(
      'deck',

      deck.id,

      deck.revision,

      !!deck.deleted_at,

      localExists,

      meta.decks[deck.id],
    );
  }

  private previewCard(
    card: ApiCard,

    localExists: boolean,

    meta: StoredSyncMeta,
  ): PullPreviewItem {
    return this.previewEntity(
      'card',

      card.id,

      card.revision,

      !!card.deleted_at,

      localExists,

      meta.cards[card.id],
    );
  }

  private previewImage(
    image: ApiCardImage,

    localExists: boolean,

    meta: StoredSyncMeta,
  ): PullPreviewItem {
    const item = this.previewEntity(
      'image',

      image.id,

      image.revision,

      !!image.deleted_at,

      localExists,

      meta.images[image.id],
    );

    item.needsImageDownload =
      !image.deleted_at &&
      (item.action === 'would-add' ||
        item.action === 'would-update' ||
        item.action === 'would-restore-missing-local');

    return item;
  }

  private previewEntity(
    entityType: PullPreviewEntityType,

    id: string,

    remoteRevision: number,

    deleted: boolean,

    localExists: boolean,

    record: EntitySyncRecord<unknown> | undefined,
  ): PullPreviewItem {
    const base: Omit<PullPreviewItem, 'action' | 'reason'> = {
      entityType,

      id,

      revision: remoteRevision,

      deleted,

      localExists,

      localRevision: record?.revision ?? null,

      localBaseRevision: record?.baseRevision ?? null,

      localPendingOperation: record?.pendingOperation ?? null,

      needsImageDownload: false,
    };

    if (record?.conflict) {
      return {
        ...base,

        action: 'existing-conflict',

        reason: 'This entity already has an unresolved local sync conflict.',
      };
    }

    if (record?.pendingOperation) {
      if (remoteRevision > record.baseRevision) {
        return {
          ...base,

          action: 'would-conflict',

          reason: `Local ${record.pendingOperation} is pending against base revision ${record.baseRevision}, while the server now has revision ${remoteRevision}.`,
        };
      }

      return {
        ...base,

        action: 'local-dirty-no-newer-server-change',

        reason: `A local ${record.pendingOperation} is pending, but the incoming server revision is not newer than its frozen base revision.`,
      };
    }

    if (!record) {
      if (localExists) {
        return {
          ...base,

          action: 'would-conflict-untracked-local',

          reason:
            'A local entity with the same ID exists but has no known server ancestry. It must not be silently overwritten during bootstrap.',
        };
      }

      if (deleted) {
        return {
          ...base,

          action: 'would-record-tombstone',

          reason:
            'The server reports a deleted entity that is already absent locally. A future sync only needs to remember its server revision.',
        };
      }

      return {
        ...base,

        action: 'would-add',

        reason: 'Active server entity does not exist locally and has no local dirty state.',
      };
    }

    if (remoteRevision <= record.revision) {
      return {
        ...base,

        action: 'would-ignore-known',

        reason: `Server revision ${remoteRevision} is not newer than the locally known server revision ${record.revision}.`,
      };
    }

    if (deleted) {
      if (localExists) {
        return {
          ...base,

          action: 'would-delete',

          reason: 'A newer server tombstone would remove the clean local entity.',
        };
      }

      return {
        ...base,

        action: 'would-record-tombstone',

        reason:
          'The newer server tombstone is already reflected by the absence of the local entity.',
      };
    }

    if (localExists) {
      return {
        ...base,

        action: 'would-update',

        reason: 'A newer active server revision would update the clean local entity.',
      };
    }

    return {
      ...base,

      action: 'would-restore-missing-local',

      reason: 'The server has a newer active entity, but the clean local entity is missing.',
    };
  }

  private isSafeApplyAction(action: PullPreviewAction): boolean {
    return (
      action === 'would-add' ||
      action === 'would-update' ||
      action === 'would-restore-missing-local'
    );
  }

  private validatePullResponse(
    response: PullResponse,

    expectedSince: number,
  ): void {
    if (!Number.isSafeInteger(response.since) || response.since < 0) {
      throw new Error('Sync server returned an invalid pull "since" revision.');
    }

    if (response.since !== expectedSince) {
      throw new Error(`Sync server returned since=${response.since}, expected ${expectedSince}.`);
    }

    if (!Number.isSafeInteger(response.server_revision) || response.server_revision < 0) {
      throw new Error('Sync server returned an invalid server revision.');
    }

    if (response.server_revision < expectedSince) {
      throw new Error(
        `Sync server revision ${response.server_revision} is older than requested revision ${expectedSince}.`,
      );
    }

    if (
      !Array.isArray(response.decks) ||
      !Array.isArray(response.cards) ||
      !Array.isArray(response.images)
    ) {
      throw new Error('Sync server returned an invalid pull payload.');
    }

    this.validateRemoteRevisions(response);
  }

  private validateRemoteRevisions(response: PullResponse): void {
    const entities = [
      ...response.decks.map((entity) => ({
        type: 'deck',

        id: entity.id,

        revision: entity.revision,
      })),

      ...response.cards.map((entity) => ({
        type: 'card',

        id: entity.id,

        revision: entity.revision,
      })),

      ...response.images.map((entity) => ({
        type: 'image',

        id: entity.id,

        revision: entity.revision,
      })),
    ];

    for (const entity of entities) {
      if (
        !entity.id ||
        !Number.isSafeInteger(entity.revision) ||
        entity.revision < 0 ||
        entity.revision > response.server_revision
      ) {
        throw new Error(
          `Sync server returned invalid ${entity.type} revision data for "${entity.id}".`,
        );
      }
    }
  }
}
