import { Component, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CitasService } from '../citas/citas.service';
import { ReservaStateService } from '../reserva-state.service';
import { ReservaFormularioService } from './reserva-formulario.service';
import { NotificationService } from '../admin-panel/services/notification.service';

@Component({
  selector: 'app-reserva-formulario',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './reserva-formulario.html',
  styleUrl: './reserva-formulario.scss',
})
export class ReservaFormularioComponent {
  private readonly formBuilder = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly citasService = inject(CitasService);
  private readonly reservaStateService = inject(ReservaStateService);
  private readonly notificationService = inject(NotificationService);

  protected readonly reservaFormularioService = inject(ReservaFormularioService);
  protected readonly title = this.reservaFormularioService.getTitle();
  protected readonly description = this.reservaFormularioService.getDescription();
  protected readonly submitLabel = this.reservaFormularioService.getSubmitButtonLabel();
  protected readonly form = this.reservaFormularioService.buildForm(this.formBuilder);
  protected readonly successMessage = signal('');
  protected readonly errorMessage = signal('');
  protected readonly isSubmitting = signal(false);
  protected readonly isClientAuthenticated = signal(false);

  protected readonly reservationSelection = this.reservaStateService.getSelection();
  protected readonly appointmentTypeName = this.getAppointmentTypeName();
  protected readonly appointmentTypeDuration = this.getSelectedDurationMinutes();
  protected readonly requiresReservationSignal = this.isReservationSignalRequired();
  protected readonly provisionalHoldHours = this.getProvisionalHoldHours();
  protected readonly showUrgentWarning = signal(this.isSelectionLessThan24Hours());
  protected readonly establishmentPhone = this.reservaFormularioService.getEstablishmentPhone();
  protected readonly showTreatmentPhoneWarning = signal(this.isTreatmentPhoneOnly());

  protected getSummaryDateLabel(): string {
    const dateIso = this.reservationSelection?.dateIso;

    if (!dateIso) {
      return '';
    }

    const date = new Date(`${dateIso}T00:00:00`);

    return date.toLocaleDateString('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }

  protected closeSuccessModal(): Promise<boolean> {
    this.successMessage.set('');
    return this.router.navigate(['/']);
  }

  constructor() {
    if (!this.reservaStateService.hasSelection()) {
      this.router.navigate(['/reservas/calendario']);
    }

    this.loadClientSession();
  }

  protected isFieldInvalid(fieldName: string): boolean {
    return this.reservaFormularioService.isFieldInvalid(this.form, fieldName);
  }

  protected submitReservation(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    if (!this.reservationSelection) {
      return;
    }

    const nombre = this.form.get('nombre')?.value ?? '';
    const email = this.form.get('email')?.value ?? '';
    const telefono = this.form.get('telefono')?.value ?? '';
    const observaciones = (this.form.get('observaciones')?.value as string) ?? '';

    const payload = this.reservaFormularioService.createReservationEmailPayload(
      email,
      nombre,
      telefono,
      this.appointmentTypeName,
      this.appointmentTypeDuration,
      this.reservationSelection,
      observaciones,
      this.requiresReservationSignal,
    );

    this.errorMessage.set('');
    this.isSubmitting.set(true);

    this.reservaFormularioService.sendReservationConfirmationEmail(payload).subscribe({
      next: () => {
        this.successMessage.set(this.reservaFormularioService.getSuccessMessage(nombre));
        this.reservaStateService.clearSelection();
        void this.notificationService.requestRefresh();
        this.form.disable();
        window.setTimeout(() => {
          if (this.successMessage()) {
            void this.closeSuccessModal();
          }
        }, 15000);
      },
      error: (error: unknown) => {
        this.onSubmitError(error);
      },
      complete: () => {
        this.isSubmitting.set(false);
      },
    });
  }

  protected onSubmitError(error: unknown): void {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 409 && this.reservationSelection) {
        void this.router.navigate(['/reservas/calendario'], {
          queryParams: {
            tipo: this.reservationSelection.appointmentTypeId,
            date: this.reservationSelection.dateIso,
            durationMinutes: this.reservationSelection.durationMinutes,
          },
        });
        return;
      }

      const apiMessage = error.error?.error;

      if (typeof apiMessage === 'string' && apiMessage.length > 0) {
        this.errorMessage.set(apiMessage);
        return;
      }
    }

    this.errorMessage.set(this.reservaFormularioService.getErrorMessage());
  }

  private getAppointmentTypeName(): string {
    const appointmentTypeId = this.reservationSelection?.appointmentTypeId ?? 0;
    const appointmentTypes = this.citasService.getAppointmentTypes();

    return appointmentTypes.find((item) => item.id === appointmentTypeId)?.nombre ?? '';
  }

  private getAppointmentTypeDuration(): number {
    const appointmentTypeId = this.reservationSelection?.appointmentTypeId ?? 0;
    const appointmentTypes = this.citasService.getAppointmentTypes();

    return appointmentTypes.find((item) => item.id === appointmentTypeId)?.duracionMinutos ?? 0;
  }

  private getSelectedDurationMinutes(): number {
    if (
      this.reservationSelection?.durationMinutes &&
      this.reservationSelection.durationMinutes > 0
    ) {
      return this.reservationSelection.durationMinutes;
    }

    return this.getAppointmentTypeDuration();
  }

  private isSelectionLessThan24Hours(): boolean {
    const selection = this.reservaStateService.getSelection();

    if (!selection?.dateIso || !selection?.time) {
      return false;
    }

    const [hours, minutes] = selection.time.split(':').map(Number);
    const appointmentDate = new Date(`${selection.dateIso}T00:00:00`);
    appointmentDate.setHours(hours, minutes, 0, 0);

    const diffMs = appointmentDate.getTime() - Date.now();
    const diffHours = diffMs / (1000 * 60 * 60);

    return diffHours > 0 && diffHours < 24;
  }

  protected dismissUrgentWarning(): void {
    this.showUrgentWarning.set(false);
  }

  protected dismissTreatmentWarning(): void {
    this.showTreatmentPhoneWarning.set(false);
  }

  private isTreatmentPhoneOnly(): boolean {
    // Pack Color (4), Pack Color Plus (5), Pack Ilumina (6), Pack Full Color (7) → recomendar teléfono
    const phoneOnlyIds = [4, 5, 6, 7];
    const id = this.reservationSelection?.appointmentTypeId ?? 0;
    return phoneOnlyIds.includes(id);
  }

  private isReservationSignalRequired(): boolean {
    const appointmentTypeId = this.reservationSelection?.appointmentTypeId ?? 0;

    return this.citasService.requiresReservationSignal(appointmentTypeId);
  }

  private getProvisionalHoldHours(): number {
    const appointmentTypeId = this.reservationSelection?.appointmentTypeId ?? 0;

    return this.citasService.getProvisionalHoldHours(appointmentTypeId);
  }

  private loadClientSession(): void {
    this.http
      .get<{
        ok: boolean;
        isAuthenticated: boolean;
        client?: {
          fullName?: string;
          phone?: string;
          email?: string;
        } | null;
      }>('/api/cliente/session')
      .subscribe({
        next: (response) => {
          const isAuthenticated = Boolean(response?.isAuthenticated);
          this.isClientAuthenticated.set(isAuthenticated);

          if (!isAuthenticated || !response.client) {
            return;
          }

          this.form.patchValue({
            nombre: response.client.fullName ?? '',
            telefono: response.client.phone ?? '',
            email: response.client.email ?? '',
          });
        },
        error: () => {
          this.isClientAuthenticated.set(false);
        },
      });
  }
}
