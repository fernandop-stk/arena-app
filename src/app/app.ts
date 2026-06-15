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
              src="assets/branding/logo-header.jpeg"
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
              @if (!isSuperadmin()) {
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
                  routerLink="/packs"
                  routerLinkActive="app-shell--header__link--active"
                  (click)="closeMenu()"
                  >Packs y tratamientos</a
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
              }

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
                  routerLink="/acceso"
                  routerLinkActive="app-shell--header__link--active"
                  (click)="closeMenu()"
                  >Iniciar sesión</a
                >
              } @else {
                @if (isClientAuthenticated()) {
                  <a
                    class="app-shell--header__link"
                    routerLink="/cliente/area"
                    routerLinkActive="app-shell--header__link--active"
                    (click)="closeMenu()"
                    >Mi cuenta</a
                  >
                }
                <span class="app-shell--header__link app-shell--header__link--user"
                  >Hola, {{ username() }}</span
                >
                @if (isAdmin() && !isSuperadmin()) {
                  <section class="app-shell--header__tracking" aria-label="Fichaje de jornada">
                    <p class="app-shell--header__tracking-status">
                      Estado: {{ getEmployeeWorkStatusLabel(employeeWorkStatus()) }}
                    </p>

                    @if (employeeLastCheckInIso()) {
                      <p class="app-shell--header__tracking-meta">
                        Última entrada: {{ formatTrackingDate(employeeLastCheckInIso()) }}
                      </p>
                    }

                    @if (employeeLastCheckOutIso()) {
                      <p class="app-shell--header__tracking-meta">
                        Última salida: {{ formatTrackingDate(employeeLastCheckOutIso()) }}
                      </p>
                    }

                    <div class="app-shell--header__tracking-actions">
                      <button
                        type="button"
                        class="app-shell--header__tracking-btn app-shell--header__tracking-btn--entry"
                        [disabled]="
                          isEmployeeTrackingLoading() || employeeWorkStatus() === 'working'
                        "
                        (click)="clockIn()"
                      >
                        Fichar entrada
                      </button>
                      <button
                        type="button"
                        class="app-shell--header__tracking-btn app-shell--header__tracking-btn--exit"
                        [disabled]="
                          isEmployeeTrackingLoading() || employeeWorkStatus() !== 'working'
                        "
                        (click)="clockOut()"
                      >
                        Fichar salida
                      </button>
                    </div>

                    @if (employeeTrackingError()) {
                      <p class="app-shell--header__tracking-error">{{ employeeTrackingError() }}</p>
                    }
                  </section>
                }
                <button type="button" class="app-shell--header__link" (click)="logout()">
                  Cerrar sesión
                </button>
              }
            </nav>

            @if (!isSuperadmin()) {
              <a class="app-shell--header__cta" routerLink="/reservas" (click)="closeMenu()"
                >Reservar ahora</a
              >
            }
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

      @if (!isSuperadmin()) {
        <footer class="app-shell--footer">
          <div class="app-shell--footer__container">
            <div class="app-shell--footer__top">
              <a class="app-shell--footer__brand" routerLink="/" aria-label="Arena Hair Studio">
                <img
                  class="app-shell--footer__logo"
                  src="assets/branding/logo-header.jpeg"
                  alt="Arena Hair Studio"
                />
                <span class="app-shell--footer__brand-name">Arena Hair Studio</span>
              </a>

              <nav class="app-shell--footer__nav" aria-label="Navegación del pie de página">
                <a class="app-shell--footer__link" routerLink="/conocenos">Conócenos</a>
                <a class="app-shell--footer__link" routerLink="/reservas">Reservar cita</a>
                <a class="app-shell--footer__link" routerLink="/packs">Packs y tratamientos</a>
                <a class="app-shell--footer__link" routerLink="/donde-estamos">Dónde estamos</a>
              </nav>

              <a
                class="app-shell--footer__instagram"
                href="https://www.instagram.com/arenahairstudio"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Arena Hair Studio en Instagram"
              >
                <svg
                  class="app-shell--footer__instagram-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
                  <circle cx="12" cy="12" r="4" />
                  <circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
                </svg>
                <span>Instagram</span>
              </a>
            </div>

            <div class="app-shell--footer__bottom">
              <p class="app-shell--footer__hours">Horario · M-V 10:00-18:00 · Sáb 09:00-13:00</p>
              <p class="app-shell--footer__copy">
                © {{ currentYear }} Arena Hair Studio · Todos los derechos reservados
              </p>
            </div>
          </div>
        </footer>
      }
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
  protected readonly isClientAuthenticated = signal(false);
  protected readonly isAdmin = signal(false);
  protected readonly isSuperadmin = signal(false);
  protected readonly username = signal('');
  protected readonly employeeWorkStatus = signal<
    'idle' | 'working' | 'vacation' | 'sick_leave' | 'recovering_hours'
  >('idle');
  protected readonly employeeLastCheckInIso = signal('');
  protected readonly employeeLastCheckOutIso = signal('');
  protected readonly isEmployeeTrackingLoading = signal(false);
  protected readonly employeeTrackingError = signal('');

  protected readonly appName = this.appService.getAppName();
  protected readonly currentYear = new Date().getFullYear();

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
        this.http.post<{ ok: boolean }>('/api/cliente/logout', {}).subscribe({
          complete: () => {
            this.resetAuthState();
            this.closeMenu();
            void this.router.navigate(['/']);
          },
        });
      },
    });
  }

  private getDisplayName(name?: string | null): string {
    return (name ?? '').trim().split(/\s+/).filter(Boolean)[0] ?? '';
  }

  protected getEmployeeWorkStatusLabel(
    status: 'idle' | 'working' | 'vacation' | 'sick_leave' | 'recovering_hours',
  ): string {
    switch (status) {
      case 'working':
        return 'Trabajando';
      case 'vacation':
        return 'Vacaciones';
      case 'sick_leave':
        return 'Baja';
      case 'recovering_hours':
        return 'Recuperando horas';
      default:
        return 'Sin fichar';
    }
  }

  protected formatTrackingDate(value: string): string {
    if (!value) {
      return '';
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return value;
    }

    return parsed.toLocaleString('es-ES', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  protected clockIn(): void {
    this.submitEmployeeTracking('check_in');
  }

  protected clockOut(): void {
    this.submitEmployeeTracking('check_out');
  }

  private resetAuthState(): void {
    this.isAuthenticated.set(false);
    this.isClientAuthenticated.set(false);
    this.isAdmin.set(false);
    this.isSuperadmin.set(false);
    this.username.set('');
    this.employeeWorkStatus.set('idle');
    this.employeeLastCheckInIso.set('');
    this.employeeLastCheckOutIso.set('');
    this.employeeTrackingError.set('');
    this.isEmployeeTrackingLoading.set(false);
  }

  private refreshEmployeeTracking(): void {
    this.http
      .get<{
        ok: boolean;
        tracking?: {
          workStatus?: 'idle' | 'working' | 'vacation' | 'sick_leave' | 'recovering_hours';
          lastCheckInIso?: string;
          lastCheckOutIso?: string;
        };
      }>('/api/empleado/fichaje')
      .subscribe({
        next: (response) => {
          this.employeeWorkStatus.set(response?.tracking?.workStatus ?? 'idle');
          this.employeeLastCheckInIso.set(response?.tracking?.lastCheckInIso ?? '');
          this.employeeLastCheckOutIso.set(response?.tracking?.lastCheckOutIso ?? '');
          this.employeeTrackingError.set('');
        },
        error: () => {
          this.employeeWorkStatus.set('idle');
          this.employeeLastCheckInIso.set('');
          this.employeeLastCheckOutIso.set('');
          this.employeeTrackingError.set('No se pudo cargar el estado de fichaje.');
        },
      });
  }

  private submitEmployeeTracking(action: 'check_in' | 'check_out'): void {
    if (!this.isAdmin() || this.isSuperadmin() || this.isEmployeeTrackingLoading()) {
      return;
    }

    this.isEmployeeTrackingLoading.set(true);
    this.employeeTrackingError.set('');

    this.http
      .post<{
        ok: boolean;
        tracking?: {
          workStatus?: 'idle' | 'working' | 'vacation' | 'sick_leave' | 'recovering_hours';
          lastCheckInIso?: string;
          lastCheckOutIso?: string;
        };
      }>('/api/empleado/fichaje', { action })
      .subscribe({
        next: (response) => {
          this.employeeWorkStatus.set(response?.tracking?.workStatus ?? 'idle');
          this.employeeLastCheckInIso.set(response?.tracking?.lastCheckInIso ?? '');
          this.employeeLastCheckOutIso.set(response?.tracking?.lastCheckOutIso ?? '');
          this.employeeTrackingError.set('');
          this.isEmployeeTrackingLoading.set(false);
        },
        error: (error) => {
          this.employeeTrackingError.set(
            error?.error?.error ?? 'No se pudo registrar el fichaje. Inténtalo de nuevo.',
          );
          this.isEmployeeTrackingLoading.set(false);
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
        role?: string;
        username?: string;
      }>('/api/auth/session')
      .subscribe({
        next: (response) => {
          if (response?.isAuthenticated) {
            this.isAuthenticated.set(true);
            this.isClientAuthenticated.set(false);
            this.isAdmin.set(Boolean(response?.isAdmin));
            this.isSuperadmin.set(response?.role === 'superadmin');
            this.username.set(this.getDisplayName(response?.username));

            if (response?.isAdmin && response?.role !== 'superadmin') {
              this.refreshEmployeeTracking();
            } else {
              this.employeeWorkStatus.set('idle');
              this.employeeLastCheckInIso.set('');
              this.employeeLastCheckOutIso.set('');
              this.employeeTrackingError.set('');
            }

            return;
          }

          this.http
            .get<{
              ok: boolean;
              isAuthenticated: boolean;
              client?: {
                fullName?: string;
              } | null;
            }>('/api/cliente/session')
            .subscribe({
              next: (clientResponse) => {
                this.isAuthenticated.set(Boolean(clientResponse?.isAuthenticated));
                this.isClientAuthenticated.set(Boolean(clientResponse?.isAuthenticated));
                this.isAdmin.set(false);
                this.isSuperadmin.set(false);
                this.username.set(this.getDisplayName(clientResponse?.client?.fullName));
                this.employeeWorkStatus.set('idle');
                this.employeeLastCheckInIso.set('');
                this.employeeLastCheckOutIso.set('');
                this.employeeTrackingError.set('');
              },
              error: () => {
                this.resetAuthState();
              },
            });
        },
        error: () => {
          this.resetAuthState();
        },
      });
  }
}
