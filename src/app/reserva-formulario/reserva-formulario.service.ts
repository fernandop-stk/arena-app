import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ReservationSelection } from '../reserva-state.service';
import { Observable } from 'rxjs';

export interface ReservationEmailPayload {
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  appointmentTypeName: string;
  dateIso: string;
  time: string;
  durationMinutes: number;
  establishmentAddress: string;
  establishmentPhone: string;
}

@Injectable({
  providedIn: 'root',
})
export class ReservaFormularioService {
  constructor(private readonly http: HttpClient) {}

  getEstablishmentAddress(): string {
    return 'C. de Castilla, 4, 28320 Pinto, Madrid';
  }

  getEstablishmentPhone(): string {
    return '618787878';
  }

  getTitle(): string {
    return 'Completa tus datos';
  }

  getDescription(): string {
    return 'Necesitamos esta información para confirmar tu cita.';
  }

  getSubmitButtonLabel(): string {
    return 'Confirmar reserva';
  }

  buildForm(formBuilder: FormBuilder): FormGroup {
    return formBuilder.group({
      nombre: ['', [Validators.required, Validators.minLength(2)]],
      telefono: ['', [Validators.required, Validators.pattern(/^[0-9+\s-]{9,15}$/)]],
      email: ['', [Validators.required, Validators.email]],
    });
  }

  isFieldInvalid(form: FormGroup, fieldName: string): boolean {
    const field = form.get(fieldName);
    return Boolean(field && field.invalid && (field.dirty || field.touched));
  }

  getSuccessMessage(nombre: string): string {
    return `Gracias ${nombre}, tu reserva ha quedado registrada.`;
  }

  getErrorMessage(): string {
    return 'No se pudo enviar el email de confirmación. Inténtalo de nuevo.';
  }

  createReservationEmailPayload(
    customerEmail: string,
    customerName: string,
    customerPhone: string,
    appointmentTypeName: string,
    durationMinutes: number,
    reservationSelection: ReservationSelection,
  ): ReservationEmailPayload {
    return {
      customerEmail,
      customerName,
      customerPhone,
      appointmentTypeName,
      dateIso: reservationSelection.dateIso,
      time: reservationSelection.time,
      durationMinutes,
      establishmentAddress: this.getEstablishmentAddress(),
      establishmentPhone: this.getEstablishmentPhone(),
    };
  }

  sendReservationConfirmationEmail(payload: ReservationEmailPayload): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/reservas/email', payload);
  }
}
