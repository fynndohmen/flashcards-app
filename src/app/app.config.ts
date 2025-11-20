// src/app/app.config.ts

import {
  ApplicationConfig,
  isDevMode,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';

/**
 * Global Angular application configuration.
 * - Zone.js based change detection
 * - Router (currently no routes, but ready)
 * - Service worker for PWA/offline support (enabled only in production builds)
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({
      eventCoalescing: true,
    }),
    provideRouter(routes),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(), // only enable SW in production
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
