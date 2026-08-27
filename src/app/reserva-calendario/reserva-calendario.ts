import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { CitasService } from '../citas/citas.service';
import { ReservaStateService } from '../reserva-state.service';
import { ReservaCalendarioService } from './reserva-calendario.service';

interface TimeSlotItem {
  time: string;
  disabled: boolean;
  past: boolean;
  reason: 'available' | 'past' | 'occupied' | 'closed';
  statusLabel: string;
}

interface CalendarGridCell {
  key: string;
  day: {
    iso: string;
    dayName: string;
    dayNumber: number;
    monthName: string;
  } | null;
}

@Component({
  selector: 'app-reserva-calendario',
  imports: [RouterLink],
  templateUrl: './reserva-calendario.html',
  styleUrl: './reserva-calendario.scss',
})
export class ReservaCalendarioComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly citasService = inject(CitasService);
  private readonly reservaStateService = inject(ReservaStateService);

  protected readonly reservaCalendarioService = inject(ReservaCalendarioService);
  protected readonly appointmentTypes = this.citasService.getAppointmentTypes();
  protected readonly title = this.reservaCalendarioService.getTitle();
  protected readonly description = this.reservaCalendarioService.getDescription();
  protected readonly continueLabel = this.reservaCalendarioService.getContinueButtonLabel();
  protected readonly visibleMonthDate = signal(this.getMonthStart(new Date()));
  protected readonly days = computed(() => {
    const monthStart = this.visibleMonthDate();
    const year = monthStart.getFullYear();
    const month = monthStart.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    return Array.from({ length: daysInMonth }, (_, index) => {
      const date = new Date(year, month, index + 1);

      return {
        iso: this.toIsoDate(date),
        dayName: date.toLocaleDateString('es-ES', { weekday: 'short' }),
        dayNumber: date.getDate(),
        monthName: date.toLocaleDateString('es-ES', { month: 'short' }),
      };
    });
  });

  protected readonly selectedTypeId = signal(
    this.reservaCalendarioService.getSelectedTypeFromQuery(
      this.route.snapshot.queryParamMap.get('tipo'),
      this.appointmentTypes,
    ),
  );
  protected readonly durationOptions = Array.from({ length: 12 }, (_, index) => (index + 1) * 30);
  protected readonly selectedDurationMinutes = signal(60);
  protected readonly selectedDurationMode = signal<'default' | 'preset' | 'custom'>('default');
  protected readonly customDurationInput = signal('');
  protected readonly selectedDateIso = signal(this.route.snapshot.queryParamMap.get('date') ?? '');
  protected readonly selectedTime = signal('');
  protected readonly timeSlots = signal<TimeSlotItem[]>([]);
  protected readonly dayAvailability = signal<Record<string, boolean>>({});
  protected readonly isLoadingDays = signal(false);
  protected readonly isLoadingSlots = signal(false);
  protected readonly slotsError = signal('');
  protected readonly currentStep = signal(this.route.snapshot.queryParamMap.get('tipo') ? 2 : 1);

  protected readonly visibleMonthLabel = computed(() =>
    this.visibleMonthDate().toLocaleDateString('es-ES', {
      month: 'long',
      year: 'numeric',
    }),
  );
  protected readonly monthGridCells = computed<CalendarGridCell[]>(() => {
    const monthDays = this.days();

    if (monthDays.length === 0) {
      return [];
    }

    const firstDate = new Date(`${monthDays[0].iso}T00:00:00`);
    const leadingEmptyCells = this.getWeekdayColumnIndex(firstDate);
    const cells: CalendarGridCell[] = [];

    for (let index = 0; index < leadingEmptyCells; index += 1) {
      cells.push({ key: `empty-${index}`, day: null });
    }

    monthDays.forEach((day) => {
      cells.push({ key: day.iso, day });
    });

    return cells;
  });

  protected readonly isCreatingAlert = signal(false);
  protected readonly alertError = signal('');
  protected readonly alertSlotTime = signal('');

  constructor() {
    this.initializeDurationFromQuery();
    this.loadDayAvailability();
  }

  protected onTypeChange(appointmentTypeId: number): void {
    this.selectedTypeId.set(appointmentTypeId);
    this.selectedDurationMode.set('default');
    this.customDurationInput.set('');
    this.selectedDurationMinutes.set(this.getDefaultSelectedTypeDuration());
    this.selectedDateIso.set('');
    this.selectedTime.set('');
    this.timeSlots.set([]);
    this.loadDayAvailability();
    this.currentStep.set(2);
  }

  protected canGoToPreviousMonth(): boolean {
    const currentMonthStart = this.getMonthStart(new Date());
    return this.visibleMonthDate().getTime() > currentMonthStart.getTime();
  }

  protected goToPreviousMonth(): void {
    if (!this.canGoToPreviousMonth()) {
      return;
    }

    this.visibleMonthDate.update((currentMonth) =>
      this.getMonthStart(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1)),
    );
    this.loadDayAvailability();
  }

  protected goToNextMonth(): void {
    this.visibleMonthDate.update((currentMonth) =>
      this.getMonthStart(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1)),
    );
    this.loadDayAvailability();
  }

  protected onDurationChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const value = target.value;

    if (value === 'default') {
      this.selectedDurationMode.set('default');
      this.customDurationInput.set('');
      this.updateSelectedDuration(this.getDefaultSelectedTypeDuration());
      return;
    }

    if (value === 'custom') {
      this.selectedDurationMode.set('custom');
      const current = this.selectedDurationMinutes();
      this.customDurationInput.set(`${current}`);
      this.updateSelectedDuration(current);
      return;
    }

    const nextDuration = Number(value);
    this.selectedDurationMode.set('preset');
    this.customDurationInput.set('');
    this.updateSelectedDuration(nextDuration);
  }

  protected onCustomDurationInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const rawValue = `${target.value ?? ''}`;
    this.customDurationInput.set(rawValue);

    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }

    this.updateSelectedDuration(this.normalizeCustomDuration(parsed));
  }

  protected getDurationSelectValue(): string {
    if (this.selectedDurationMode() === 'default') {
      return 'default';
    }

    if (this.selectedDurationMode() === 'custom') {
      return 'custom';
    }

    return `${this.selectedDurationMinutes()}`;
  }

  protected getDefaultDurationLabel(): string {
    return `Predeterminado (${this.formatDurationLabel(this.getDefaultSelectedTypeDuration())})`;
  }

  protected getDurationOptionLabel(duration: number): string {
    return this.formatDurationLabel(duration);
  }

  protected getSelectedDurationLabel(): string {
    return this.formatDurationLabel(this.selectedDurationMinutes());
  }

  protected isCustomDurationSelected(): boolean {
    return this.selectedDurationMode() === 'custom';
  }

  protected onSelectDay(dateIso: string): void {
    if (this.isPastDay(dateIso)) {
      return;
    }

    if (dateIso === this.selectedDateIso() && this.timeSlots().length > 0) {
      this.currentStep.set(3);
      return;
    }

    this.selectedDateIso.set(dateIso);
    this.selectedTime.set('');
    this.refreshSlots();
    this.currentStep.set(3);
  }

  protected onSelectTime(time: string, disabled: boolean): void {
    if (disabled) {
      return;
    }

    this.selectedTime.set(time);
  }

  protected goToStep(step: number): void {
    if (step >= this.currentStep()) {
      return;
    }

    this.currentStep.set(step);

    if (step <= 1) {
      this.selectedDateIso.set('');
      this.selectedTime.set('');
      this.timeSlots.set([]);
    } else if (step === 2) {
      this.selectedTime.set('');
    }
  }

  protected getSelectedDayLabel(): string {
    const iso = this.selectedDateIso();
    if (!iso) return '';
    const day = this.days().find((d) => d.iso === iso);
    if (!day) return iso;
    return `${day.dayName} ${day.dayNumber} ${day.monthName}`;
  }

  protected goToCustomerForm(): Promise<boolean> {
    this.reservaStateService.setSelection({
      appointmentTypeId: this.selectedTypeId(),
      dateIso: this.selectedDateIso(),
      time: this.selectedTime(),
      durationMinutes: this.selectedDurationMinutes(),
    });

    return this.router.navigate(['/reservas/datos']);
  }

  protected joinWaitlist(time: string): void {
    this.reservaStateService.setSelection({
      appointmentTypeId: this.selectedTypeId(),
      dateIso: this.selectedDateIso(),
      time,
      durationMinutes: this.selectedDurationMinutes(),
      isWaitlist: true,
    });

    void this.router.navigate(['/reservas/datos']);
  }

  protected getSelectedTypeName(): string {
    return this.reservaCalendarioService.getTypeName(this.appointmentTypes, this.selectedTypeId());
  }

  protected canContinue(): boolean {
    return this.reservaCalendarioService.hasCompleteSelection(
      this.selectedDateIso(),
      this.selectedTime(),
    );
  }

  protected hasAnyAvailableSlot(): boolean {
    return this.timeSlots().some((slot) => !slot.disabled);
  }

  protected isDayUnavailable(dateIso: string): boolean {
    if (this.isPastDay(dateIso)) {
      return true;
    }

    const availability = this.dayAvailability()[dateIso];

    return availability === false;
  }

  protected getDayStatusLabel(dateIso: string): string {
    if (this.isPastDay(dateIso)) {
      return 'Pasado';
    }

    return this.reservaCalendarioService.isRecurringClosedDay(dateIso) ? 'Cerrado' : 'Completo';
  }

  protected createAlert(slotTime: string): void {
    if (this.isCreatingAlert() || !this.selectedDateIso() || !this.selectedTypeId()) {
      return;
    }

    this.isCreatingAlert.set(true);
    this.alertError.set('');
    this.alertSlotTime.set(slotTime);

    const typeName = this.reservaCalendarioService.getTypeName(
      this.appointmentTypes,
      this.selectedTypeId(),
    );
    const [hours, minutes] = slotTime.split(':').map(Number);
    const duration = this.selectedDurationMinutes();
    const totalStartMinutes = hours * 60 + minutes;
    const totalEndMinutes = totalStartMinutes + duration;
    const endTime = `${String(Math.floor(totalEndMinutes / 60)).padStart(
      2,
      '0',
    )}:${String(totalEndMinutes % 60).padStart(2, '0')}`;

    this.reservaCalendarioService
      .createAlert({
        dateIso: this.selectedDateIso(),
        startTime: slotTime,
        endTime,
        appointmentTypeName: typeName,
      })
      .subscribe({
        next: () => {
          this.alertError.set('');
          this.alertSlotTime.set('');
          // Mostrar mensaje de éxito temporalmente
          setTimeout(() => {
            alert('Alerta creada. Te notificaremos por email cuando se libere este hueco.');
          }, 200);
        },
        error: (err) => {
          const errorMsg = err?.error?.error ?? 'No se pudo crear la alerta. Inténtalo de nuevo.';
          this.alertError.set(errorMsg);
        },
        complete: () => {
          this.isCreatingAlert.set(false);
        },
      });
  }

  private loadDayAvailability(): void {
    const duration = this.selectedDurationMinutes();
    const todayIso = this.toIsoDate(new Date());

    const daysToCheck = this.days().filter((day) => day.iso >= todayIso);

    if (daysToCheck.length === 0) {
      this.dayAvailability.set({});
      this.isLoadingDays.set(false);
      return;
    }

    this.isLoadingDays.set(true);

    forkJoin(
      daysToCheck.map((day) =>
        this.reservaCalendarioService.getAvailableTimeSlotsFromApi(day.iso, duration).pipe(
          map((slots) => ({
            iso: day.iso,
            available: slots.length > 0,
          })),
          catchError(() =>
            of({
              iso: day.iso,
              available: true,
            }),
          ),
        ),
      ),
    ).subscribe({
      next: (results) => {
        const availabilityMap = results.reduce<Record<string, boolean>>((acc, item) => {
          acc[item.iso] = item.available;
          return acc;
        }, {});

        this.dayAvailability.set(availabilityMap);

        if (this.selectedDateIso() && this.isDayUnavailable(this.selectedDateIso())) {
          this.selectedDateIso.set('');
          this.selectedTime.set('');
          this.timeSlots.set([]);
          return;
        }

        if (this.selectedDateIso()) {
          this.refreshSlots();
        }
      },
      complete: () => {
        this.isLoadingDays.set(false);
      },
    });
  }

  private refreshSlots(): void {
    if (!this.selectedDateIso()) {
      this.timeSlots.set([]);
      this.slotsError.set('');
      return;
    }

    const duration = this.selectedDurationMinutes();
    const allSlots = this.reservaCalendarioService.getAvailableTimeSlots(
      this.selectedDateIso(),
      duration,
    );

    this.isLoadingSlots.set(true);
    this.slotsError.set('');

    this.reservaCalendarioService
      .getAvailableTimeSlotsFromApi(this.selectedDateIso(), duration)
      .subscribe({
        next: (availableSlots) => {
          const selectedIso = this.selectedDateIso();
          const hasAvailability = availableSlots.length > 0;

          if (selectedIso) {
            this.dayAvailability.update((current) => ({
              ...current,
              [selectedIso]: hasAvailability,
            }));
          }

          const availableSet = new Set(availableSlots);
          const mappedSlots = allSlots.map((time) => {
            const isPast = this.isSlotInPast(time, selectedIso);
            const isClosed = this.reservaCalendarioService.isRecurringClosedSlot(
              selectedIso,
              time,
              duration,
            );

            let reason: TimeSlotItem['reason'] = 'available';

            if (isClosed) {
              reason = 'closed';
            } else if (isPast) {
              reason = 'past';
            } else if (!availableSet.has(time)) {
              reason = 'occupied';
            }

            return {
              time,
              disabled: reason !== 'available',
              past: isPast,
              reason,
              statusLabel:
                reason === 'closed'
                  ? 'Cerrado'
                  : reason === 'past'
                    ? 'No disponible'
                    : reason === 'occupied'
                      ? 'Ocupada'
                      : '',
            };
          });

          this.timeSlots.set(mappedSlots);
        },
        error: () => {
          this.timeSlots.set([]);
          this.slotsError.set('No se pudo cargar la disponibilidad. Inténtalo de nuevo.');
        },
        complete: () => {
          this.isLoadingSlots.set(false);
        },
      });
  }

  private isSlotInPast(time: string, dateIso: string): boolean {
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    if (dateIso !== todayIso) {
      return false;
    }

    const [slotH, slotM] = time.split(':').map(Number);
    const slotMinutes = slotH * 60 + slotM;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    return slotMinutes <= nowMinutes;
  }

  private isPastDay(dateIso: string): boolean {
    const todayIso = this.toIsoDate(new Date());
    return dateIso < todayIso;
  }

  private getDefaultSelectedTypeDuration(): number {
    const value = this.reservaCalendarioService.getTypeDuration(
      this.appointmentTypes,
      this.selectedTypeId(),
    );

    return this.normalizeCustomDuration(value);
  }

  private normalizeCustomDuration(rawValue: number): number {
    if (!Number.isFinite(rawValue) || rawValue <= 0) {
      return 60;
    }

    return Math.max(15, Math.min(360, Math.round(rawValue)));
  }

  private initializeDurationFromQuery(): void {
    const defaultDuration = this.getDefaultSelectedTypeDuration();
    const fromQuery = Number(this.route.snapshot.queryParamMap.get('durationMinutes') ?? NaN);

    if (!Number.isFinite(fromQuery) || fromQuery <= 0) {
      this.selectedDurationMode.set('default');
      this.selectedDurationMinutes.set(defaultDuration);
      return;
    }

    const normalized = this.normalizeCustomDuration(fromQuery);

    if (normalized === defaultDuration) {
      this.selectedDurationMode.set('default');
      this.selectedDurationMinutes.set(defaultDuration);
      return;
    }

    if (this.durationOptions.includes(normalized)) {
      this.selectedDurationMode.set('preset');
      this.selectedDurationMinutes.set(normalized);
      return;
    }

    this.selectedDurationMode.set('custom');
    this.customDurationInput.set(`${normalized}`);
    this.selectedDurationMinutes.set(normalized);
  }

  private normalizeDuration(rawValue: number, fallback: number): number {
    const fallbackSafe = this.normalizeCustomDuration(fallback);

    if (!Number.isFinite(rawValue) || rawValue <= 0) {
      return fallbackSafe;
    }

    return this.normalizeCustomDuration(rawValue);
  }

  private updateSelectedDuration(nextDuration: number): void {
    const normalizedDuration = this.normalizeDuration(
      nextDuration,
      this.getDefaultSelectedTypeDuration(),
    );

    if (normalizedDuration === this.selectedDurationMinutes()) {
      return;
    }

    this.selectedDurationMinutes.set(normalizedDuration);
    this.selectedTime.set('');

    if (this.selectedDateIso()) {
      this.refreshSlots();
    }

    this.loadDayAvailability();
  }

  private formatDurationLabel(duration: number): string {
    if (duration < 60) {
      return `${duration} min`;
    }

    const hours = Math.floor(duration / 60);
    const remainingMinutes = duration % 60;

    if (remainingMinutes === 0) {
      return hours === 1 ? '1 h' : `${hours} h`;
    }

    return `${hours} h ${remainingMinutes} min`;
  }

  private getMonthStart(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  private getWeekdayColumnIndex(date: Date): number {
    const weekDay = date.getDay();
    return weekDay === 0 ? 6 : weekDay - 1;
  }

  private toIsoDate(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');

    return `${year}-${month}-${day}`;
  }
}
