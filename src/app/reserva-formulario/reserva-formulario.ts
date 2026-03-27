import { Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CitasService } from '../citas/citas.service';
import { ReservaStateService } from '../reserva-state.service';
import { ReservaFormularioService } from './reserva-formulario.service';

@Component({
  selector: 'app-reserva-formulario',
  imports: [ReactiveFormsModule],
  templateUrl: './reserva-formulario.html',
  styleUrl: './reserva-formulario.scss',
})
export class ReservaFormularioComponent {
  private readonly formBuilder = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly citasService = inject(CitasService);
  private readonly reservaStateService = inject(ReservaStateService);

  protected readonly reservaFormularioService = inject(ReservaFormularioService);
  protected readonly title = this.reservaFormularioService.getTitle();
  protected readonly description = this.reservaFormularioService.getDescription();
  protected readonly submitLabel = this.reservaFormularioService.getSubmitButtonLabel();
  protected readonly form = this.reservaFormularioService.buildForm(this.formBuilder);
  protected readonly successMessage = signal('');
  protected readonly errorMessage = signal('');
  protected readonly isSubmitting = signal(false);

  protected readonly reservationSelection = this.reservaStateService.getSelection();
  protected readonly appointmentTypeName = this.getAppointmentTypeName();
  protected readonly appointmentTypeDuration = this.getAppointmentTypeDuration();

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

    const payload = this.reservaFormularioService.createReservationEmailPayload(
      email,
      nombre,
      telefono,
      this.appointmentTypeName,
      this.appointmentTypeDuration,
      this.reservationSelection,
    );

    this.errorMessage.set('');
    this.isSubmitting.set(true);

    this.reservaFormularioService.sendReservationConfirmationEmail(payload).subscribe({
      next: () => {
        this.successMessage.set(this.reservaFormularioService.getSuccessMessage(nombre));
        this.reservaStateService.clearSelection();
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
}
