import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, afterNextRender, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationStart,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter, fromEvent } from 'rxjs';
import { AppService } from './app.service';

@Component({
  selector: 'app-root',
  host: { ngSkipHydration: 'true' },
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="app-shell">
      <header class="app-shell--header">
        <div class="app-shell--header__container">
          <a class="app-shell--header__brand" routerLink="/">
            <img
              class="app-shell--header__brand-logo"
              src="assets/branding/logo.png"
              alt="Arena Studio"
            />
            <span class="app-shell--header__brand-text">Arena Hair Studio</span>
          </a>

          <button
            type="button"
            class="app-shell--header__menu-toggle"
            [class.app-shell--header__menu-toggle--active]="isMenuOpen()"
            [attr.aria-expanded]="isMenuOpen()"
            aria-label="Abrir menú"
            (click)="toggleMenu()"
          >
            <span class="app-shell--header__menu-toggle-line"></span>
            <span class="app-shell--header__menu-toggle-line"></span>
            <span class="app-shell--header__menu-toggle-line"></span>
          </button>

          <div class="app-shell--header__menu" [class.app-shell--header__menu--open]="isMenuOpen()">
            <nav class="app-shell--header__nav">
              <a
                class="app-shell--header__link"
                routerLink="/"
                routerLinkActive="app-shell--header__link--active"
                [routerLinkActiveOptions]="{ exact: true }"
                (click)="closeMenu()"
                >Inicio</a
              >
              <a
                class="app-shell--header__link"
                routerLink="/tratamientos"
                routerLinkActive="app-shell--header__link--active"
                (click)="closeMenu()"
                >Tratamientos</a
              >
              <a
                class="app-shell--header__link"
                routerLink="/reservas"
                routerLinkActive="app-shell--header__link--active"
                (click)="closeMenu()"
                >Reservas</a
              >
              <a
                class="app-shell--header__link"
                routerLink="/conocenos"
                routerLinkActive="app-shell--header__link--active"
                (click)="closeMenu()"
                >Conócenos</a
              >
              <a
                class="app-shell--header__link"
                routerLink="/donde-estamos"
                routerLinkActive="app-shell--header__link--active"
                (click)="closeMenu()"
                >Dónde estamos</a
              >

              @if (isAdmin()) {
                <a
                  class="app-shell--header__link app-shell--header__link--admin"
                  routerLink="/admin"
                  routerLinkActive="app-shell--header__link--active"
                  (click)="closeMenu()"
                  >Panel admin</a
                >
              }

              @if (!isAuthenticated()) {
                <a
                  class="app-shell--header__link"
                  routerLink="/registro"
                  routerLinkActive="app-shell--header__link--active"
                  (click)="closeMenu()"
                  >Darse de alta</a
                >
                <a
                  class="app-shell--header__link"
                  routerLink="/acceso"
                  routerLinkActive="app-shell--header__link--active"
                  (click)="closeMenu()"
                  >Iniciar sesión</a
                >
              } @else {
                <span class="app-shell--header__link app-shell--header__link--user"
                  >Hola, {{ username() }}</span
                >
                <button type="button" class="app-shell--header__link" (click)="logout()">
                  Cerrar sesión
                </button>
              }
            </nav>

            <a class="app-shell--header__cta" routerLink="/reservas" (click)="closeMenu()"
              >Reservar ahora</a
            >
          </div>
        </div>
      </header>

      <button
        type="button"
        class="app-shell--menu-overlay"
        [class.app-shell--menu-overlay--open]="isMenuOpen()"
        aria-label="Cerrar menú"
        (click)="closeMenu()"
      ></button>

      <main class="app-shell--main">
        <router-outlet />
      </main>

      <footer class="app-shell--footer">
        <div class="app-shell--footer__container">
          <p class="app-shell--footer__text">© 2026 Arena Studio · Pinto, Madrid</p>
        </div>
      </footer>
    </div>
  `,
  styleUrl: './app.scss',
})
export class App {
  private readonly appService = inject(AppService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly isMenuOpen = signal(false);
  protected readonly isAuthenticated = signal(false);
  protected readonly isAdmin = signal(false);
  protected readonly username = signal('');

  protected readonly appName = this.appService.getAppName();

  constructor() {
    effect(() => {
      const body = this.document?.body;

      if (!body) {
        return;
      }

      body.classList.toggle('app-menu-open', this.isMenuOpen());
    });

    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationStart),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.closeMenu();
        this.refreshAuthSession();
      });

    // Delay the session check until AFTER hydration is complete.
    // Running it during hydration causes NG0502: if the response arrives
    // before Angular finishes reconciling the SSR DOM, the @if (isAdmin())
    // block changes state mid-hydration, breaking the expected DOM structure.
    afterNextRender(() => {
      this.refreshAuthSession();
    });

    if (typeof window !== 'undefined') {
      fromEvent(window, 'resize')
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          if (window.matchMedia('(min-width: 768px)').matches) {
            this.closeMenu();
          }
        });
    }

    this.destroyRef.onDestroy(() => {
      this.document?.body?.classList.remove('app-menu-open');
    });
  }

  protected toggleMenu(): void {
    this.isMenuOpen.update((state) => !state);
  }

  protected closeMenu(): void {
    this.isMenuOpen.set(false);
  }

  protected logout(): void {
    this.http.post<{ ok: boolean }>('/api/auth/logout', {}).subscribe({
      complete: () => {
        this.isAuthenticated.set(false);
        this.isAdmin.set(false);
        this.username.set('');
        this.closeMenu();
        void this.router.navigate(['/']);
      },
    });
  }

  private refreshAuthSession(): void {
    if (typeof window === 'undefined') {
      return;
    }

    this.http
      .get<{
        ok: boolean;
        isAuthenticated: boolean;
        isAdmin: boolean;
        username?: string;
      }>('/api/auth/session')
      .subscribe({
        next: (response) => {
          this.isAuthenticated.set(Boolean(response?.isAuthenticated));
          this.isAdmin.set(Boolean(response?.isAdmin));
          this.username.set(response?.username ?? '');
        },
        error: () => {
          this.isAuthenticated.set(false);
          this.isAdmin.set(false);
          this.username.set('');
        },
      });
  }
}
