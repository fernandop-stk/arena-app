import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

type AccessAdminUser = {
  email: string;
  username: string;
  role: 'superadmin' | 'admin' | 'client';
};

@Component({
  selector: 'app-admin-acceso',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './admin-acceso.html',
  styleUrl: './admin-acceso.scss',
})
export class AdminAccesoComponent {
  private readonly formBuilder = inject(FormBuilder);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  protected readonly showAccessModal = signal(false);
  protected readonly accessModalTab = signal<'login' | 'register-client'>('login');

  protected readonly loginForm = this.formBuilder.group({
    identity: ['', [Validators.required]],
    password: ['', [Validators.required]],
  });

  protected readonly isSubmitting = signal(false);
  protected readonly message = signal('');
  protected readonly errorMessage = signal('');
  protected readonly showLoginPassword = signal(false);
  protected readonly showRoleUserPassword = signal(false);
  protected readonly isRoleSelectionLoading = signal(false);
  protected readonly requiresRoleIdentification = signal(false);
  protected readonly roleIdentificationError = signal('');
  protected readonly roleIdentificationUsers = signal<AccessAdminUser[]>([]);
  protected readonly selectedRoleUser = signal<AccessAdminUser | null>(null);

  private readonly adminSessionEndpoint = '/api/auth/session';
  private readonly adminIdentificationUsersEndpoint = '/api/admin/identificacion-usuarios';

  protected readonly roleUserPasswordForm = this.formBuilder.group({
    password: ['', [Validators.required]],
  });

  constructor() {
    if (typeof window !== 'undefined') {
      this.openAccessModal('login');
    }
  }

  protected openAccessModal(initialTab: 'login' | 'register-client' = 'login'): void {
    this.accessModalTab.set(initialTab);
    this.showAccessModal.set(true);
  }

  protected closeAccessModal(): void {
    this.showAccessModal.set(false);
    this.accessModalTab.set('login');
    this.errorMessage.set('');
    this.message.set('');
    this.requiresRoleIdentification.set(false);
    this.roleIdentificationError.set('');
    this.roleIdentificationUsers.set([]);
    this.selectedRoleUser.set(null);
    this.roleUserPasswordForm.reset();
    this.showRoleUserPassword.set(false);

    if (typeof window !== 'undefined') {
      window.location.assign('/');
      return;
    }

    void this.router.navigateByUrl('/');
  }

  protected closeAccessModalAndGoHome(): void {
    this.closeAccessModal();
  }

  protected setAccessModalTab(tab: 'login' | 'register-client'): void {
    this.accessModalTab.set(tab);
    this.errorMessage.set('');
    this.message.set('');
  }

  protected isAccessModalTab(tab: 'login' | 'register-client'): boolean {
    return this.accessModalTab() === tab;
  }

  protected toggleLoginPasswordVisibility(): void {
    this.showLoginPassword.update((value) => !value);
  }

  protected toggleRoleUserPasswordVisibility(): void {
    this.showRoleUserPassword.update((value) => !value);
  }

  protected selectRoleIdentificationUser(user: AccessAdminUser): void {
    this.selectedRoleUser.set(user);
    this.roleUserPasswordForm.reset();
    this.roleIdentificationError.set('');
    this.showRoleUserPassword.set(false);
  }

  protected backToRoleSelection(): void {
    this.selectedRoleUser.set(null);
    this.roleUserPasswordForm.reset();
    this.roleIdentificationError.set('');
    this.showRoleUserPassword.set(false);
  }

  protected confirmRoleIdentification(): void {
    const selectedUser = this.selectedRoleUser();

    if (!selectedUser) {
      this.roleIdentificationError.set('Selecciona primero quién eres.');
      return;
    }

    if (this.roleUserPasswordForm.invalid) {
      this.roleUserPasswordForm.markAllAsTouched();
      return;
    }

    const password = `${this.roleUserPasswordForm.get('password')?.value ?? ''}`;

    this.isSubmitting.set(true);
    this.roleIdentificationError.set('');

    this.http
      .post<{ ok: boolean; error?: string }>('/api/auth/login', {
        identity: selectedUser.email,
        password,
      })
      .subscribe({
        next: () => {
          this.http
            .get<{
              ok: boolean;
              isAdmin: boolean;
              role?: 'superadmin' | 'admin' | 'client';
            }>(this.adminSessionEndpoint)
            .subscribe({
              next: (session) => {
                this.isSubmitting.set(false);

                if (
                  session?.isAdmin &&
                  (session.role === 'superadmin' || session.role === 'admin')
                ) {
                  this.closeAccessModal();
                  void this.router.navigate(['/admin']);
                  return;
                }

                this.roleIdentificationError.set('No tienes permisos de gestión con este usuario.');
              },
              error: () => {
                this.isSubmitting.set(false);
                this.roleIdentificationError.set(
                  'No se pudo validar la sesión. Inténtalo de nuevo.',
                );
              },
            });
        },
        error: () => {
          this.isSubmitting.set(false);
          this.roleIdentificationError.set('Contraseña incorrecta para el usuario seleccionado.');
        },
      });
  }

  private loadRoleIdentificationUsers(): void {
    this.isRoleSelectionLoading.set(true);
    this.roleIdentificationError.set('');
    this.roleIdentificationUsers.set([]);
    this.selectedRoleUser.set(null);
    this.roleUserPasswordForm.reset();

    this.http
      .get<{ ok: boolean; users: AccessAdminUser[] }>(this.adminIdentificationUsersEndpoint)
      .subscribe({
        next: (response) => {
          this.isRoleSelectionLoading.set(false);

          const users = (response?.users ?? [])
            .filter((user) => user.role === 'superadmin' || user.role === 'admin')
            .sort((a, b) => {
              if (a.role === b.role) {
                return a.username.localeCompare(b.username);
              }

              if (a.role === 'superadmin') {
                return -1;
              }

              if (b.role === 'superadmin') {
                return 1;
              }

              return 0;
            });

          this.roleIdentificationUsers.set(users);

          if (users.length === 0) {
            this.roleIdentificationError.set(
              'No hay usuarios de gestión disponibles para identificarte.',
            );
          }
        },
        error: () => {
          this.isRoleSelectionLoading.set(false);
          this.roleIdentificationError.set(
            'No se pudo cargar la lista de usuarios de gestión. Inténtalo de nuevo.',
          );
        },
      });
  }

  protected submitLogin(): void {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    const identity = this.loginForm.get('identity')?.value ?? '';
    const password = this.loginForm.get('password')?.value ?? '';

    this.isSubmitting.set(true);
    this.errorMessage.set('');
    this.message.set('');

    this.http
      .post<{ ok: boolean; error?: string }>('/api/auth/login', { identity, password })
      .subscribe({
        next: () => {
          this.http
            .get<{
              ok: boolean;
              isAdmin: boolean;
              role?: 'superadmin' | 'admin' | 'client';
            }>(this.adminSessionEndpoint)
            .subscribe({
              next: (session) => {
                if (
                  session?.isAdmin &&
                  (session.role === 'superadmin' || session.role === 'admin')
                ) {
                  this.isSubmitting.set(false);
                  this.requiresRoleIdentification.set(true);
                  this.loadRoleIdentificationUsers();
                  return;
                }

                this.isSubmitting.set(false);
                this.closeAccessModal();

                if (session?.isAdmin) {
                  void this.router.navigate(['/admin']);
                  return;
                }

                void this.router.navigate(['/']);
              },
              error: () => {
                this.isSubmitting.set(false);
                this.closeAccessModal();
                void this.router.navigate(['/']);
              },
            });
        },
        error: () => {
          this.http
            .post<{
              ok: boolean;
              error?: string;
            }>('/api/cliente/login', { identity, password }, { withCredentials: true })
            .subscribe({
              next: (res) => {
                this.isSubmitting.set(false);
                if (res.ok) {
                  this.closeAccessModal();
                  void this.router.navigate(['/cliente/area']);
                } else {
                  this.errorMessage.set('Credenciales inválidas.');
                }
              },
              error: () => {
                this.isSubmitting.set(false);
                this.errorMessage.set('Credenciales inválidas.');
              },
            });
        },
      });
  }
}
