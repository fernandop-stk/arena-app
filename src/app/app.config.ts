import { ApplicationConfig, LOCALE_ID, provideBrowserGlobalErrorListeners } from '@angular/core';
import { InMemoryScrollingOptions, provideRouter, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';

import { routes } from './app.routes';
import { apiErrorInterceptor } from './shared/app-error/api-error.interceptor';
import {
  provideClientHydration,
  withEventReplay,
  withIncrementalHydration,
} from '@angular/platform-browser';

const scrollOptions: InMemoryScrollingOptions = {
  scrollPositionRestoration: 'top',
  anchorScrolling: 'enabled',
};

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: LOCALE_ID, useValue: 'es-ES' },
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withInMemoryScrolling(scrollOptions)),
    provideClientHydration(withEventReplay(), withIncrementalHydration()),
    provideHttpClient(withFetch(), withInterceptors([apiErrorInterceptor])),
  ],
};
