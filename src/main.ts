// src/main.ts

import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app';
import { appConfig } from './app/app.config';

/**
 * Entry point of the Angular application.
 * Bootstraps the standalone AppComponent with the global appConfig.
 */
bootstrapApplication(AppComponent, appConfig).catch((err) =>
  console.error(err)
);
