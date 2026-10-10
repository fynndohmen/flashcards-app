// src/main.ts

import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app';

import { appConfig } from './app/app.config';

import { IncrementalPullReport, IncrementalSyncService } from './app/incremental-sync.service';

import { IncrementalPushReport, IncrementalPushService } from './app/incremental-push.service';

import { SyncCycleReport, SyncCycleService } from './app/sync-cycle.service';

type FlashcardsDebugWindow = Window &
  typeof globalThis & {
    flashcardsSyncPull?: () => Promise<IncrementalPullReport>;

    flashcardsSyncPush?: () => Promise<IncrementalPushReport>;

    flashcardsSyncOnce?: () => Promise<SyncCycleReport>;
  };

/**
 * Entry point of the Angular application.
 *
 * Development localhost additionally exposes:
 *
 *   await flashcardsSyncPull()
 *   await flashcardsSyncPush()
 *   await flashcardsSyncOnce()
 *
 * Individual pull/push helpers remain available for
 * diagnostics. Normal synchronization should use
 * flashcardsSyncOnce().
 */
bootstrapApplication(AppComponent, appConfig)
  .then((appRef) => {
    const hostname = window.location.hostname;

    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return;
    }

    const incrementalPull = appRef.injector.get(IncrementalSyncService);

    const incrementalPush = appRef.injector.get(IncrementalPushService);

    const syncCycle = appRef.injector.get(SyncCycleService);

    const debugWindow = window as FlashcardsDebugWindow;

    debugWindow.flashcardsSyncPull = () => incrementalPull.pullAndApplyAndLog();

    debugWindow.flashcardsSyncPush = () => incrementalPush.pushPendingAndLog();

    debugWindow.flashcardsSyncOnce = () => syncCycle.syncOnceAndLog();
  })
  .catch((err) => console.error(err));
