// src/app/sync-engine.service.ts

import { Injectable } from '@angular/core';

import { DifficultyLevel, FlashcardsState } from './models';

import { ApiCard, ApiCardImage, ApiDeck, PullResponse } from './sync-api.models';

import { SyncApiError, SyncApiService } from './sync-api.service';

import { FlashcardsStateService } from './flashcards-state.service';

import {
  CardSyncSnapshot,
  DeckSyncSnapshot,
  EntitySyncRecord,
  ImageSyncSnapshot,
  PendingSyncOperation,
  StoredSyncMeta,
  SyncImageSide,
} from './sync-metadata.models';

import { SyncStorageService } from './sync-storage.service';

type LocalState = ReturnType<FlashcardsStateService['getState']>;

type LocalDeck = LocalState['decks'][number];

type LocalCard = LocalDeck['cards'][number];

type LocalImage = LocalCard['front']['images'][number];

interface LocalCardEntry {
  deckId: string;
  card: LocalCard;
}

interface LocalImageEntry {
  cardId: string;
  side: SyncImageSide;
  position: number;
  image: LocalImage;
}

interface LocalIndexes {
  decks: Map<string, LocalDeck>;
  cards: Map<string, LocalCardEntry>;
  images: Map<string, LocalImageEntry>;
}

interface CachedLocalImage {
  blob: Blob;
  sha256: string;
  fileName: string;
}

interface DownloadedRemoteImage {
  dataUrl: string;
  sha256: string;
  mimeType: string;
}

interface BootstrapTransferCounts {
  decks: number;
  cards: number;
  images: number;
}

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

export type BootstrapExecutionStatus =
  | 'initialized-empty'
  | 'uploaded-local'
  | 'resumed-local-upload'
  | 'downloaded-server'
  | 'already-initialized';

export interface BootstrapAssessment {
  mode: BootstrapMode;

  safeToProceed: boolean;

  reason: string;

  localHasData: boolean;

  serverHasHistory: boolean;

  serverHasActiveData: boolean;

  resumableUploadDetected: boolean;
}

export interface BootstrapExecutionResult {
  status: BootstrapExecutionStatus;

  mode: BootstrapMode;

  initialized: boolean;

  serverRevision: number;

  lastSuccessfulSyncAt: string | null;

  uploaded: BootstrapTransferCounts;

  adopted: BootstrapTransferCounts;

  downloaded: BootstrapTransferCounts;

  changedLocalMetadata: boolean;

  changedLocalState: boolean;

  changedServerData: boolean;
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

  // -------------------------------------------------
  // Read-only preview
  // -------------------------------------------------

  async previewPull(): Promise<PullPreviewReport> {
    await this.state.whenReady();

    const auth = await this.syncStorage.getDeviceAuth();

    if (!auth?.token) {
      throw new Error('This device is not registered with the sync server.');
    }

    const meta = await this.syncStorage.getSyncMeta();

    const since = meta.initialized ? meta.serverRevision : 0;

    const localState = this.state.getState();

    const response = await this.syncApi.pull(since, auth.token);

    this.validatePullResponse(response, since);

    return this.buildPreviewReport(localState, meta, response, since);
  }

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

  // -------------------------------------------------
  // Bootstrap
  // -------------------------------------------------

  async bootstrap(): Promise<BootstrapExecutionResult> {
    const report = await this.previewPull();

    if (report.bootstrap.mode === 'already-initialized') {
      return this.alreadyInitializedResult();
    }

    if (report.bootstrap.mode === 'initialize-empty') {
      return this.bootstrapEmpty(report);
    }

    if (
      report.bootstrap.mode === 'upload-local' ||
      report.bootstrap.mode === 'resume-local-upload'
    ) {
      return this.bootstrapUploadLocal(report.bootstrap.mode);
    }

    if (report.bootstrap.mode === 'download-server') {
      return this.bootstrapDownloadServer();
    }

    throw new Error(
      `Bootstrap mode "${report.bootstrap.mode}" is not safe for automatic execution.`,
    );
  }

  async bootstrapAndLog(): Promise<BootstrapExecutionResult> {
    const result = await this.bootstrap();

    console.group('Flashcards sync bootstrap');

    console.log({
      status: result.status,

      mode: result.mode,

      initialized: result.initialized,

      serverRevision: result.serverRevision,

      lastSuccessfulSyncAt: result.lastSuccessfulSyncAt,

      uploaded: result.uploaded,

      adopted: result.adopted,

      downloaded: result.downloaded,

      changedLocalMetadata: result.changedLocalMetadata,

      changedLocalState: result.changedLocalState,

      changedServerData: result.changedServerData,
    });

    console.groupEnd();

    return result;
  }

  private async alreadyInitializedResult(): Promise<BootstrapExecutionResult> {
    const meta = await this.syncStorage.getSyncMeta();

    return {
      status: 'already-initialized',

      mode: 'already-initialized',

      initialized: meta.initialized,

      serverRevision: meta.serverRevision,

      lastSuccessfulSyncAt: meta.lastSuccessfulSyncAt,

      uploaded: this.emptyTransferCounts(),

      adopted: this.emptyTransferCounts(),

      downloaded: this.emptyTransferCounts(),

      changedLocalMetadata: false,

      changedLocalState: false,

      changedServerData: false,
    };
  }

  private async bootstrapEmpty(report: PullPreviewReport): Promise<BootstrapExecutionResult> {
    const currentState = this.state.getState();

    if (this.localStateHasData(currentState)) {
      throw new Error(
        'Empty bootstrap aborted because local flashcard data appeared after the preview.',
      );
    }

    if (
      report.serverRevision !== 0 ||
      report.remote.decks !== 0 ||
      report.remote.cards !== 0 ||
      report.remote.images !== 0
    ) {
      throw new Error('Empty bootstrap aborted because the server is not empty.');
    }

    const completedAt = new Date().toISOString();

    let changed = false;

    const updatedMeta = await this.syncStorage.updateSyncMeta((meta) => {
      if (meta.initialized) {
        return;
      }

      if (meta.serverRevision !== 0) {
        throw new Error(
          `Empty bootstrap expected local serverRevision 0, found ${meta.serverRevision}.`,
        );
      }

      if (this.syncMetaHasEntityRecords(meta)) {
        throw new Error('Empty bootstrap found existing entity sync metadata.');
      }

      meta.initialized = true;

      meta.serverRevision = 0;

      meta.lastSuccessfulSyncAt = completedAt;

      changed = true;
    });

    return {
      status: changed ? 'initialized-empty' : 'already-initialized',

      mode: changed ? 'initialize-empty' : 'already-initialized',

      initialized: updatedMeta.initialized,

      serverRevision: updatedMeta.serverRevision,

      lastSuccessfulSyncAt: updatedMeta.lastSuccessfulSyncAt,

      uploaded: this.emptyTransferCounts(),

      adopted: this.emptyTransferCounts(),

      downloaded: this.emptyTransferCounts(),

      changedLocalMetadata: changed,

      changedLocalState: false,

      changedServerData: false,
    };
  }

  // -------------------------------------------------
  // Download-server bootstrap
  // -------------------------------------------------

  private async bootstrapDownloadServer(): Promise<BootstrapExecutionResult> {
    await this.state.whenReady();

    const auth = await this.syncStorage.getDeviceAuth();

    if (!auth?.token) {
      throw new Error('This device is not registered with the sync server.');
    }

    const initialState = this.state.getState();

    if (this.localStateHasData(initialState)) {
      throw new Error('Server-first bootstrap requires an empty local flashcard state.');
    }

    const initialMeta = await this.syncStorage.getSyncMeta();

    if (initialMeta.initialized) {
      throw new Error(
        'Server-first bootstrap cannot run because this client is already initialized.',
      );
    }

    if (initialMeta.serverRevision !== 0) {
      throw new Error(
        `Uninitialized server-first bootstrap expected local serverRevision 0, found ${initialMeta.serverRevision}.`,
      );
    }

    if (this.syncMetaHasEntityRecords(initialMeta)) {
      throw new Error(
        'Server-first bootstrap found existing entity sync metadata on an empty uninitialized client.',
      );
    }

    /*
     * Re-pull revision 0 instead of trusting the earlier
     * preview. The preview is informational only.
     */
    const response = await this.syncApi.pull(0, auth.token);

    this.validatePullResponse(response, 0);

    this.validateRemoteBootstrapDataset(response);

    if (
      response.server_revision === 0 &&
      response.decks.length === 0 &&
      response.cards.length === 0 &&
      response.images.length === 0
    ) {
      throw new Error(
        'Server-first bootstrap expected server history, but the server is now empty. Run bootstrap again so the mode can be reclassified.',
      );
    }

    const downloadedImages = await this.downloadRemoteBootstrapImages(response, auth.token);

    /*
     * No visible local mutation is allowed while the
     * bootstrap downloads are in progress.
     */
    this.assertLocalStateUnchanged(initialState);

    /*
     * Make sure the server snapshot did not change while
     * image files were being downloaded.
     *
     * If anything changed, no local commit has happened yet;
     * abort and let the user retry from a fresh pull.
     */
    const stabilityPull = await this.syncApi.pull(response.server_revision, auth.token);

    this.validatePullResponse(stabilityPull, response.server_revision);

    if (
      stabilityPull.server_revision !== response.server_revision ||
      stabilityPull.decks.length > 0 ||
      stabilityPull.cards.length > 0 ||
      stabilityPull.images.length > 0
    ) {
      throw new Error(
        'The sync server changed while the initial dataset was being downloaded. No local state was committed; run bootstrap again.',
      );
    }

    this.assertLocalStateUnchanged(initialState);

    const newState = this.buildStateFromRemoteBootstrap(response, downloadedImages);

    const completedAt = new Date().toISOString();

    const updatedMeta = await this.state.replaceStateFromSync(
      newState,

      (meta) => {
        if (meta.initialized) {
          throw new Error(
            'Server-first bootstrap finalization found an already initialized client.',
          );
        }

        if (meta.serverRevision !== 0) {
          throw new Error(
            `Server-first bootstrap finalization expected local serverRevision 0, found ${meta.serverRevision}.`,
          );
        }

        if (this.syncMetaHasEntityRecords(meta)) {
          throw new Error(
            'Server-first bootstrap finalization found unexpected existing entity metadata.',
          );
        }

        meta.decks = {};
        meta.cards = {};
        meta.images = {};

        for (const deck of response.decks) {
          meta.decks[deck.id] = this.cleanEntityRecord(
            deck.revision,
            this.deckSnapshotFromRemote(deck),
          );
        }

        for (const card of response.cards) {
          meta.cards[card.id] = this.cleanEntityRecord(
            card.revision,
            this.cardSnapshotFromRemote(card),
          );
        }

        for (const image of response.images) {
          meta.images[image.id] = this.cleanEntityRecord(
            image.revision,
            this.imageSnapshotFromRemote(image),
          );
        }

        meta.initialized = true;

        meta.serverRevision = response.server_revision;

        meta.lastSuccessfulSyncAt = completedAt;
      },
    );

    const downloaded = this.countActiveRemoteEntities(response);

    return {
      status: 'downloaded-server',

      mode: 'download-server',

      initialized: updatedMeta.initialized,

      serverRevision: updatedMeta.serverRevision,

      lastSuccessfulSyncAt: updatedMeta.lastSuccessfulSyncAt,

      uploaded: this.emptyTransferCounts(),

      adopted: this.emptyTransferCounts(),

      downloaded,

      changedLocalMetadata: true,

      changedLocalState: downloaded.decks > 0 || downloaded.cards > 0 || downloaded.images > 0,

      changedServerData: false,
    };
  }

  private validateRemoteBootstrapDataset(response: PullResponse): void {
    const deckIds = new Set<string>();

    const cardIds = new Set<string>();

    const imageIds = new Set<string>();

    const decksById = new Map<string, ApiDeck>();

    const cardsById = new Map<string, ApiCard>();

    for (const deck of response.decks) {
      if (deckIds.has(deck.id)) {
        throw new Error(`Server bootstrap payload contains duplicate deck ID "${deck.id}".`);
      }

      deckIds.add(deck.id);

      decksById.set(deck.id, deck);

      if (deck.revision <= 0) {
        throw new Error(`Server deck "${deck.id}" has invalid revision ${deck.revision}.`);
      }

      if (!deck.name.trim()) {
        throw new Error(`Server deck "${deck.id}" has an empty name.`);
      }

      this.assertValidTimestamp(deck.created_at, `deck "${deck.id}" created_at`);

      this.assertValidTimestamp(deck.updated_at, `deck "${deck.id}" updated_at`);

      if (deck.deleted_at) {
        this.assertValidTimestamp(deck.deleted_at, `deck "${deck.id}" deleted_at`);
      }
    }

    for (const card of response.cards) {
      if (cardIds.has(card.id)) {
        throw new Error(`Server bootstrap payload contains duplicate card ID "${card.id}".`);
      }

      cardIds.add(card.id);

      cardsById.set(card.id, card);

      if (card.revision <= 0) {
        throw new Error(`Server card "${card.id}" has invalid revision ${card.revision}.`);
      }

      const parentDeck = decksById.get(card.deck_id);

      if (!parentDeck) {
        throw new Error(`Server card "${card.id}" references missing deck "${card.deck_id}".`);
      }

      if (!card.deleted_at && parentDeck.deleted_at) {
        throw new Error(
          `Active server card "${card.id}" belongs to deleted deck "${card.deck_id}".`,
        );
      }

      if (!Number.isSafeInteger(card.difficulty) || card.difficulty < 1 || card.difficulty > 10) {
        throw new Error(`Server card "${card.id}" has invalid difficulty ${card.difficulty}.`);
      }

      this.assertValidTimestamp(card.created_at, `card "${card.id}" created_at`);

      this.assertValidTimestamp(card.updated_at, `card "${card.id}" updated_at`);

      if (card.last_reviewed_at) {
        this.assertValidTimestamp(card.last_reviewed_at, `card "${card.id}" last_reviewed_at`);
      }

      if (card.deleted_at) {
        this.assertValidTimestamp(card.deleted_at, `card "${card.id}" deleted_at`);
      }
    }

    const activeImageGroups = new Map<string, ApiCardImage[]>();

    for (const image of response.images) {
      if (imageIds.has(image.id)) {
        throw new Error(`Server bootstrap payload contains duplicate image ID "${image.id}".`);
      }

      imageIds.add(image.id);

      if (image.revision <= 0) {
        throw new Error(`Server image "${image.id}" has invalid revision ${image.revision}.`);
      }

      const parentCard = cardsById.get(image.card_id);

      if (!parentCard) {
        throw new Error(`Server image "${image.id}" references missing card "${image.card_id}".`);
      }

      if (image.side !== 'front' && image.side !== 'back') {
        throw new Error(`Server image "${image.id}" has invalid side "${image.side}".`);
      }

      if (!Number.isSafeInteger(image.position) || image.position < 0) {
        throw new Error(`Server image "${image.id}" has invalid position ${image.position}.`);
      }

      this.assertValidTimestamp(image.created_at, `image "${image.id}" created_at`);

      this.assertValidTimestamp(image.updated_at, `image "${image.id}" updated_at`);

      if (image.deleted_at) {
        this.assertValidTimestamp(image.deleted_at, `image "${image.id}" deleted_at`);
      }

      if (image.deleted_at) {
        continue;
      }

      if (parentCard.deleted_at) {
        throw new Error(
          `Active server image "${image.id}" belongs to deleted card "${image.card_id}".`,
        );
      }

      const mimeType = image.mime_type?.toLowerCase();

      if (!mimeType || !this.isSupportedImageMimeType(mimeType)) {
        throw new Error(
          `Active server image "${image.id}" has unsupported MIME type "${image.mime_type ?? 'missing'}".`,
        );
      }

      if (!image.sha256 || !/^[0-9a-f]{64}$/i.test(image.sha256)) {
        throw new Error(`Active server image "${image.id}" has no valid SHA-256 digest.`);
      }

      const groupKey = `${image.card_id}\u0000${image.side}`;

      const group = activeImageGroups.get(groupKey) ?? [];

      group.push(image);

      activeImageGroups.set(groupKey, group);
    }

    /*
     * Active images are represented locally as ordered
     * arrays. Require exact contiguous server positions.
     */
    for (const group of activeImageGroups.values()) {
      group.sort((a, b) => a.position - b.position);

      group.forEach((image, index) => {
        if (image.position !== index) {
          throw new Error(
            `Server image positions for card "${image.card_id}" side "${image.side}" are not contiguous from 0.`,
          );
        }
      });
    }
  }

  private async downloadRemoteBootstrapImages(
    response: PullResponse,

    token: string,
  ): Promise<Map<string, DownloadedRemoteImage>> {
    const result = new Map<string, DownloadedRemoteImage>();

    const activeImages = response.images
      .filter((image) => !image.deleted_at)
      .sort(
        (a, b) =>
          a.card_id.localeCompare(b.card_id) ||
          a.side.localeCompare(b.side) ||
          a.position - b.position,
      );

    for (const image of activeImages) {
      const blob = await this.syncApi.downloadImage(image.id, token);

      const expectedMimeType = image.mime_type!.toLowerCase();

      const actualMimeType = blob.type.toLowerCase();

      if (actualMimeType && actualMimeType !== expectedMimeType) {
        throw new Error(
          `Downloaded image "${image.id}" MIME type "${actualMimeType}" does not match server metadata "${expectedMimeType}".`,
        );
      }

      const sha256 = await this.sha256Blob(blob);

      if (sha256 !== image.sha256!.toLowerCase()) {
        throw new Error(`Downloaded image "${image.id}" failed SHA-256 verification.`);
      }

      const dataUrl = await this.blobToDataUrl(blob);

      result.set(image.id, {
        dataUrl,
        sha256,
        mimeType: expectedMimeType,
      });
    }

    return result;
  }

  private buildStateFromRemoteBootstrap(
    response: PullResponse,

    downloadedImages: Map<string, DownloadedRemoteImage>,
  ): FlashcardsState {
    const activeDecks = response.decks
      .filter((deck) => !deck.deleted_at)
      .sort((a, b) => this.compareRemoteCreationOrder(a.created_at, a.id, b.created_at, b.id));

    const activeCards = response.cards
      .filter((card) => !card.deleted_at)
      .sort((a, b) => this.compareRemoteCreationOrder(a.created_at, a.id, b.created_at, b.id));

    const activeImages = response.images
      .filter((image) => !image.deleted_at)
      .sort(
        (a, b) =>
          a.card_id.localeCompare(b.card_id) ||
          a.side.localeCompare(b.side) ||
          a.position - b.position,
      );

    const decks: FlashcardsState['decks'] = activeDecks.map((deck) => ({
      id: deck.id,

      name: deck.name,

      description: deck.description?.trim() || undefined,

      cards: [],
    }));

    const decksById = new Map(decks.map((deck) => [deck.id, deck]));

    const cardsById = new Map<string, LocalCard>();

    for (const remoteCard of activeCards) {
      const deck = decksById.get(remoteCard.deck_id);

      if (!deck) {
        throw new Error(
          `Active remote card "${remoteCard.id}" cannot be attached to deck "${remoteCard.deck_id}".`,
        );
      }

      const card: LocalCard = {
        id: remoteCard.id,

        front: {
          text: remoteCard.front_text,

          images: [],
        },

        back: {
          text: remoteCard.back_text,

          images: [],
        },

        difficulty: remoteCard.difficulty as DifficultyLevel,

        createdAt: remoteCard.created_at,

        updatedAt: remoteCard.updated_at,

        lastReviewedAt: remoteCard.last_reviewed_at ?? null,
      };

      deck.cards.push(card);

      cardsById.set(card.id, card);
    }

    for (const remoteImage of activeImages) {
      const card = cardsById.get(remoteImage.card_id);

      if (!card) {
        throw new Error(
          `Active remote image "${remoteImage.id}" cannot be attached to card "${remoteImage.card_id}".`,
        );
      }

      const downloaded = downloadedImages.get(remoteImage.id);

      if (!downloaded) {
        throw new Error(`Downloaded bytes for image "${remoteImage.id}" are missing.`);
      }

      const localImage: LocalImage = {
        id: remoteImage.id,

        dataUrl: downloaded.dataUrl,
      };

      if (remoteImage.side === 'front') {
        card.front.images.push(localImage);
      } else {
        card.back.images.push(localImage);
      }
    }

    return {
      decks,
    };
  }

  private cleanEntityRecord<TSnapshot>(
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

  private countActiveRemoteEntities(response: PullResponse): BootstrapTransferCounts {
    return {
      decks: response.decks.filter((deck) => !deck.deleted_at).length,

      cards: response.cards.filter((card) => !card.deleted_at).length,

      images: response.images.filter((image) => !image.deleted_at).length,
    };
  }

  private compareRemoteCreationOrder(
    createdA: string,

    idA: string,

    createdB: string,

    idB: string,
  ): number {
    const timeA = Date.parse(createdA);

    const timeB = Date.parse(createdB);

    if (timeA !== timeB) {
      return timeA - timeB;
    }

    return idA.localeCompare(idB);
  }

  private assertValidTimestamp(
    value: string,

    label: string,
  ): void {
    if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) {
      throw new Error(`Server bootstrap payload contains invalid ${label}.`);
    }
  }

  // -------------------------------------------------
  // Upload-local bootstrap
  // -------------------------------------------------

  private async bootstrapUploadLocal(
    requestedMode: 'upload-local' | 'resume-local-upload',
  ): Promise<BootstrapExecutionResult> {
    await this.state.whenReady();

    const auth = await this.syncStorage.getDeviceAuth();

    if (!auth?.token) {
      throw new Error('This device is not registered with the sync server.');
    }

    const initialState = this.state.getState();

    if (!this.localStateHasData(initialState)) {
      throw new Error('Local-first bootstrap requires local flashcard data.');
    }

    const indexes = this.buildLocalIndexes(initialState);

    await this.ensureLocalBootstrapMetadata(initialState, indexes);

    this.assertLocalStateUnchanged(initialState);

    const serverBefore = await this.syncApi.pull(0, auth.token);

    this.validatePullResponse(serverBefore, 0);

    const imageCache = new Map<string, CachedLocalImage>();

    const adopted = await this.reconcileExistingBootstrapData(
      initialState,
      indexes,
      serverBefore,
      imageCache,
    );

    this.assertLocalStateUnchanged(initialState);

    const uploaded = this.emptyTransferCounts();

    await this.uploadBootstrapDecks(initialState, auth.token, uploaded, adopted);

    await this.uploadBootstrapCards(initialState, auth.token, uploaded, adopted);

    await this.uploadBootstrapImages(initialState, auth.token, uploaded, adopted, imageCache);

    this.assertLocalStateUnchanged(initialState);

    const finalPull = await this.syncApi.pull(0, auth.token);

    this.validatePullResponse(finalPull, 0);

    await this.verifyCompleteRemoteDataset(initialState, finalPull, imageCache);

    this.assertLocalStateUnchanged(initialState);

    const completedAt = new Date().toISOString();

    const finalizedMeta = await this.finalizeLocalBootstrap(initialState, finalPull, completedAt);

    return {
      status: requestedMode === 'resume-local-upload' ? 'resumed-local-upload' : 'uploaded-local',

      mode: requestedMode,

      initialized: finalizedMeta.initialized,

      serverRevision: finalizedMeta.serverRevision,

      lastSuccessfulSyncAt: finalizedMeta.lastSuccessfulSyncAt,

      uploaded,

      adopted,

      downloaded: this.emptyTransferCounts(),

      changedLocalMetadata: true,

      changedLocalState: false,

      changedServerData: uploaded.decks > 0 || uploaded.cards > 0 || uploaded.images > 0,
    };
  }

  // -------------------------------------------------
  // Bootstrap metadata preparation
  // -------------------------------------------------

  private async ensureLocalBootstrapMetadata(
    localState: LocalState,

    indexes: LocalIndexes,
  ): Promise<void> {
    await this.syncStorage.updateSyncMeta((meta) => {
      if (meta.initialized) {
        throw new Error(
          'Local-first bootstrap cannot run because this client is already initialized.',
        );
      }

      if (meta.serverRevision !== 0) {
        throw new Error(
          `Uninitialized bootstrap expected global cursor 0, found ${meta.serverRevision}.`,
        );
      }

      this.assertNoExtraBootstrapMetadata(meta, indexes);

      for (const deck of localState.decks) {
        this.ensureBootstrapEntityRecord(meta.decks, deck.id);

        for (const card of deck.cards) {
          this.ensureBootstrapEntityRecord(meta.cards, card.id);

          for (const image of card.front.images) {
            this.ensureBootstrapEntityRecord(meta.images, image.id);
          }

          for (const image of card.back.images) {
            this.ensureBootstrapEntityRecord(meta.images, image.id);
          }
        }
      }
    });
  }

  private ensureBootstrapEntityRecord<TSnapshot>(
    map: Record<string, EntitySyncRecord<TSnapshot>>,

    entityId: string,
  ): void {
    const record = map[entityId];

    if (!record) {
      map[entityId] = {
        revision: 0,

        baseRevision: 0,

        pendingOperation: 'create',

        lastSyncedSnapshot: null,

        conflict: null,
      };

      return;
    }

    if (record.conflict) {
      throw new Error(`Bootstrap entity "${entityId}" already has an unresolved conflict.`);
    }

    if (record.pendingOperation === 'create') {
      if (
        record.revision !== 0 ||
        record.baseRevision !== 0 ||
        record.lastSyncedSnapshot !== null
      ) {
        throw new Error(`Bootstrap create metadata for "${entityId}" is inconsistent.`);
      }

      return;
    }

    if (record.pendingOperation === null) {
      if (
        record.revision <= 0 ||
        record.baseRevision !== record.revision ||
        record.lastSyncedSnapshot === null
      ) {
        throw new Error(`Bootstrap clean metadata for "${entityId}" is inconsistent.`);
      }

      return;
    }

    throw new Error(
      `Bootstrap cannot continue because "${entityId}" has pending operation "${record.pendingOperation}".`,
    );
  }

  private assertNoExtraBootstrapMetadata(
    meta: StoredSyncMeta,

    indexes: LocalIndexes,
  ): void {
    for (const id of Object.keys(meta.decks)) {
      if (!indexes.decks.has(id)) {
        throw new Error(
          `Bootstrap metadata contains deck "${id}", but that deck is absent locally.`,
        );
      }
    }

    for (const id of Object.keys(meta.cards)) {
      if (!indexes.cards.has(id)) {
        throw new Error(
          `Bootstrap metadata contains card "${id}", but that card is absent locally.`,
        );
      }
    }

    for (const id of Object.keys(meta.images)) {
      if (!indexes.images.has(id)) {
        throw new Error(
          `Bootstrap metadata contains image "${id}", but that image is absent locally.`,
        );
      }
    }
  }

  // -------------------------------------------------
  // Interrupted local-first bootstrap reconciliation
  // -------------------------------------------------

  private async reconcileExistingBootstrapData(
    localState: LocalState,

    indexes: LocalIndexes,

    response: PullResponse,

    imageCache: Map<string, CachedLocalImage>,
  ): Promise<BootstrapTransferCounts> {
    const adopted = this.emptyTransferCounts();

    if (
      response.decks.some((deck) => !!deck.deleted_at) ||
      response.cards.some((card) => !!card.deleted_at) ||
      response.images.some((image) => !!image.deleted_at)
    ) {
      throw new Error('Local-first bootstrap found server tombstones. Automatic resume is unsafe.');
    }

    for (const remoteDeck of response.decks) {
      const localDeck = indexes.decks.get(remoteDeck.id);

      if (!localDeck) {
        throw new Error(`Server contains unexpected deck "${remoteDeck.id}".`);
      }

      const snapshot = this.deckSnapshot(localDeck);

      if (!this.remoteDeckMatchesSnapshot(remoteDeck, snapshot)) {
        throw new Error(
          `Server deck "${remoteDeck.id}" does not match the local bootstrap dataset.`,
        );
      }

      if (await this.acknowledgeDeckRevision(snapshot, remoteDeck)) {
        adopted.decks += 1;
      }
    }

    for (const remoteCard of response.cards) {
      const localEntry = indexes.cards.get(remoteCard.id);

      if (!localEntry) {
        throw new Error(`Server contains unexpected card "${remoteCard.id}".`);
      }

      const snapshot = this.cardSnapshot(localEntry.deckId, localEntry.card);

      if (!this.remoteCardMatchesSnapshot(remoteCard, snapshot)) {
        throw new Error(
          `Server card "${remoteCard.id}" does not match the local bootstrap dataset.`,
        );
      }

      if (await this.acknowledgeCardRevision(snapshot, remoteCard)) {
        adopted.cards += 1;
      }
    }

    for (const remoteImage of response.images) {
      const localEntry = indexes.images.get(remoteImage.id);

      if (!localEntry) {
        throw new Error(`Server contains unexpected image "${remoteImage.id}".`);
      }

      const snapshot = this.imageSnapshot(localEntry);

      if (!this.remoteImageMatchesSnapshot(remoteImage, snapshot)) {
        throw new Error(
          `Server image "${remoteImage.id}" metadata does not match the local bootstrap dataset.`,
        );
      }

      const localImageData = await this.getCachedLocalImage(localEntry, imageCache);

      if (!remoteImage.sha256 || remoteImage.sha256.toLowerCase() !== localImageData.sha256) {
        throw new Error(`Server image "${remoteImage.id}" does not match the local image bytes.`);
      }

      if (await this.acknowledgeImageRevision(snapshot, remoteImage)) {
        adopted.images += 1;
      }
    }

    this.assertLocalStateUnchanged(localState);

    return adopted;
  }

  // -------------------------------------------------
  // Upload decks
  // -------------------------------------------------

  private async uploadBootstrapDecks(
    localState: LocalState,

    token: string,

    uploaded: BootstrapTransferCounts,

    adopted: BootstrapTransferCounts,
  ): Promise<void> {
    for (const deck of localState.decks) {
      this.assertLocalStateUnchanged(localState);

      const meta = await this.syncStorage.getSyncMeta();

      const record = meta.decks[deck.id];

      if (!record) {
        throw new Error(`Missing bootstrap metadata for deck "${deck.id}".`);
      }

      if (record.pendingOperation === null) {
        continue;
      }

      if (record.pendingOperation !== 'create') {
        throw new Error(`Deck "${deck.id}" is no longer a bootstrap create.`);
      }

      const snapshot = this.deckSnapshot(deck);

      const response = await this.syncApi.pushDeck(
        {
          operation: 'create',

          base_revision: 0,

          deck: {
            id: snapshot.id,

            name: snapshot.name,

            description: snapshot.description,
          },
        },

        token,
      );

      this.assertLocalStateUnchanged(localState);

      if (response.status === 'applied') {
        if (!response.deck || !this.remoteDeckMatchesSnapshot(response.deck, snapshot)) {
          throw new Error(`Server returned invalid applied deck "${deck.id}".`);
        }

        await this.acknowledgeDeckRevision(snapshot, response.deck);

        uploaded.decks += 1;

        continue;
      }

      const remote = response.conflict?.server;

      if (!remote || !this.remoteDeckMatchesSnapshot(remote, snapshot)) {
        throw new Error(
          `Bootstrap create conflict for deck "${deck.id}" does not match the local deck.`,
        );
      }

      await this.acknowledgeDeckRevision(snapshot, remote);

      adopted.decks += 1;
    }
  }

  // -------------------------------------------------
  // Upload cards
  // -------------------------------------------------

  private async uploadBootstrapCards(
    localState: LocalState,

    token: string,

    uploaded: BootstrapTransferCounts,

    adopted: BootstrapTransferCounts,
  ): Promise<void> {
    for (const deck of localState.decks) {
      for (const card of deck.cards) {
        this.assertLocalStateUnchanged(localState);

        const meta = await this.syncStorage.getSyncMeta();

        const record = meta.cards[card.id];

        if (!record) {
          throw new Error(`Missing bootstrap metadata for card "${card.id}".`);
        }

        if (record.pendingOperation === null) {
          continue;
        }

        if (record.pendingOperation !== 'create') {
          throw new Error(`Card "${card.id}" is no longer a bootstrap create.`);
        }

        const snapshot = this.cardSnapshot(deck.id, card);

        const response = await this.syncApi.pushCard(
          {
            operation: 'create',

            base_revision: 0,

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

        this.assertLocalStateUnchanged(localState);

        if (response.status === 'applied') {
          if (!response.card || !this.remoteCardMatchesSnapshot(response.card, snapshot)) {
            throw new Error(`Server returned invalid applied card "${card.id}".`);
          }

          await this.acknowledgeCardRevision(snapshot, response.card);

          uploaded.cards += 1;

          continue;
        }

        const remote = response.conflict?.server;

        if (!remote || !this.remoteCardMatchesSnapshot(remote, snapshot)) {
          throw new Error(
            `Bootstrap create conflict for card "${card.id}" does not match the local card.`,
          );
        }

        await this.acknowledgeCardRevision(snapshot, remote);

        adopted.cards += 1;
      }
    }
  }

  // -------------------------------------------------
  // Upload images
  // -------------------------------------------------

  private async uploadBootstrapImages(
    localState: LocalState,

    token: string,

    uploaded: BootstrapTransferCounts,

    adopted: BootstrapTransferCounts,

    imageCache: Map<string, CachedLocalImage>,
  ): Promise<void> {
    const indexes = this.buildLocalIndexes(localState);

    for (const entry of indexes.images.values()) {
      this.assertLocalStateUnchanged(localState);

      const meta = await this.syncStorage.getSyncMeta();

      const record = meta.images[entry.image.id];

      if (!record) {
        throw new Error(`Missing bootstrap metadata for image "${entry.image.id}".`);
      }

      if (record.pendingOperation === null) {
        continue;
      }

      if (record.pendingOperation !== 'create') {
        throw new Error(`Image "${entry.image.id}" is no longer a bootstrap create.`);
      }

      const snapshot = this.imageSnapshot(entry);

      const localImage = await this.getCachedLocalImage(entry, imageCache);

      try {
        const remote = await this.syncApi.uploadImage(
          {
            id: snapshot.id,

            cardId: snapshot.cardId,

            side: snapshot.side,

            position: snapshot.position,

            blob: localImage.blob,

            fileName: localImage.fileName,
          },

          token,
        );

        this.assertLocalStateUnchanged(localState);

        if (
          !this.remoteImageMatchesSnapshot(remote, snapshot) ||
          !remote.sha256 ||
          remote.sha256.toLowerCase() !== localImage.sha256
        ) {
          throw new Error(`Server returned invalid uploaded image "${snapshot.id}".`);
        }

        await this.acknowledgeImageRevision(snapshot, remote);

        uploaded.images += 1;
      } catch (error) {
        if (!(error instanceof SyncApiError) || error.status !== 409) {
          throw error;
        }

        const recoveryPull = await this.syncApi.pull(0, token);

        this.validatePullResponse(recoveryPull, 0);

        const remote = recoveryPull.images.find((candidate) => candidate.id === snapshot.id);

        if (
          !remote ||
          !!remote.deleted_at ||
          !this.remoteImageMatchesSnapshot(remote, snapshot) ||
          !remote.sha256 ||
          remote.sha256.toLowerCase() !== localImage.sha256
        ) {
          throw new Error(
            `Image "${snapshot.id}" already exists on the server, but it cannot be proven identical to the local image.`,
          );
        }

        this.assertLocalStateUnchanged(localState);

        await this.acknowledgeImageRevision(snapshot, remote);

        adopted.images += 1;
      }
    }
  }

  // -------------------------------------------------
  // Final local-first verification
  // -------------------------------------------------

  private async verifyCompleteRemoteDataset(
    localState: LocalState,

    response: PullResponse,

    imageCache: Map<string, CachedLocalImage>,
  ): Promise<void> {
    if (
      response.decks.some((deck) => !!deck.deleted_at) ||
      response.cards.some((card) => !!card.deleted_at) ||
      response.images.some((image) => !!image.deleted_at)
    ) {
      throw new Error('Final bootstrap verification found server tombstones.');
    }

    const indexes = this.buildLocalIndexes(localState);

    if (response.decks.length !== indexes.decks.size) {
      throw new Error(
        `Final bootstrap deck count mismatch: local ${indexes.decks.size}, server ${response.decks.length}.`,
      );
    }

    if (response.cards.length !== indexes.cards.size) {
      throw new Error(
        `Final bootstrap card count mismatch: local ${indexes.cards.size}, server ${response.cards.length}.`,
      );
    }

    if (response.images.length !== indexes.images.size) {
      throw new Error(
        `Final bootstrap image count mismatch: local ${indexes.images.size}, server ${response.images.length}.`,
      );
    }

    for (const remoteDeck of response.decks) {
      const local = indexes.decks.get(remoteDeck.id);

      if (!local || !this.remoteDeckMatchesSnapshot(remoteDeck, this.deckSnapshot(local))) {
        throw new Error(`Final bootstrap verification failed for deck "${remoteDeck.id}".`);
      }
    }

    for (const remoteCard of response.cards) {
      const local = indexes.cards.get(remoteCard.id);

      if (
        !local ||
        !this.remoteCardMatchesSnapshot(remoteCard, this.cardSnapshot(local.deckId, local.card))
      ) {
        throw new Error(`Final bootstrap verification failed for card "${remoteCard.id}".`);
      }
    }

    for (const remoteImage of response.images) {
      const local = indexes.images.get(remoteImage.id);

      if (!local) {
        throw new Error(`Final bootstrap verification found unexpected image "${remoteImage.id}".`);
      }

      const snapshot = this.imageSnapshot(local);

      if (!this.remoteImageMatchesSnapshot(remoteImage, snapshot)) {
        throw new Error(`Final bootstrap image metadata mismatch for "${remoteImage.id}".`);
      }

      const localImage = await this.getCachedLocalImage(local, imageCache);

      if (!remoteImage.sha256 || remoteImage.sha256.toLowerCase() !== localImage.sha256) {
        throw new Error(`Final bootstrap image SHA-256 mismatch for "${remoteImage.id}".`);
      }
    }
  }

  private async finalizeLocalBootstrap(
    localState: LocalState,

    finalPull: PullResponse,

    completedAt: string,
  ): Promise<StoredSyncMeta> {
    const remoteDecks = new Map(finalPull.decks.map((deck) => [deck.id, deck]));

    const remoteCards = new Map(finalPull.cards.map((card) => [card.id, card]));

    const remoteImages = new Map(finalPull.images.map((image) => [image.id, image]));

    return this.syncStorage.updateSyncMeta((meta) => {
      if (meta.initialized) {
        throw new Error('Bootstrap finalization found an already initialized client.');
      }

      if (meta.serverRevision !== 0) {
        throw new Error(
          `Bootstrap finalization expected global cursor 0, found ${meta.serverRevision}.`,
        );
      }

      const indexes = this.buildLocalIndexes(localState);

      this.assertNoExtraBootstrapMetadata(meta, indexes);

      for (const deck of localState.decks) {
        const remote = remoteDecks.get(deck.id);

        if (!remote) {
          throw new Error(`Bootstrap finalization is missing remote deck "${deck.id}".`);
        }

        this.assertFinalCleanRecord(
          meta.decks[deck.id],
          remote.revision,
          this.deckSnapshot(deck),
          (a, b) => this.deckSnapshotsEqual(a, b),
          deck.id,
        );

        for (const card of deck.cards) {
          const remoteCard = remoteCards.get(card.id);

          if (!remoteCard) {
            throw new Error(`Bootstrap finalization is missing remote card "${card.id}".`);
          }

          this.assertFinalCleanRecord(
            meta.cards[card.id],
            remoteCard.revision,
            this.cardSnapshot(deck.id, card),
            (a, b) => this.cardSnapshotsEqual(a, b),
            card.id,
          );
        }
      }

      for (const [imageId, entry] of indexes.images) {
        const remote = remoteImages.get(imageId);

        if (!remote) {
          throw new Error(`Bootstrap finalization is missing remote image "${imageId}".`);
        }

        this.assertFinalCleanRecord(
          meta.images[imageId],
          remote.revision,
          this.imageSnapshot(entry),
          (a, b) => this.imageSnapshotsEqual(a, b),
          imageId,
        );
      }

      meta.initialized = true;

      meta.serverRevision = finalPull.server_revision;

      meta.lastSuccessfulSyncAt = completedAt;
    });
  }

  // -------------------------------------------------
  // Revision acknowledgement
  // -------------------------------------------------

  private async acknowledgeDeckRevision(
    snapshot: DeckSyncSnapshot,

    remote: ApiDeck,
  ): Promise<boolean> {
    let changed = false;

    await this.syncStorage.updateSyncMeta((meta) => {
      changed = this.acceptServerRevision(
        meta.decks,
        snapshot.id,
        remote.revision,
        snapshot,
        (a, b) => this.deckSnapshotsEqual(a, b),
      );
    });

    return changed;
  }

  private async acknowledgeCardRevision(
    snapshot: CardSyncSnapshot,

    remote: ApiCard,
  ): Promise<boolean> {
    let changed = false;

    await this.syncStorage.updateSyncMeta((meta) => {
      changed = this.acceptServerRevision(
        meta.cards,
        snapshot.id,
        remote.revision,
        snapshot,
        (a, b) => this.cardSnapshotsEqual(a, b),
      );
    });

    return changed;
  }

  private async acknowledgeImageRevision(
    snapshot: ImageSyncSnapshot,

    remote: ApiCardImage,
  ): Promise<boolean> {
    let changed = false;

    await this.syncStorage.updateSyncMeta((meta) => {
      changed = this.acceptServerRevision(
        meta.images,
        snapshot.id,
        remote.revision,
        snapshot,
        (a, b) => this.imageSnapshotsEqual(a, b),
      );
    });

    return changed;
  }

  private acceptServerRevision<TSnapshot>(
    map: Record<string, EntitySyncRecord<TSnapshot>>,

    entityId: string,

    remoteRevision: number,

    snapshot: TSnapshot,

    snapshotsEqual: (a: TSnapshot, b: TSnapshot) => boolean,
  ): boolean {
    const record = map[entityId];

    if (!record) {
      throw new Error(`Cannot acknowledge "${entityId}" because its sync metadata is missing.`);
    }

    if (record.conflict) {
      throw new Error(`Cannot acknowledge "${entityId}" because it has an unresolved conflict.`);
    }

    if (record.pendingOperation === null) {
      if (
        record.revision !== remoteRevision ||
        record.baseRevision !== remoteRevision ||
        !record.lastSyncedSnapshot ||
        !snapshotsEqual(record.lastSyncedSnapshot, snapshot)
      ) {
        throw new Error(
          `Clean bootstrap metadata for "${entityId}" does not match server revision ${remoteRevision}.`,
        );
      }

      return false;
    }

    if (
      record.pendingOperation !== 'create' ||
      record.revision !== 0 ||
      record.baseRevision !== 0 ||
      record.lastSyncedSnapshot !== null
    ) {
      throw new Error(
        `Cannot acknowledge "${entityId}" because its bootstrap create metadata is inconsistent.`,
      );
    }

    record.revision = remoteRevision;

    record.baseRevision = remoteRevision;

    record.pendingOperation = null;

    record.lastSyncedSnapshot = this.clone(snapshot);

    record.conflict = null;

    return true;
  }

  private assertFinalCleanRecord<TSnapshot>(
    record: EntitySyncRecord<TSnapshot> | undefined,

    revision: number,

    snapshot: TSnapshot,

    snapshotsEqual: (a: TSnapshot, b: TSnapshot) => boolean,

    entityId: string,
  ): void {
    if (
      !record ||
      record.pendingOperation !== null ||
      record.conflict !== null ||
      record.revision !== revision ||
      record.baseRevision !== revision ||
      !record.lastSyncedSnapshot ||
      !snapshotsEqual(record.lastSyncedSnapshot, snapshot)
    ) {
      throw new Error(`Bootstrap finalization found non-clean metadata for "${entityId}".`);
    }
  }

  // -------------------------------------------------
  // Local image helpers
  // -------------------------------------------------

  private async getCachedLocalImage(
    entry: LocalImageEntry,

    cache: Map<string, CachedLocalImage>,
  ): Promise<CachedLocalImage> {
    const existing = cache.get(entry.image.id);

    if (existing) {
      return existing;
    }

    const blob = await this.dataUrlToBlob(entry.image.dataUrl);

    if (!this.isSupportedImageMimeType(blob.type)) {
      throw new Error(
        `Image "${entry.image.id}" has unsupported MIME type "${blob.type || 'unknown'}".`,
      );
    }

    const sha256 = await this.sha256Blob(blob);

    const extension = this.imageFileExtension(blob.type);

    const result: CachedLocalImage = {
      blob,

      sha256,

      fileName: `${entry.image.id}.${extension}`,
    };

    cache.set(entry.image.id, result);

    return result;
  }

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
      throw new Error('Web Crypto SHA-256 is not available in this browser.');
    }

    const bytes = await blob.arrayBuffer();

    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);

    return Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  }

  private isSupportedImageMimeType(mimeType: string): boolean {
    return (
      mimeType === 'image/png' ||
      mimeType === 'image/jpeg' ||
      mimeType === 'image/gif' ||
      mimeType === 'image/webp'
    );
  }

  private imageFileExtension(mimeType: string): string {
    switch (mimeType) {
      case 'image/png':
        return 'png';

      case 'image/jpeg':
        return 'jpg';

      case 'image/gif':
        return 'gif';

      case 'image/webp':
        return 'webp';

      default:
        throw new Error(`Unsupported image MIME type "${mimeType}".`);
    }
  }

  // -------------------------------------------------
  // Bootstrap classification
  // -------------------------------------------------

  private buildPreviewReport(
    localState: LocalState,

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
    localState: LocalState,

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
      if (this.syncMetaHasEntityRecords(meta)) {
        return {
          mode: 'blocked-mixed',

          safeToProceed: false,

          reason:
            'The local client and server are empty, but stale entity sync metadata exists on this uninitialized client.',

          localHasData,

          serverHasHistory,

          serverHasActiveData,

          resumableUploadDetected: false,
        };
      }

      return {
        mode: 'initialize-empty',

        safeToProceed: true,

        reason: 'Both the local client and the server are empty.',

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
      if (this.syncMetaHasEntityRecords(meta)) {
        return {
          mode: 'blocked-mixed',

          safeToProceed: false,

          reason:
            'The local client is empty, but stale entity sync metadata exists. Automatic server bootstrap is unsafe.',

          localHasData,

          serverHasHistory,

          serverHasActiveData,

          resumableUploadDetected: false,
        };
      }

      return {
        mode: 'download-server',

        safeToProceed: true,

        reason: 'The local client is empty and the server already has sync history.',

        localHasData,

        serverHasHistory,

        serverHasActiveData,

        resumableUploadDetected: false,
      };
    }

    const resumableUpload = this.isResumableLocalBootstrapCandidate(localState, meta, response);

    if (resumableUpload) {
      return {
        mode: 'resume-local-upload',

        safeToProceed: true,

        reason:
          'The server state is structurally consistent with an interrupted local-first bootstrap. Existing image bytes will be SHA-256 verified before they are adopted.',

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
        'Both local and server data exist on an uninitialized client, and the server state cannot be proven to belong to an interrupted local-first bootstrap.',

      localHasData,

      serverHasHistory,

      serverHasActiveData,

      resumableUploadDetected: false,
    };
  }

  private isResumableLocalBootstrapCandidate(
    localState: LocalState,

    meta: StoredSyncMeta,

    response: PullResponse,
  ): boolean {
    if (
      response.decks.some((deck) => !!deck.deleted_at) ||
      response.cards.some((card) => !!card.deleted_at) ||
      response.images.some((image) => !!image.deleted_at)
    ) {
      return false;
    }

    let indexes: LocalIndexes;

    try {
      indexes = this.buildLocalIndexes(localState);
    } catch {
      return false;
    }

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

    for (const remote of response.decks) {
      const local = indexes.decks.get(remote.id);

      if (!local) {
        return false;
      }

      const snapshot = this.deckSnapshot(local);

      if (
        !this.remoteDeckMatchesSnapshot(remote, snapshot) ||
        !this.bootstrapRecordMatchesRemote(
          meta.decks[remote.id],
          remote.revision,
          snapshot,
          (a, b) => this.deckSnapshotsEqual(a, b),
        )
      ) {
        return false;
      }
    }

    for (const remote of response.cards) {
      const local = indexes.cards.get(remote.id);

      if (!local) {
        return false;
      }

      const snapshot = this.cardSnapshot(local.deckId, local.card);

      if (
        !this.remoteCardMatchesSnapshot(remote, snapshot) ||
        !this.bootstrapRecordMatchesRemote(
          meta.cards[remote.id],
          remote.revision,
          snapshot,
          (a, b) => this.cardSnapshotsEqual(a, b),
        )
      ) {
        return false;
      }
    }

    for (const remote of response.images) {
      const local = indexes.images.get(remote.id);

      if (!local) {
        return false;
      }

      const snapshot = this.imageSnapshot(local);

      if (
        !remote.sha256 ||
        !this.remoteImageMatchesSnapshot(remote, snapshot) ||
        !this.bootstrapRecordMatchesRemote(
          meta.images[remote.id],
          remote.revision,
          snapshot,
          (a, b) => this.imageSnapshotsEqual(a, b),
        )
      ) {
        return false;
      }
    }

    return response.decks.length > 0 || response.cards.length > 0 || response.images.length > 0;
  }

  private bootstrapRecordMatchesRemote<TSnapshot>(
    record: EntitySyncRecord<TSnapshot> | undefined,

    remoteRevision: number,

    localSnapshot: TSnapshot,

    snapshotsEqual: (a: TSnapshot, b: TSnapshot) => boolean,
  ): boolean {
    if (!record || record.conflict) {
      return false;
    }

    if (record.pendingOperation === 'create') {
      return (
        record.revision === 0 && record.baseRevision === 0 && record.lastSyncedSnapshot === null
      );
    }

    if (record.pendingOperation === null) {
      return (
        record.revision === remoteRevision &&
        record.baseRevision === remoteRevision &&
        record.lastSyncedSnapshot !== null &&
        snapshotsEqual(record.lastSyncedSnapshot, localSnapshot)
      );
    }

    return false;
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

  // -------------------------------------------------
  // Preview individual entities
  // -------------------------------------------------

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

          reason: 'A local entity with the same ID exists but has no known server ancestry.',
        };
      }

      if (deleted) {
        return {
          ...base,

          action: 'would-record-tombstone',

          reason: 'The server reports a deleted entity that is already absent locally.',
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

  // -------------------------------------------------
  // Local graph
  // -------------------------------------------------

  private buildLocalIndexes(localState: LocalState): LocalIndexes {
    const decks = new Map<string, LocalDeck>();

    const cards = new Map<string, LocalCardEntry>();

    const images = new Map<string, LocalImageEntry>();

    for (const deck of localState.decks) {
      if (decks.has(deck.id)) {
        throw new Error(`Duplicate local deck ID "${deck.id}".`);
      }

      decks.set(deck.id, deck);

      for (const card of deck.cards) {
        if (cards.has(card.id)) {
          throw new Error(`Duplicate local card ID "${card.id}".`);
        }

        cards.set(card.id, {
          deckId: deck.id,

          card,
        });

        card.front.images.forEach((image, position) => {
          this.addLocalImageIndex(images, {
            cardId: card.id,

            side: 'front',

            position,

            image,
          });
        });

        card.back.images.forEach((image, position) => {
          this.addLocalImageIndex(images, {
            cardId: card.id,

            side: 'back',

            position,

            image,
          });
        });
      }
    }

    return {
      decks,
      cards,
      images,
    };
  }

  private addLocalImageIndex(
    images: Map<string, LocalImageEntry>,

    entry: LocalImageEntry,
  ): void {
    if (images.has(entry.image.id)) {
      throw new Error(`Duplicate local image ID "${entry.image.id}".`);
    }

    images.set(entry.image.id, entry);
  }

  private assertLocalStateUnchanged(expected: LocalState): void {
    const current = this.state.getState();

    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(
        'Local flashcard data changed while bootstrap was running. Bootstrap stopped.',
      );
    }
  }

  private localStateHasData(localState: LocalState): boolean {
    return localState.decks.length > 0;
  }

  private syncMetaHasEntityRecords(meta: StoredSyncMeta): boolean {
    return (
      Object.keys(meta.decks).length > 0 ||
      Object.keys(meta.cards).length > 0 ||
      Object.keys(meta.images).length > 0
    );
  }

  // -------------------------------------------------
  // Snapshots
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

  private imageSnapshot(entry: LocalImageEntry): ImageSyncSnapshot {
    return {
      id: entry.image.id,

      cardId: entry.cardId,

      side: entry.side,

      position: entry.position,
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

  // -------------------------------------------------
  // Remote/local comparisons
  // -------------------------------------------------

  private remoteDeckMatchesSnapshot(
    remote: ApiDeck,

    local: DeckSyncSnapshot,
  ): boolean {
    return (
      !remote.deleted_at &&
      remote.id === local.id &&
      remote.name === local.name &&
      (remote.description ?? undefined) === (local.description ?? undefined)
    );
  }

  private remoteCardMatchesSnapshot(
    remote: ApiCard,

    local: CardSyncSnapshot,
  ): boolean {
    return (
      !remote.deleted_at &&
      remote.id === local.id &&
      remote.deck_id === local.deckId &&
      remote.front_text === local.frontText &&
      remote.back_text === local.backText &&
      remote.difficulty === local.difficulty &&
      this.timestampsEqual(remote.last_reviewed_at ?? null, local.lastReviewedAt)
    );
  }

  private remoteImageMatchesSnapshot(
    remote: ApiCardImage,

    local: ImageSyncSnapshot,
  ): boolean {
    return (
      !remote.deleted_at &&
      remote.id === local.id &&
      remote.card_id === local.cardId &&
      remote.side === local.side &&
      remote.position === local.position
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
  // Pull validation
  // -------------------------------------------------

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

  // -------------------------------------------------
  // Helpers
  // -------------------------------------------------

  private emptyTransferCounts(): BootstrapTransferCounts {
    return {
      decks: 0,

      cards: 0,

      images: 0,
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
