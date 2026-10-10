// src/main.ts

import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app';

import { appConfig } from './app/app.config';

import { IncrementalPullReport, IncrementalSyncService } from './app/incremental-sync.service';

import { IncrementalPushReport, IncrementalPushService } from './app/incremental-push.service';

import { SyncCycleReport, SyncCycleService } from './app/sync-cycle.service';

import {
  CardConflictMergeInput,
  ConflictResolutionEntityType,
  ConflictResolutionResult,
  ConflictResolutionService,
  DeckConflictMergeInput,
} from './app/conflict-resolution.service';

type FlashcardsDebugWindow = Window &
  typeof globalThis & {
    flashcardsSyncPull?: () => Promise<IncrementalPullReport>;

    flashcardsSyncPush?: () => Promise<IncrementalPushReport>;

    flashcardsSyncOnce?: () => Promise<SyncCycleReport>;

    flashcardsResolveCloud?: (
      entityType: ConflictResolutionEntityType,
      entityId: string,
    ) => Promise<ConflictResolutionResult>;

    flashcardsResolveThisDevice?: (
      entityType: ConflictResolutionEntityType,
      entityId: string,
    ) => Promise<ConflictResolutionResult>;

    flashcardsResolveDeckMerge?: (
      entityId: string,
      merged: DeckConflictMergeInput,
    ) => Promise<ConflictResolutionResult>;

    flashcardsResolveCardMerge?: (
      entityId: string,
      merged: CardConflictMergeInput,
    ) => Promise<ConflictResolutionResult>;
  };

bootstrapApplication(AppComponent, appConfig)
  .then((appRef) => {
    const hostname = window.location.hostname;

    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return;
    }

    const incrementalPull = appRef.injector.get(IncrementalSyncService);

    const incrementalPush = appRef.injector.get(IncrementalPushService);

    const syncCycle = appRef.injector.get(SyncCycleService);

    const conflictResolution = appRef.injector.get(ConflictResolutionService);

    const debugWindow = window as FlashcardsDebugWindow;

    debugWindow.flashcardsSyncPull = () => incrementalPull.pullAndApplyAndLog();

    debugWindow.flashcardsSyncPush = () => incrementalPush.pushPendingAndLog();

    debugWindow.flashcardsSyncOnce = () => syncCycle.syncOnceAndLog();

    debugWindow.flashcardsResolveCloud = (entityType, entityId) =>
      conflictResolution.resolveWithCloud(entityType, entityId);

    debugWindow.flashcardsResolveThisDevice = (entityType, entityId) =>
      conflictResolution.resolveWithThisDevice(entityType, entityId);

    debugWindow.flashcardsResolveDeckMerge = (entityId, merged) =>
      conflictResolution.mergeDeck(entityId, merged);

    debugWindow.flashcardsResolveCardMerge = (entityId, merged) =>
      conflictResolution.mergeCard(entityId, merged);
  })
  .catch((err) => console.error(err));
