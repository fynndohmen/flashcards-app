// src/main.ts

import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app';

import { appConfig } from './app/app.config';

import { IncrementalPullReport, IncrementalSyncService } from './app/incremental-sync.service';

type FlashcardsDebugWindow = Window &
  typeof globalThis & {
    flashcardsSyncPull?: () => Promise<IncrementalPullReport>;
  };

/**
 * Entry point of the Angular application.
 *
 * Development localhost additionally exposes:
 *
 *   await flashcardsSyncPull()
 *
 * This currently performs only the incremental
 * pull/apply half of synchronization. It never pushes.
 */
bootstrapApplication(AppComponent, appConfig)
  .then((appRef) => {
    const hostname = window.location.hostname;

    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return;
    }

    const sync = appRef.injector.get(IncrementalSyncService);

    (window as FlashcardsDebugWindow).flashcardsSyncPull = () => sync.pullAndApplyAndLog();
  })
  .catch((err) => console.error(err));
