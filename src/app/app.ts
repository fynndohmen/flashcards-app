// src/app/app.ts
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  CardImageContent,
  CardSideContent,
  Deck,
  DifficultyLevel,
  Flashcard,
  FlashcardsState,
} from './models';
import { FlashcardsStateService } from './flashcards-state.service';
import { SyncApiError, SyncApiService } from './sync-api.service';
import { PullPreviewReport, SyncEngineService } from './sync-engine.service';
import { StoredDeviceAuth, SyncStorageService } from './sync-storage.service';
import {
  CardSyncSnapshot,
  DeckSyncSnapshot,
  ImageSyncSnapshot,
  StoredSyncMeta,
  SyncConflictRecord,
  SyncEntityType,
} from './sync-metadata.models';
import {
  ConflictResolutionEntityType,
  ConflictResolutionService,
} from './conflict-resolution.service';
import { SyncCycleService } from './sync-cycle.service';
type DeckViewMode = 'menu' | 'edit' | 'practice' | null;
type PracticeDifficultyFilter = 'all' | 'unrated' | number;
type SyncServerStatus = 'checking' | 'online' | 'offline';

interface ConflictDisplayField {
  label: string;
  base: string;
  local: string;
  server: string;
}

interface SyncConflictUiItem {
  key: string;
  entityType: SyncEntityType;
  entityId: string;
  title: string;
  detectedAt: string;
  baseRevision: number;
  serverRevision: number;
  localDeleted: boolean;
  serverDeleted: boolean;
  fields: ConflictDisplayField[];
  canResolve: boolean;
  unsupportedReason: string | null;
}

interface DeckMergeForm {
  name: string;
  description: string;
}

interface CardMergeForm {
  frontText: string;
  backText: string;
  difficulty: DifficultyLevel;
  lastReviewedAt: string;
}
type FlashcardsDebugGlobal = typeof globalThis & {
  flashcardsSyncPreview?: () => Promise<PullPreviewReport>;
};
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
    frontImages: [] as CardImageContent[],
    backText: '',
    backImages: [] as CardImageContent[],
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

  isSyncing = false;
  syncActionMessage = '';
  syncActionError = '';

  bootstrapPreview: PullPreviewReport | null = null;
  isAssessingBootstrap = false;
  isDownloadingInitialData = false;
  bootstrapAssessmentError = '';

  syncMetaInitialized = false;
  syncServerRevision = 0;
  syncLastSuccessfulAt: string | null = null;
  syncPendingOperationCount = 0;

  syncConflicts: SyncConflictUiItem[] = [];

  resolvingConflictKey: string | null = null;

  deckMergeForms: Record<string, DeckMergeForm> = {};
  cardMergeForms: Record<string, CardMergeForm> = {};

  readonly difficultyLevels: DifficultyLevel[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  constructor(
    private state: FlashcardsStateService,
    private syncApi: SyncApiService,
    private syncStorage: SyncStorageService,
    private syncEngine: SyncEngineService,

    private syncCycle: SyncCycleService,

    private conflictResolution: ConflictResolutionService,
  ) {
    this.installLocalDebugHelpers();
    void this.initializeApp();
  }
  private installLocalDebugHelpers(): void {
    const isLocalDevelopment =
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isLocalDevelopment) {
      return;
    }
    const debugGlobal = globalThis as FlashcardsDebugGlobal;
    debugGlobal.flashcardsSyncPreview = () => this.syncEngine.previewPullAndLog();
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
  // -------------------------------------------------
  // Sync enrollment
  // -------------------------------------------------
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
    await this.refreshSyncState();
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

      await this.refreshSyncState();
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
      return `${error.message} ` + `(HTTP ${error.status})`;
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
  // -------------------------------------------------
  // Sync runtime / conflict UI
  // -------------------------------------------------

  async refreshSyncState(): Promise<void> {
    try {
      const meta = await this.syncStorage.getSyncMeta();

      this.applySyncMetaToUi(meta);

      if (meta.initialized) {
        this.bootstrapPreview = null;
        this.bootstrapAssessmentError = '';
      } else {
        await this.refreshBootstrapAssessment();
      }
    } catch (err) {
      console.error('Failed to refresh sync metadata', err);

      this.syncActionError = 'Could not read the local sync state.';
    }
  }

  async refreshBootstrapAssessment(): Promise<void> {
    if (
      this.syncMetaInitialized ||
      !this.isDeviceRegistered ||
      this.syncServerStatus !== 'online' ||
      this.isDownloadingInitialData
    ) {
      this.bootstrapPreview = null;
      this.bootstrapAssessmentError = '';
      return;
    }

    this.isAssessingBootstrap = true;
    this.bootstrapAssessmentError = '';

    try {
      this.bootstrapPreview = await this.syncEngine.previewPull();
    } catch (err) {
      console.error('Initial sync assessment failed', err);
      this.bootstrapPreview = null;
      this.bootstrapAssessmentError = this.describeSyncActionError(err);
    } finally {
      this.isAssessingBootstrap = false;
    }
  }

  async downloadInitialData(): Promise<void> {
    this.syncActionMessage = '';
    this.syncActionError = '';
    this.bootstrapAssessmentError = '';

    if (!this.isDeviceRegistered) {
      this.syncActionError = 'Register this device before downloading sync data.';
      return;
    }

    if (this.syncServerStatus !== 'online') {
      this.syncActionError = 'The home sync server is currently not reachable.';
      return;
    }

    if (this.syncMetaInitialized) {
      this.syncActionError = 'This device is already initialized. Use Sync now instead.';
      return;
    }

    this.isDownloadingInitialData = true;

    try {
      const preview = await this.syncEngine.previewPull();

      this.bootstrapPreview = preview;

      if (!preview.bootstrap.safeToProceed || preview.bootstrap.mode !== 'download-server') {
        throw new Error(
          `Initial server download is not available in the current state: ${preview.bootstrap.reason}`,
        );
      }

      if (preview.local.decks !== 0 || preview.local.cards !== 0 || preview.local.images !== 0) {
        throw new Error(
          'Initial server download requires an empty local flashcard state. Local data was detected.',
        );
      }

      const result = await this.syncEngine.bootstrap();

      if (result.status !== 'downloaded-server' && result.status !== 'already-initialized') {
        throw new Error(
          `Initial setup changed unexpectedly and finished as "${result.status}".`,
        );
      }

      this.reloadDecks();

      await this.refreshSyncState();

      if (result.status === 'downloaded-server') {
        this.syncActionMessage =
          `Initial download complete: ${result.downloaded.decks} deck(s), ` +
          `${result.downloaded.cards} card(s), ${result.downloaded.images} image(s). ` +
          'Normal synchronization is ready.';
      } else {
        this.syncActionMessage = 'This device is already initialized and ready to synchronize.';
      }
    } catch (err) {
      console.error('Initial server download failed', err);
      this.syncActionError = this.describeSyncActionError(err);
    } finally {
      this.isDownloadingInitialData = false;
    }
  }

  async syncNow(): Promise<void> {
    this.syncActionMessage = '';
    this.syncActionError = '';

    if (!this.isDeviceRegistered) {
      this.syncActionError = 'Register this device before synchronizing.';

      return;
    }

    if (this.syncServerStatus !== 'online') {
      this.syncActionError = 'The home sync server is currently not reachable.';

      return;
    }

    this.isSyncing = true;

    try {
      const report = await this.syncCycle.syncOnce();

      this.reloadDecks();

      await this.refreshSyncState();

      if (report.unresolvedConflicts.total > 0) {
        this.syncActionMessage =
          `Sync finished at server revision ${report.serverRevisionAfter}. ` +
          `${report.unresolvedConflicts.total} conflict(s) still require a decision.`;
      } else if (report.pendingOperations.total > 0) {
        this.syncActionMessage =
          `Sync finished at server revision ${report.serverRevisionAfter}. ` +
          `${report.pendingOperations.total} local change(s) are still pending.`;
      } else {
        this.syncActionMessage = `Sync complete at server revision ${report.serverRevisionAfter}.`;
      }
    } catch (err) {
      console.error('Synchronization failed', err);

      this.syncActionError = this.describeSyncActionError(err);
    } finally {
      this.isSyncing = false;
    }
  }

  async resolveConflict(
    item: SyncConflictUiItem,
    choice: 'cloud' | 'this-device',
  ): Promise<void> {
    if (!item.canResolve || (item.entityType !== 'deck' && item.entityType !== 'card')) {
      return;
    }

    this.syncActionMessage = '';
    this.syncActionError = '';
    this.resolvingConflictKey = item.key;

    try {
      const entityType = item.entityType as ConflictResolutionEntityType;

      const result =
        choice === 'cloud'
          ? await this.conflictResolution.resolveWithCloud(entityType, item.entityId)
          : await this.conflictResolution.resolveWithThisDevice(entityType, item.entityId);

      this.reloadDecks();

      await this.refreshSyncState();

      this.syncActionMessage = result.requiresPush
        ? 'Conflict resolved. The selected local result is ready to be uploaded; run Sync now.'
        : 'Conflict resolved. The cloud version is now the clean local version.';
    } catch (err) {
      console.error('Conflict resolution failed', err);

      this.syncActionError = this.describeSyncActionError(err);
    } finally {
      this.resolvingConflictKey = null;
    }
  }

  async resolveDeckMerge(item: SyncConflictUiItem): Promise<void> {
    const form = this.deckMergeForms[item.entityId];

    if (!item.canResolve || item.entityType !== 'deck' || !form) {
      return;
    }

    this.syncActionMessage = '';
    this.syncActionError = '';
    this.resolvingConflictKey = item.key;

    try {
      const result = await this.conflictResolution.mergeDeck(item.entityId, {
        name: form.name,
        description: form.description.trim() || undefined,
      });

      this.reloadDecks();

      await this.refreshSyncState();

      this.syncActionMessage = result.requiresPush
        ? 'Merged deck saved locally. Run Sync now to upload the merged result.'
        : 'Merged deck already matches the cloud version; no upload is required.';
    } catch (err) {
      console.error('Deck merge failed', err);

      this.syncActionError = this.describeSyncActionError(err);
    } finally {
      this.resolvingConflictKey = null;
    }
  }

  async resolveCardMerge(item: SyncConflictUiItem): Promise<void> {
    const form = this.cardMergeForms[item.entityId];

    if (!item.canResolve || item.entityType !== 'card' || !form) {
      return;
    }

    this.syncActionMessage = '';
    this.syncActionError = '';
    this.resolvingConflictKey = item.key;

    try {
      const rawLastReviewedAt = form.lastReviewedAt.trim();

      if (rawLastReviewedAt && Number.isNaN(Date.parse(rawLastReviewedAt))) {
        throw new Error('Last reviewed must be a valid ISO date/time or left blank.');
      }

      const result = await this.conflictResolution.mergeCard(item.entityId, {
        frontText: form.frontText,
        backText: form.backText,
        difficulty: form.difficulty,
        lastReviewedAt: rawLastReviewedAt ? new Date(rawLastReviewedAt).toISOString() : null,
      });

      this.reloadDecks();

      await this.refreshSyncState();

      this.syncActionMessage = result.requiresPush
        ? 'Merged card saved locally. Run Sync now to upload the merged result.'
        : 'Merged card already matches the cloud version; no upload is required.';
    } catch (err) {
      console.error('Card merge failed', err);

      this.syncActionError = this.describeSyncActionError(err);
    } finally {
      this.resolvingConflictKey = null;
    }
  }

  isResolvingConflict(item: SyncConflictUiItem): boolean {
    return this.resolvingConflictKey === item.key;
  }

  private applySyncMetaToUi(meta: StoredSyncMeta): void {
    this.syncMetaInitialized = meta.initialized;
    this.syncServerRevision = meta.serverRevision;
    this.syncLastSuccessfulAt = meta.lastSuccessfulSyncAt;

    this.syncPendingOperationCount =
      this.countPendingOperations(meta.decks) +
      this.countPendingOperations(meta.cards) +
      this.countPendingOperations(meta.images);

    this.syncConflicts = this.buildConflictItems(meta);

    this.rebuildMergeForms(meta);
  }

  private countPendingOperations(
    records: Record<string, { pendingOperation: unknown }>,
  ): number {
    return Object.values(records).filter((record) => record.pendingOperation !== null).length;
  }

  private buildConflictItems(meta: StoredSyncMeta): SyncConflictUiItem[] {
    const items: SyncConflictUiItem[] = [];

    for (const [entityId, record] of Object.entries(meta.decks)) {
      if (record.conflict) {
        items.push(this.buildDeckConflictItem(entityId, record.conflict));
      }
    }

    for (const [entityId, record] of Object.entries(meta.cards)) {
      if (record.conflict) {
        items.push(this.buildCardConflictItem(entityId, record.conflict));
      }
    }

    for (const [entityId, record] of Object.entries(meta.images)) {
      if (record.conflict) {
        items.push(this.buildImageConflictItem(entityId, record.conflict));
      }
    }

    return items.sort((a, b) => a.detectedAt.localeCompare(b.detectedAt));
  }

  private buildDeckConflictItem(
    entityId: string,
    conflict: SyncConflictRecord<DeckSyncSnapshot>,
  ): SyncConflictUiItem {
    const base = conflict.base;
    const local = conflict.local;
    const server = conflict.server;

    const canResolve =
      !conflict.localDeleted &&
      !conflict.serverDeleted &&
      local !== null &&
      server !== null;

    return {
      key: `deck:${entityId}`,
      entityType: 'deck',
      entityId,
      title: local?.name || server?.name || `Deck ${this.shortId(entityId)}`,
      detectedAt: conflict.detectedAt,
      baseRevision: conflict.baseRevision,
      serverRevision: conflict.serverRevision,
      localDeleted: conflict.localDeleted,
      serverDeleted: conflict.serverDeleted,
      fields: [
        {
          label: 'Name',
          base: this.displaySyncValue(base?.name),
          local: this.displaySyncValue(local?.name),
          server: this.displaySyncValue(server?.name),
        },
        {
          label: 'Description',
          base: this.displaySyncValue(base?.description),
          local: this.displaySyncValue(local?.description),
          server: this.displaySyncValue(server?.description),
        },
      ],
      canResolve,
      unsupportedReason: canResolve
        ? null
        : 'Delete conflicts need parent/child restoration semantics and are not resolvable in the UI yet.',
    };
  }

  private buildCardConflictItem(
    entityId: string,
    conflict: SyncConflictRecord<CardSyncSnapshot>,
  ): SyncConflictUiItem {
    const base = conflict.base;
    const local = conflict.local;
    const server = conflict.server;

    const canResolve =
      !conflict.localDeleted &&
      !conflict.serverDeleted &&
      local !== null &&
      server !== null;

    const preview = local?.frontText || server?.frontText || base?.frontText || this.shortId(entityId);

    return {
      key: `card:${entityId}`,
      entityType: 'card',
      entityId,
      title: `Card: ${this.shortText(preview, 72)}`,
      detectedAt: conflict.detectedAt,
      baseRevision: conflict.baseRevision,
      serverRevision: conflict.serverRevision,
      localDeleted: conflict.localDeleted,
      serverDeleted: conflict.serverDeleted,
      fields: [
        {
          label: 'Front',
          base: this.displaySyncValue(base?.frontText),
          local: this.displaySyncValue(local?.frontText),
          server: this.displaySyncValue(server?.frontText),
        },
        {
          label: 'Back',
          base: this.displaySyncValue(base?.backText),
          local: this.displaySyncValue(local?.backText),
          server: this.displaySyncValue(server?.backText),
        },
        {
          label: 'Difficulty',
          base: this.displaySyncValue(base?.difficulty),
          local: this.displaySyncValue(local?.difficulty),
          server: this.displaySyncValue(server?.difficulty),
        },
        {
          label: 'Last reviewed',
          base: this.displaySyncValue(base?.lastReviewedAt),
          local: this.displaySyncValue(local?.lastReviewedAt),
          server: this.displaySyncValue(server?.lastReviewedAt),
        },
      ],
      canResolve,
      unsupportedReason: canResolve
        ? null
        : 'Delete conflicts need parent/child restoration semantics and are not resolvable in the UI yet.',
    };
  }

  private buildImageConflictItem(
    entityId: string,
    conflict: SyncConflictRecord<ImageSyncSnapshot>,
  ): SyncConflictUiItem {
    const base = conflict.base;
    const local = conflict.local;
    const server = conflict.server;

    return {
      key: `image:${entityId}`,
      entityType: 'image',
      entityId,
      title: `Image ${this.shortId(entityId)}`,
      detectedAt: conflict.detectedAt,
      baseRevision: conflict.baseRevision,
      serverRevision: conflict.serverRevision,
      localDeleted: conflict.localDeleted,
      serverDeleted: conflict.serverDeleted,
      fields: [
        {
          label: 'Card',
          base: this.displaySyncValue(base?.cardId),
          local: this.displaySyncValue(local?.cardId),
          server: this.displaySyncValue(server?.cardId),
        },
        {
          label: 'Side',
          base: this.displaySyncValue(base?.side),
          local: this.displaySyncValue(local?.side),
          server: this.displaySyncValue(server?.side),
        },
        {
          label: 'Position',
          base: this.displaySyncValue(base?.position),
          local: this.displaySyncValue(local?.position),
          server: this.displaySyncValue(server?.position),
        },
      ],
      canResolve: false,
      unsupportedReason:
        'Manual image conflict resolution is not implemented yet. The sync engine still preserves this conflict without discarding either side.',
    };
  }

  private rebuildMergeForms(meta: StoredSyncMeta): void {
    const nextDeckForms: Record<string, DeckMergeForm> = {};
    const nextCardForms: Record<string, CardMergeForm> = {};

    for (const item of this.syncConflicts) {
      if (item.entityType === 'deck' && item.canResolve) {
        const existing = this.deckMergeForms[item.entityId];

        if (existing) {
          nextDeckForms[item.entityId] = existing;

          continue;
        }

        const conflict = meta.decks[item.entityId]?.conflict;

        if (!conflict?.local || !conflict.server) {
          continue;
        }

        nextDeckForms[item.entityId] = {
          name: this.chooseThreeWayValue(
            conflict.base?.name ?? '',
            conflict.local.name,
            conflict.server.name,
          ),
          description: this.chooseThreeWayValue(
            conflict.base?.description ?? '',
            conflict.local.description ?? '',
            conflict.server.description ?? '',
          ),
        };
      }

      if (item.entityType === 'card' && item.canResolve) {
        const existing = this.cardMergeForms[item.entityId];

        if (existing) {
          nextCardForms[item.entityId] = existing;

          continue;
        }

        const conflict = meta.cards[item.entityId]?.conflict;

        if (!conflict?.local || !conflict.server) {
          continue;
        }

        nextCardForms[item.entityId] = {
          frontText: this.chooseThreeWayValue(
            conflict.base?.frontText ?? '',
            conflict.local.frontText,
            conflict.server.frontText,
          ),
          backText: this.chooseThreeWayValue(
            conflict.base?.backText ?? '',
            conflict.local.backText,
            conflict.server.backText,
          ),
          difficulty: this.chooseThreeWayValue(
            conflict.base?.difficulty ?? conflict.local.difficulty,
            conflict.local.difficulty,
            conflict.server.difficulty,
          ),
          lastReviewedAt: this.chooseThreeWayValue(
            conflict.base?.lastReviewedAt ?? null,
            conflict.local.lastReviewedAt,
            conflict.server.lastReviewedAt,
          ) ?? '',
        };
      }
    }

    this.deckMergeForms = nextDeckForms;
    this.cardMergeForms = nextCardForms;
  }

  private chooseThreeWayValue<T>(base: T, local: T, server: T): T {
    if (local === server) {
      return local;
    }

    if (local === base) {
      return server;
    }

    if (server === base) {
      return local;
    }

    /*
     * Both sides changed the same field differently.
     * Keep This Device as the editable default so nothing
     * from the local side is silently discarded.
     */
    return local;
  }

  private displaySyncValue(value: unknown): string {
    if (value === null || value === undefined || value === '') {
      return '—';
    }

    return String(value);
  }

  private shortId(id: string): string {
    return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
  }

  private shortText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();

    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength - 1)}…`;
  }

  private describeSyncActionError(error: unknown): string {
    if (error instanceof SyncApiError) {
      if (error.status === 401) {
        return 'The stored device token was rejected. Re-register this device and try again.';
      }

      return `${error.message} (HTTP ${error.status})`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown synchronization error.';
  }

  // -------------------------------------------------
  // Current deck / practice card
  // -------------------------------------------------
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
  // -------------------------------------------------
  // Decks
  // -------------------------------------------------
  reloadDecks(): void {
    this.decks = this.state.getDecks();
    if (this.selectedDeckId && !this.decks.some((deck) => deck.id === this.selectedDeckId)) {
      this.selectedDeckId = null;
      this.deckViewMode = null;
    }
  }
  async createDeck(): Promise<void> {
    const name = this.newDeckName.trim();
    if (!name) {
      return;
    }
    try {
      await this.state.createDeck(name, this.newDeckDescription);
      this.newDeckName = '';
      this.newDeckDescription = '';
      this.reloadDecks();
      await this.refreshSyncState();
    } catch (err) {
      console.error('Failed to create deck', err);
      alert('Could not save the new deck. Please try again.');
    }
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
  async deleteDeck(deck: Deck): Promise<void> {
    if (!confirm(`Really delete deck "${deck.name}"?`)) {
      return;
    }
    try {
      await this.state.deleteDeck(deck.id);
      this.reloadDecks();
      this.backToDeckList();
      await this.refreshSyncState();
    } catch (err) {
      console.error('Failed to delete deck', err);
      this.reloadDecks();
      alert('Could not delete the deck. Please try again.');
    }
  }
  // -------------------------------------------------
  // Backup / restore
  // -------------------------------------------------
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
        await this.refreshSyncState();
        alert('Import successful.');
      } catch (err) {
        console.error('Import failed', err);
        alert('Import failed. Please make sure you selected a valid backup file.');
      }
    };
    reader.readAsText(file);
    input.value = '';
  }
  // -------------------------------------------------
  // Cards
  // -------------------------------------------------
  startCreateCard(): void {
    this.resetCardForm();
  }
  startEditCard(card: Flashcard): void {
    this.cardForm.editingCardId = card.id;
    this.cardForm.frontText = card.front.text;
    this.cardForm.frontImages = card.front.images.map((image) => ({
      ...image,
    }));
    this.cardForm.backText = card.back.text;
    this.cardForm.backImages = card.back.images.map((image) => ({
      ...image,
    }));
  }
  async saveCard(): Promise<void> {
    const deck = this.selectedDeck;
    if (!deck) {
      return;
    }
    const front: CardSideContent = {
      text: (this.cardForm.frontText || '').trim(),
      images: this.cardForm.frontImages.map((image) => ({
        ...image,
      })),
    };
    const back: CardSideContent = {
      text: (this.cardForm.backText || '').trim(),
      images: this.cardForm.backImages.map((image) => ({
        ...image,
      })),
    };
    if (!front.text && front.images.length === 0 && !back.text && back.images.length === 0) {
      return;
    }
    try {
      if (this.cardForm.editingCardId) {
        await this.state.updateCard(deck.id, this.cardForm.editingCardId, {
          front,
          back,
        });
      } else {
        const defaultDifficulty: DifficultyLevel = 5;
        await this.state.createCard(deck.id, front, back, defaultDifficulty);
      }
      this.resetCardForm();
      this.reloadDecks();
      await this.refreshSyncState();
    } catch (err) {
      console.error('Failed to save card', err);
      this.reloadDecks();
      alert('Could not save the card. Please try again.');
    }
  }
  async deleteCard(card: Flashcard): Promise<void> {
    const deck = this.selectedDeck;
    if (!deck) {
      return;
    }
    if (!confirm('Really delete this card?')) {
      return;
    }
    try {
      await this.state.deleteCard(deck.id, card.id);
      this.reloadDecks();
      await this.refreshSyncState();
    } catch (err) {
      console.error('Failed to delete card', err);
      this.reloadDecks();
      alert('Could not delete the card. Please try again.');
    }
  }
  resetCardForm(): void {
    this.cardForm = {
      editingCardId: null,
      frontText: '',
      frontImages: [],
      backText: '',
      backImages: [],
    };
  }
  // -------------------------------------------------
  // Images
  // -------------------------------------------------
  onFrontImageSelected(event: Event): void {
    this.loadImageFromEvent(event, (dataUrl) => {
      const image: CardImageContent = {
        id: this.generateImageId(),
        dataUrl,
      };
      this.cardForm.frontImages = [...this.cardForm.frontImages, image];
    });
  }
  clearFrontImages(): void {
    this.cardForm.frontImages = [];
  }
  removeFrontImage(index: number): void {
    this.cardForm.frontImages = this.cardForm.frontImages.filter(
      (_image, currentIndex) => currentIndex !== index,
    );
  }
  onBackImageSelected(event: Event): void {
    this.loadImageFromEvent(event, (dataUrl) => {
      const image: CardImageContent = {
        id: this.generateImageId(),
        dataUrl,
      };
      this.cardForm.backImages = [...this.cardForm.backImages, image];
    });
  }
  clearBackImages(): void {
    this.cardForm.backImages = [];
  }
  removeBackImage(index: number): void {
    this.cardForm.backImages = this.cardForm.backImages.filter(
      (_image, currentIndex) => currentIndex !== index,
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
  private generateImageId(): string {
    if (
      typeof globalThis.crypto !== 'undefined' &&
      typeof globalThis.crypto.randomUUID === 'function'
    ) {
      return globalThis.crypto.randomUUID();
    }
    if (
      typeof globalThis.crypto !== 'undefined' &&
      typeof globalThis.crypto.getRandomValues === 'function'
    ) {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      return (
        'img-' +
        Array.from(bytes)
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
      );
    }
    return 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }
  // -------------------------------------------------
  // Practice
  // -------------------------------------------------
  startPractice(): void {
    const deck = this.selectedDeck;
    if (!deck || deck.cards.length === 0) {
      return;
    }
    let pool: Flashcard[] = deck.cards;
    if (this.practiceDifficultyFilter === 'unrated') {
      pool = deck.cards.filter((card) => card.lastReviewedAt === null);
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
      await this.refreshSyncState();
    } catch (err) {
      console.error('Failed to save difficulty', err);
      this.reloadDecks();
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
    return deck.cards.filter((card) => card.lastReviewedAt === null).length;
  }
  getDifficultyCount(deck: Deck, level: number): number {
    return deck.cards.filter((card) => card.difficulty === level).length;
  }
  private shuffle<T>(items: T[]): T[] {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}
