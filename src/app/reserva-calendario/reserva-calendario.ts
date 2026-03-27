import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { CitasService } from '../citas/citas.service';
import { ReservaStateService } from '../reserva-state.service';
import { ReservaCalendarioService } from './reserva-calendario.service';

interface TimeSlotItem {
  time: string;
  disabled: boolean;
  past: boolean;
}

@Component({
  selector: 'app-reserva-calendario',
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
  protected readonly days = this.reservaCalendarioService.getCalendarDays(14);

  protected readonly selectedTypeId = signal(
    this.reservaCalendarioService.getSelectedTypeFromQuery(
      this.route.snapshot.queryParamMap.get('tipo'),
      this.appointmentTypes,
    ),
  );
  protected readonly selectedDateIso = signal(this.route.snapshot.queryParamMap.get('date') ?? '');
  protected readonly selectedTime = signal('');
  protected readonly timeSlots = signal<TimeSlotItem[]>([]);
  protected readonly dayAvailability = signal<Record<string, boolean>>({});
  protected readonly isLoadingDays = signal(false);
  protected readonly isLoadingSlots = signal(false);
  protected readonly slotsError = signal('');
  protected readonly currentStep = signal(this.route.snapshot.queryParamMap.get('tipo') ? 2 : 1);

  constructor() {
    this.loadDayAvailability();
  }

  protected onTypeChange(appointmentTypeId: number): void {
    this.selectedTypeId.set(appointmentTypeId);
    this.selectedDateIso.set('');
    this.selectedTime.set('');
    this.timeSlots.set([]);
    this.loadDayAvailability();
    this.currentStep.set(2);
  }

  protected onSelectDay(dateIso: string): void {
    if (this.isDayUnavailable(dateIso)) {
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
    const day = this.days.find((d) => d.iso === iso);
    if (!day) return iso;
    return `${day.dayName} ${day.dayNumber} ${day.monthName}`;
  }

  protected goToCustomerForm(): Promise<boolean> {
    this.reservaStateService.setSelection({
      appointmentTypeId: this.selectedTypeId(),
      dateIso: this.selectedDateIso(),
      time: this.selectedTime(),
    });

    return this.router.navigate(['/reservas/datos']);
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
    const availability = this.dayAvailability()[dateIso];

    return availability === false;
  }

  private loadDayAvailability(): void {
    const duration = this.reservaCalendarioService.getTypeDuration(
      this.appointmentTypes,
      this.selectedTypeId(),
    );

    this.isLoadingDays.set(true);

    forkJoin(
      this.days.map((day) =>
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

    const duration = this.reservaCalendarioService.getTypeDuration(
      this.appointmentTypes,
      this.selectedTypeId(),
    );
    const allSlots = this.reservaCalendarioService.getAvailableTimeSlots(duration);

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
            return {
              time,
              disabled: !availableSet.has(time) || isPast,
              past: isPast,
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
}
