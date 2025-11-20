// src/app/app.routes.ts

import { Routes } from '@angular/router';

/**
 * We don't use the Angular router for this app (yet).
 * Everything is handled directly inside AppComponent.
 *
 * The router is still provided in app.config.ts, but with
 * an empty route configuration. This keeps things simple
 * and avoids references to non-existing components.
 */
export const routes: Routes = [
  // No routes for now – single-screen flashcards app.
];
