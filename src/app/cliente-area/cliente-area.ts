import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

interface ClienteSesion {
  id: string;
  fullName: string;
  email: string;
  phone: string;
}

interface ClienteCita {
  id: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  appointmentTypeName: string;
  isUpcoming: boolean;
  adminStatus: 'pending' | 'approved' | 'rejected';
  createdAtIso: string;
}

interface ClientAlert {
  id: string;
  clientEmail: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  appointmentTypeName: string;
  status: 'active' | 'completed' | 'cancelled';
  createdAtIso: string;
}

@Component({
  selector: 'app-cliente-area',
  imports: [ReactiveFormsModule, DatePipe, RouterLink],
  templateUrl: './cliente-area.html',
  styleUrl: './cliente-area.scss',
})
export class ClienteAreaComponent {
  private readonly http = inject(HttpClient);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly loginForm = this.formBuilder.group({
    identity: ['', [Validators.required]],
    password: ['', [Validators.required]],
  });

  protected readonly isSubmitting = signal(false);
  protected readonly isLoading = signal(true);
  protected readonly errorMessage = signal('');
  protected readonly session = signal<ClienteSesion | null>(null);
  protected readonly appointments = signal<ClienteCita[]>([]);
  protected readonly alerts = signal<ClientAlert[]>([]);
  protected readonly isLoadingAlerts = signal(false);
  protected readonly isDeletingAlert = signal('');

  protected readonly hasAppointments = computed(() => this.appointments().length > 0);
  protected readonly hasAlerts = computed(() => this.alerts().length > 0);

  protected getWorkerDisplayName(email: string | null | undefined): string {
    const normalized = (email ?? '').trim();

    if (!normalized) {
      return 'Sin usuario';
    }

    if (normalized === 'cliente-auto-registro') {
      return 'Cliente auto-registro';
    }

    const localPart = normalized.includes('@')
      ? (normalized.split('@')[0] ?? normalized)
      : normalized;
    const cleaned = localPart
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      return 'Sin usuario';
    }

    return cleaned
      .split(' ')
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  }

  constructor() {
    this.loadSession();
  }

  private notifyAuthSessionChanged(): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.dispatchEvent(new CustomEvent('arena-auth-session-changed'));
  }

  protected handleLogin(): void {
    if (this.loginForm.invalid || this.isSubmitting()) {
      this.loginForm.markAllAsTouched();
      return;
    }

    this.isSubmitting.set(true);
    this.errorMessage.set('');

    const payload = {
      identity: this.loginForm.get('identity')?.value?.trim(),
      password: this.loginForm.get('password')?.value ?? '',
    };

    this.http
      .post<{ ok: boolean; error?: string }>('/api/cliente/login', payload, {
        withCredentials: true,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.errorMessage.set(response.error ?? 'No se pudo iniciar sesión.');
            this.isSubmitting.set(false);
            return;
          }

          this.loadSession();
          this.notifyAuthSessionChanged();
        },
        error: (error: { error?: { error?: string } }) => {
          this.errorMessage.set(error?.error?.error ?? 'No se pudo iniciar sesión.');
          this.isSubmitting.set(false);
        },
      });
  }

  protected logout(): void {
    this.http
      .post<{ ok: boolean }>('/api/cliente/logout', {}, { withCredentials: true })
      .subscribe({
        next: () => {
          this.session.set(null);
          this.appointments.set([]);
          this.alerts.set([]);
          this.loginForm.reset();
          this.notifyAuthSessionChanged();
        },
      });
  }

  private loadSession(): void {
    this.isLoading.set(true);

    this.http
      .get<{
        ok: boolean;
        isAuthenticated: boolean;
        client: ClienteSesion | null;
      }>('/api/cliente/session', { withCredentials: true })
      .subscribe({
        next: (response) => {
          if (response.isAuthenticated && response.client) {
            this.session.set(response.client);
            this.loadAppointments();
            this.notifyAuthSessionChanged();
            return;
          }

          this.session.set(null);
          this.appointments.set([]);
          this.isLoading.set(false);
          this.isSubmitting.set(false);
          this.notifyAuthSessionChanged();
        },
        error: () => {
          this.session.set(null);
          this.appointments.set([]);
          this.isLoading.set(false);
          this.isSubmitting.set(false);
          this.notifyAuthSessionChanged();
        },
      });
  }

  private loadAppointments(): void {
    this.http
      .get<{
        ok: boolean;
        citas: ClienteCita[];
        error?: string;
      }>('/api/cliente/citas', { withCredentials: true })
      .subscribe({
        next: (response) => {
          if (response.ok) {
            this.appointments.set(response.citas ?? []);
          } else {
            this.errorMessage.set(response.error ?? 'No se pudo cargar el historial de citas.');
          }

          this.loadAlerts();
        },
        error: (error: { error?: { error?: string } }) => {
          this.errorMessage.set(error?.error?.error ?? 'No se pudo cargar el historial de citas.');
          this.isLoading.set(false);
          this.isSubmitting.set(false);
        },
      });
  }

  private loadAlerts(): void {
    this.isLoadingAlerts.set(true);

    this.http
      .get<{
        ok: boolean;
        alerts: ClientAlert[];
        error?: string;
      }>('/api/cliente/alertas', { withCredentials: true })
      .subscribe({
        next: (response) => {
          if (response.ok) {
            this.alerts.set(response.alerts ?? []);
          }

          this.isLoading.set(false);
          this.isSubmitting.set(false);
          this.isLoadingAlerts.set(false);
        },
        error: () => {
          this.isLoading.set(false);
          this.isSubmitting.set(false);
          this.isLoadingAlerts.set(false);
        },
      });
  }

  protected deleteAlert(alertId: string): void {
    if (this.isDeletingAlert() === alertId) {
      return;
    }

    this.isDeletingAlert.set(alertId);

    this.http
      .delete<{ ok: boolean }>(`/api/cliente/alertas/${alertId}`, {
        withCredentials: true,
      })
      .subscribe({
        next: () => {
          this.alerts.update((current) => current.filter((a) => a.id !== alertId));
          this.isDeletingAlert.set('');
        },
        error: () => {
          this.isDeletingAlert.set('');
          this.errorMessage.set('No se pudo eliminar la alerta.');
        },
      });
  }
}
