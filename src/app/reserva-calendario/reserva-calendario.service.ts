import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { AppointmentType } from '../citas/citas.service';
import { Observable, catchError, map, of, tap } from 'rxjs';

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
  private static readonly WEEKDAY_FIRST_START_MINUTES = 10 * 60;
  private static readonly WEEKDAY_LAST_START_MINUTES = 18 * 60;
  private static readonly WEEKDAY_CLOSING_MINUTES = 19 * 60;
  private static readonly SATURDAY_FIRST_START_MINUTES = 9 * 60;
  private static readonly SATURDAY_LAST_START_MINUTES = 13 * 60;
  private static readonly SATURDAY_CLOSING_MINUTES = 14 * 60;
  private static readonly MIDDAY_CLOSED_START_MINUTES = 14 * 60;
  private static readonly MIDDAY_CLOSED_END_MINUTES = 15 * 60;
  // Más de 4 h: el tratamiento puede atravesar el cierre de mediodía (misma regla que el servidor).
  private static readonly LONG_TREATMENT_MIN_MINUTES = 4 * 60;

  /** Días normalmente cerrados (domingo/lunes) que la admin ha abierto expresamente. */
  private readonly openDays = signal<Set<string>>(new Set());

  loadOpenDays(): Observable<string[]> {
    return this.http
      .get<{ ok: boolean; openDays?: string[] }>('/api/reservas/dias-abiertos')
      .pipe(
        map((response) => response.openDays ?? []),
        catchError(() => of([] as string[])),
        tap((openDays) => this.openDays.set(new Set(openDays))),
      );
  }

  isAdminOpenedDay(dateIso: string): boolean {
    return this.openDays().has(dateIso);
  }

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

  getAvailableTimeSlotsFromApi(
    dateIso: string,
    durationMinutes: number,
  ): Observable<{ slots: string[]; blockedSlots: string[] }> {
    const params = new HttpParams()
      .set('dateIso', dateIso)
      .set('durationMinutes', durationMinutes.toString())
      .set('soloAdmin', 'true');

    return this.http
      .get<{ ok: boolean; slots: string[]; blockedSlots?: string[] }>(
        '/api/reservas/disponibilidad',
        { params },
      )
      .pipe(
        map((response) => ({
          slots: response.slots ?? [],
          blockedSlots: response.blockedSlots ?? [],
        })),
      );
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
    if (this.isAdminOpenedDay(dateIso)) {
      return false;
    }

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

    const startMinutes = hours * 60 + minutes;

    if (this.isLongTreatment(durationMinutes)) {
      return this.isStartInsideMiddayClosure(dateIso, time);
    }

    return this.overlapsMiddayClosure(startMinutes, durationMinutes);
  }

  isLongTreatment(durationMinutes: number): boolean {
    return durationMinutes > ReservaCalendarioService.LONG_TREATMENT_MIN_MINUTES;
  }

  isStartInsideMiddayClosure(dateIso: string, time: string): boolean {
    if (this.getWeekDay(dateIso) === ReservaCalendarioService.SATURDAY_WEEKDAY) {
      return false;
    }

    const startMinutes = this.toMinutes(time);

    return (
      startMinutes >= ReservaCalendarioService.MIDDAY_CLOSED_START_MINUTES &&
      startMinutes < ReservaCalendarioService.MIDDAY_CLOSED_END_MINUTES
    );
  }

  getClosingTime(dateIso: string): string {
    const serviceWindow = this.getServiceWindowByDate(dateIso);

    return serviceWindow ? this.formatTime(serviceWindow.closingMinutes) : '';
  }

  /** Devuelve la hora de fin si el tratamiento acabaría después del cierre; si cabe, null. */
  getEndTimeIfExceedsClosing(dateIso: string, time: string, durationMinutes: number): string | null {
    const serviceWindow = this.getServiceWindowByDate(dateIso);
    const startMinutes = this.toMinutes(time);

    if (!serviceWindow || startMinutes < 0) {
      return null;
    }

    const endMinutes = startMinutes + durationMinutes;

    return endMinutes > serviceWindow.closingMinutes ? this.formatTime(endMinutes) : null;
  }

  private toMinutes(time: string): number {
    const [hoursRaw, minutesRaw] = time.split(':');
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);

    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return -1;
    }

    return hours * 60 + minutes;
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
  ): { firstStartMinutes: number; lastStartMinutes: number; closingMinutes: number } | null {
    const weekDay = this.getWeekDay(dateIso);

    if (weekDay === null) {
      return null;
    }

    if (this.isAdminOpenedDay(dateIso)) {
      // Un día abierto por la admin funciona como un día laborable normal.
      return {
        firstStartMinutes: ReservaCalendarioService.WEEKDAY_FIRST_START_MINUTES,
        lastStartMinutes: ReservaCalendarioService.WEEKDAY_LAST_START_MINUTES,
        closingMinutes: ReservaCalendarioService.WEEKDAY_CLOSING_MINUTES,
      };
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
        closingMinutes: ReservaCalendarioService.SATURDAY_CLOSING_MINUTES,
      };
    }

    return {
      firstStartMinutes: ReservaCalendarioService.WEEKDAY_FIRST_START_MINUTES,
      lastStartMinutes: ReservaCalendarioService.WEEKDAY_LAST_START_MINUTES,
      closingMinutes: ReservaCalendarioService.WEEKDAY_CLOSING_MINUTES,
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
