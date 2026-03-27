import { HttpClient } from '@angular/common/http';
import { Component, afterNextRender, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

type AdminTab = 'listado' | 'gestion' | 'bloqueos';

interface AdminReservationItem {
  id: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  appointmentTypeName: string;
  paymentReceived: boolean;
  adminStatus: 'pending' | 'accepted' | 'rejected';
  createdAtIso: string;
}

interface AdminBlockedPeriodItem {
  id: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  reason: string;
  createdAtIso: string;
}

interface AdminCalendarDay {
  dateIso: string;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isPast: boolean;
  isFullBlocked: boolean;
  hasPartialBlocked: boolean;
  reservationCount: number;
}

@Component({
  selector: 'app-admin-panel',
  imports: [RouterLink],
  templateUrl: './admin-panel.html',
  styleUrl: './admin-panel.scss',
})
export class AdminPanelComponent {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  protected readonly isChecking = signal(true);
  protected readonly activeTab = signal<AdminTab>('listado');
  protected readonly isLoadingReservations = signal(false);
  protected readonly isLoadingBlockedPeriods = signal(false);
  protected readonly ownerEmail = signal('');
  protected readonly reservations = signal<AdminReservationItem[]>([]);
  protected readonly blockedPeriods = signal<AdminBlockedPeriodItem[]>([]);
  protected readonly listError = signal('');
  protected readonly actionError = signal('');
  protected readonly actionLoadingId = signal('');
  protected readonly blockDateIso = signal('');
  protected readonly calendarMonthIso = signal('');
  protected readonly blockStartTime = signal('09:00');
  protected readonly blockEndTime = signal('20:00');
  protected readonly blockStartOptions = this.buildHalfHourOptions('09:00', '19:30');
  protected readonly blockEndOptions = this.buildHalfHourOptions('09:30', '20:00');
  protected readonly blockReason = signal('');
  protected readonly isFullDayBlock = signal(true);
  protected readonly blockMessage = signal('');
  protected readonly blockError = signal('');
  protected readonly blockActionLoading = signal(false);
  protected readonly showDayReservationsModal = signal(false);
  protected readonly dayReservationsDateIso = signal('');
  protected readonly dayReservations = signal<AdminReservationItem[]>([]);

  constructor() {
    // Use afterNextRender so the session check only runs AFTER full hydration.
    // Making HTTP calls during hydration with withEventReplay() can cause the
    // observable to never complete, leaving isChecking=true forever.
    afterNextRender(() => {
      this.http
        .get<{
          ok: boolean;
          isAdmin: boolean;
          email?: string;
          username?: string;
        }>('/api/auth/session')
        .subscribe({
          next: (response) => {
            if (!response.isAdmin) {
              void this.router.navigate(['/acceso']);
              return;
            }

            this.ownerEmail.set(response.email ?? '');
            this.loadReservations();
            this.loadBlockedPeriods();

            const today = new Date();
            const year = today.getFullYear();
            const month = `${today.getMonth() + 1}`.padStart(2, '0');
            const day = `${today.getDate()}`.padStart(2, '0');
            this.blockDateIso.set(`${year}-${month}-${day}`);
            this.calendarMonthIso.set(`${year}-${month}`);
          },
          error: () => {
            this.isChecking.set(false);
            void this.router.navigate(['/acceso']);
          },
          complete: () => {
            this.isChecking.set(false);
          },
        });
    });
  }

  protected setActiveTab(tab: AdminTab): void {
    this.activeTab.set(tab);
    this.listError.set('');
    this.actionError.set('');
    this.blockError.set('');
    this.blockMessage.set('');
  }

  protected getPendingReservationsCount(): number {
    return this.reservations().filter((reservation) => reservation.adminStatus === 'pending')
      .length;
  }

  protected getTodayIso(): string {
    const today = new Date();
    const year = today.getFullYear();
    const month = `${today.getMonth() + 1}`.padStart(2, '0');
    const day = `${today.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  protected onBlockDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.blockDateIso.set(target.value);

    if (target.value.length >= 7) {
      this.calendarMonthIso.set(target.value.slice(0, 7));
    }
  }

  protected onCalendarMonthInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.calendarMonthIso.set(target.value);
  }

  protected goToPreviousMonth(): void {
    this.shiftCalendarMonth(-1);
  }

  protected goToNextMonth(): void {
    this.shiftCalendarMonth(1);
  }

  protected onBlockStartTimeInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.blockStartTime.set(target.value);
  }

  protected onBlockEndTimeInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.blockEndTime.set(target.value);
  }

  protected onBlockReasonInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.blockReason.set(target.value);
  }

  protected selectFullDayMode(): void {
    this.isFullDayBlock.set(true);
    this.blockStartTime.set('09:00');
    this.blockEndTime.set('20:00');
  }

  protected selectHourlyMode(): void {
    this.isFullDayBlock.set(false);

    if (this.blockStartTime() === '09:00' && this.blockEndTime() === '20:00') {
      this.blockStartTime.set('09:00');
      this.blockEndTime.set('10:00');
    }
  }

  protected onFullDayBlockChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.isFullDayBlock.set(target.checked);

    if (target.checked) {
      this.blockStartTime.set('09:00');
      this.blockEndTime.set('20:00');
    }
  }

  protected formatDuration(minutes: number): string {
    if (minutes < 60) {
      return `${minutes} min`;
    }

    const hours = minutes / 60;

    if (Number.isInteger(hours)) {
      return hours === 1 ? '1 hora' : `${hours} horas`;
    }

    return `${Math.floor(hours)} h ${minutes % 60} min`;
  }

  protected formatDate(dateIso: string): string {
    const date = new Date(`${dateIso}T00:00:00`);

    return date.toLocaleDateString('es-ES', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  protected isActionLoading(id: string): boolean {
    return this.actionLoadingId() === id;
  }

  protected formatTimeRange(startTime: string, endTime: string): string {
    if (startTime === '09:00' && endTime === '20:00') {
      return 'Día completo';
    }

    return `${startTime} - ${endTime}`;
  }

  protected getCalendarMonthLabel(): string {
    const monthIso = this.calendarMonthIso();

    if (!monthIso) {
      return '';
    }

    const date = new Date(`${monthIso}-01T00:00:00`);

    return date.toLocaleDateString('es-ES', {
      month: 'long',
      year: 'numeric',
    });
  }

  protected getCalendarDays(): AdminCalendarDay[] {
    const monthIso = this.calendarMonthIso();

    if (!monthIso) {
      return [];
    }

    const [yearRaw, monthRaw] = monthIso.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);

    if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
      return [];
    }

    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    const firstWeekday = (monthStart.getDay() + 6) % 7;
    const gridStart = new Date(year, month - 1, 1 - firstWeekday);

    const blockedPeriodsByDate = new Map<string, AdminBlockedPeriodItem[]>();

    this.blockedPeriods().forEach((blockedPeriod) => {
      const current = blockedPeriodsByDate.get(blockedPeriod.dateIso) ?? [];
      current.push(blockedPeriod);
      blockedPeriodsByDate.set(blockedPeriod.dateIso, current);
    });

    const reservationsByDate = new Map<string, number>();

    this.reservations().forEach((reservation) => {
      const current = reservationsByDate.get(reservation.dateIso) ?? 0;
      reservationsByDate.set(reservation.dateIso, current + 1);
    });

    const todayIso = this.getTodayIso();
    const days: AdminCalendarDay[] = [];

    for (let index = 0; index < 42; index += 1) {
      const dayDate = new Date(gridStart);
      dayDate.setDate(gridStart.getDate() + index);
      const yearValue = dayDate.getFullYear();
      const monthValue = `${dayDate.getMonth() + 1}`.padStart(2, '0');
      const dayValue = `${dayDate.getDate()}`.padStart(2, '0');
      const dateIso = `${yearValue}-${monthValue}-${dayValue}`;
      const periods = blockedPeriodsByDate.get(dateIso) ?? [];
      const isFullBlocked = periods.some(
        (blockedPeriod) => blockedPeriod.startTime === '09:00' && blockedPeriod.endTime === '20:00',
      );

      days.push({
        dateIso,
        dayNumber: dayDate.getDate(),
        isCurrentMonth: dayDate >= monthStart && dayDate <= monthEnd,
        isToday: dateIso === todayIso,
        isPast: dateIso < todayIso,
        isFullBlocked,
        hasPartialBlocked: !isFullBlocked && periods.length > 0,
        reservationCount: reservationsByDate.get(dateIso) ?? 0,
      });
    }

    return days;
  }

  protected selectCalendarDay(day: AdminCalendarDay): void {
    if (!day.isCurrentMonth || day.isPast) {
      return;
    }

    this.blockDateIso.set(day.dateIso);
    this.blockError.set('');
    this.blockMessage.set('');

    const reservationsForDay = this.reservations().filter(
      (reservation) => reservation.dateIso === day.dateIso,
    );

    if (reservationsForDay.length > 0) {
      this.dayReservationsDateIso.set(day.dateIso);
      this.dayReservations.set(reservationsForDay);
      this.showDayReservationsModal.set(true);
      return;
    }

    this.closeDayReservationsModal();
  }

  protected isCalendarDaySelected(day: AdminCalendarDay): boolean {
    return this.blockDateIso() === day.dateIso;
  }

  protected closeDayReservationsModal(): void {
    this.showDayReservationsModal.set(false);
    this.dayReservationsDateIso.set('');
    this.dayReservations.set([]);
  }

  protected markPaymentReceived(reservationId: string, paymentReceived: boolean): void {
    this.actionError.set('');
    this.actionLoadingId.set(reservationId);

    this.http
      .patch<{ ok: boolean; error?: string }>(`/api/admin/reservas/${reservationId}/payment`, {
        paymentReceived,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.actionError.set(response.error ?? 'No se pudo actualizar el pago.');
            return;
          }

          this.loadReservations();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.actionError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo actualizar el pago.',
          );
        },
        complete: () => {
          this.actionLoadingId.set('');
        },
      });
  }

  protected setReservationStatus(reservationId: string, status: 'accepted' | 'rejected'): void {
    this.actionError.set('');
    this.actionLoadingId.set(reservationId);

    this.http
      .patch<{ ok: boolean; error?: string }>(`/api/admin/reservas/${reservationId}/status`, {
        status,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.actionError.set(response.error ?? 'No se pudo actualizar el estado.');
            return;
          }

          this.loadReservations();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.actionError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo actualizar el estado.',
          );
        },
        complete: () => {
          this.actionLoadingId.set('');
        },
      });
  }

  protected getStatusLabel(status: AdminReservationItem['adminStatus']): string {
    if (status === 'accepted') {
      return 'Aceptada';
    }

    if (status === 'rejected') {
      return 'Rechazada';
    }

    return 'Pendiente';
  }

  protected createBlockedPeriod(): void {
    this.blockError.set('');
    this.blockMessage.set('');

    const dateIso = this.blockDateIso();
    const startTime = this.isFullDayBlock() ? '09:00' : this.blockStartTime();
    const endTime = this.isFullDayBlock() ? '20:00' : this.blockEndTime();
    const reason = this.blockReason();

    if (!dateIso) {
      this.blockError.set('Debes seleccionar una fecha para bloquear.');
      return;
    }

    this.blockActionLoading.set(true);

    this.http
      .post<{ ok: boolean; error?: string }>('/api/admin/bloqueos', {
        dateIso,
        startTime,
        endTime,
        reason,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.blockError.set(response.error ?? 'No se pudo crear el bloqueo.');
            return;
          }

          this.blockMessage.set('Bloqueo guardado correctamente.');
          this.blockReason.set('');
          this.loadBlockedPeriods();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.blockError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo crear el bloqueo.',
          );
        },
        complete: () => {
          this.blockActionLoading.set(false);
        },
      });
  }

  protected deleteBlockedPeriod(blockId: string): void {
    this.blockError.set('');
    this.blockMessage.set('');
    this.blockActionLoading.set(true);

    this.http.delete<{ ok: boolean; error?: string }>(`/api/admin/bloqueos/${blockId}`).subscribe({
      next: (response) => {
        if (!response.ok) {
          this.blockError.set(response.error ?? 'No se pudo eliminar el bloqueo.');
          return;
        }

        this.blockMessage.set('Bloqueo eliminado.');
        this.loadBlockedPeriods();
      },
      error: (error) => {
        const apiError = error?.error?.error;
        this.blockError.set(
          typeof apiError === 'string' && apiError ? apiError : 'No se pudo eliminar el bloqueo.',
        );
      },
      complete: () => {
        this.blockActionLoading.set(false);
      },
    });
  }

  private loadReservations(): void {
    this.isLoadingReservations.set(true);
    this.listError.set('');

    this.http
      .get<{
        ok: boolean;
        reservations?: AdminReservationItem[];
        error?: string;
      }>('/api/admin/reservas')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.listError.set(response.error ?? 'No se pudieron cargar las reservas.');
            return;
          }

          this.reservations.set(response.reservations ?? []);
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.listError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudieron cargar las reservas.',
          );
          this.isLoadingReservations.set(false);
        },
        complete: () => {
          this.isLoadingReservations.set(false);
        },
      });
  }

  private loadBlockedPeriods(): void {
    this.isLoadingBlockedPeriods.set(true);

    this.http
      .get<{
        ok: boolean;
        blockedPeriods?: AdminBlockedPeriodItem[];
        error?: string;
      }>('/api/admin/bloqueos')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.blockError.set(response.error ?? 'No se pudieron cargar los bloqueos.');
            return;
          }

          this.blockedPeriods.set(response.blockedPeriods ?? []);
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.blockError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudieron cargar los bloqueos.',
          );
          this.isLoadingBlockedPeriods.set(false);
        },
        complete: () => {
          this.isLoadingBlockedPeriods.set(false);
        },
      });
  }

  protected logout(): void {
    this.http.post<{ ok: boolean }>('/api/auth/logout', {}).subscribe({
      complete: () => {
        void this.router.navigate(['/acceso']);
      },
    });
  }

  private shiftCalendarMonth(offset: number): void {
    const monthIso = this.calendarMonthIso();

    if (!monthIso) {
      return;
    }

    const [yearRaw, monthRaw] = monthIso.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);

    if (Number.isNaN(year) || Number.isNaN(month)) {
      return;
    }

    const targetDate = new Date(year, month - 1 + offset, 1);
    const targetYear = targetDate.getFullYear();
    const targetMonth = `${targetDate.getMonth() + 1}`.padStart(2, '0');
    this.calendarMonthIso.set(`${targetYear}-${targetMonth}`);
  }

  private buildHalfHourOptions(startTime: string, endTime: string): string[] {
    const parseTime = (time: string): number => {
      const [hoursRaw, minutesRaw] = time.split(':');
      const hours = Number(hoursRaw);
      const minutes = Number(minutesRaw);

      if (Number.isNaN(hours) || Number.isNaN(minutes)) {
        return 0;
      }

      return hours * 60 + minutes;
    };

    const toTime = (minutesTotal: number): string => {
      const hours = Math.floor(minutesTotal / 60)
        .toString()
        .padStart(2, '0');
      const minutes = (minutesTotal % 60).toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    };

    const start = parseTime(startTime);
    const end = parseTime(endTime);
    const options: string[] = [];

    for (let current = start; current <= end; current += 30) {
      options.push(toTime(current));
    }

    return options;
  }
}
