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

  private static readonly MONDAY_WEEKDAY = 1;
  private static readonly SUNDAY_WEEKDAY = 0;
  private static readonly SATURDAY_WEEKDAY = 6;
  private static readonly WEEKDAY_FIRST_START_MINUTES = 10 * 60 + 30;
  private static readonly WEEKDAY_LAST_START_MINUTES = 18 * 60;
  private static readonly SATURDAY_FIRST_START_MINUTES = 9 * 60;
  private static readonly SATURDAY_LAST_START_MINUTES = 14 * 60;
  private static readonly MIDDAY_CLOSED_START_MINUTES = 14 * 60;
  private static readonly MIDDAY_CLOSED_END_MINUTES = 15 * 60;

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

  getAvailableTimeSlots(dateIso: string, durationMinutes: number): string[] {
    const serviceWindow = this.getServiceWindowByDate(dateIso);

    if (!serviceWindow) {
      return [];
    }

    const stepMinutes = 30;
    const { firstStartMinutes, lastStartMinutes } = serviceWindow;

    const slots: string[] = [];

    for (let current = firstStartMinutes; current <= lastStartMinutes; current += stepMinutes) {
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

  isRecurringClosedDay(dateIso: string): boolean {
    const date = new Date(`${dateIso}T00:00:00`);

    if (Number.isNaN(date.getTime())) {
      return false;
    }

    const weekDay = date.getDay();
    return (
      weekDay === ReservaCalendarioService.SUNDAY_WEEKDAY ||
      weekDay === ReservaCalendarioService.MONDAY_WEEKDAY
    );
  }

  isRecurringClosedSlot(dateIso: string, time: string, durationMinutes: number): boolean {
    if (this.isRecurringClosedDay(dateIso)) {
      return true;
    }

    if (this.getWeekDay(dateIso) === ReservaCalendarioService.SATURDAY_WEEKDAY) {
      return false;
    }

    const [hoursRaw, minutesRaw] = time.split(':');
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);

    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return false;
    }

    return this.overlapsMiddayClosure(hours * 60 + minutes, durationMinutes);
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

  private getServiceWindowByDate(
    dateIso: string,
  ): { firstStartMinutes: number; lastStartMinutes: number } | null {
    const weekDay = this.getWeekDay(dateIso);

    if (weekDay === null) {
      return null;
    }

    if (
      weekDay === ReservaCalendarioService.SUNDAY_WEEKDAY ||
      weekDay === ReservaCalendarioService.MONDAY_WEEKDAY
    ) {
      return null;
    }

    if (weekDay === ReservaCalendarioService.SATURDAY_WEEKDAY) {
      return {
        firstStartMinutes: ReservaCalendarioService.SATURDAY_FIRST_START_MINUTES,
        lastStartMinutes: ReservaCalendarioService.SATURDAY_LAST_START_MINUTES,
      };
    }

    return {
      firstStartMinutes: ReservaCalendarioService.WEEKDAY_FIRST_START_MINUTES,
      lastStartMinutes: ReservaCalendarioService.WEEKDAY_LAST_START_MINUTES,
    };
  }

  private overlapsMiddayClosure(startMinutes: number, durationMinutes: number): boolean {
    const endMinutes = startMinutes + durationMinutes;

    return (
      startMinutes < ReservaCalendarioService.MIDDAY_CLOSED_END_MINUTES &&
      endMinutes > ReservaCalendarioService.MIDDAY_CLOSED_START_MINUTES
    );
  }

  private getWeekDay(dateIso: string): number | null {
    const date = new Date(`${dateIso}T00:00:00`);

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date.getDay();
  }
}
