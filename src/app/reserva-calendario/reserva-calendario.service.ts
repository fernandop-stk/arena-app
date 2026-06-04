import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { AppointmentType } from '../citas/citas.service';
import { Observable, map } from 'rxjs';

export interface CalendarDay {
  iso: string;
  dayName: string;
  dayNumber: number;
  monthName: string;
}

@Injectable({
  providedIn: 'root',
})
export class ReservaCalendarioService {
  constructor(private readonly http: HttpClient) {}

  getTitle(): string {
    return 'Elige día y hora';
  }

  getDescription(): string {
    return 'Selecciona primero el tipo de cita. Las horas se calculan según su duración.';
  }

  getContinueButtonLabel(): string {
    return 'Continuar con mis datos';
  }

  getCalendarDays(totalDays: number): CalendarDay[] {
    const today = new Date();

    return Array.from({ length: totalDays }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() + index);

      return {
        iso: this.toIsoDate(date),
        dayName: date.toLocaleDateString('es-ES', { weekday: 'short' }),
        dayNumber: date.getDate(),
        monthName: date.toLocaleDateString('es-ES', { month: 'short' }),
      };
    });
  }

  getSelectedTypeFromQuery(queryType: string | null, appointmentTypes: AppointmentType[]): number {
    const parsedType = Number(queryType);
    const exists = appointmentTypes.some((type) => type.id === parsedType);

    if (exists) {
      return parsedType;
    }

    return appointmentTypes[0]?.id ?? 0;
  }

  getTypeDuration(appointmentTypes: AppointmentType[], appointmentTypeId: number): number {
    return appointmentTypes.find((item) => item.id === appointmentTypeId)?.duracionMinutos ?? 0;
  }

  getTypeName(appointmentTypes: AppointmentType[], appointmentTypeId: number): string {
    return appointmentTypes.find((item) => item.id === appointmentTypeId)?.nombre ?? '';
  }

  getAvailableTimeSlots(durationMinutes: number): string[] {
    const openMinutes = 9 * 60;
    const closeMinutes = 20 * 60;
    const stepMinutes = 30;
    const lastStart = closeMinutes - durationMinutes;

    const slots: string[] = [];

    for (let current = openMinutes; current <= lastStart; current += stepMinutes) {
      slots.push(this.formatTime(current));
    }

    return slots;
  }

  getAvailableTimeSlotsFromApi(dateIso: string, durationMinutes: number): Observable<string[]> {
    const params = new HttpParams()
      .set('dateIso', dateIso)
      .set('durationMinutes', durationMinutes.toString());

    return this.http
      .get<{ ok: boolean; slots: string[] }>('/api/reservas/disponibilidad', { params })
      .pipe(map((response) => response.slots ?? []));
  }

  hasCompleteSelection(selectedDateIso: string, selectedTime: string): boolean {
    return Boolean(selectedDateIso && selectedTime);
  }

  createAlert(data: {
    dateIso: string;
    startTime: string;
    endTime: string;
    appointmentTypeName: string;
  }): Observable<{ ok: boolean; alert: any }> {
    return this.http.post<{ ok: boolean; alert: any }>('/api/cliente/alertas', data, {
      withCredentials: true,
    });
  }

  private toIsoDate(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  private formatTime(minutes: number): string {
    const hours = Math.floor(minutes / 60)
      .toString()
      .padStart(2, '0');
    const mins = (minutes % 60).toString().padStart(2, '0');

    return `${hours}:${mins}`;
  }
}
