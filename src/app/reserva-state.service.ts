import { Injectable, signal } from '@angular/core';

export interface ReservationSelection {
  appointmentTypeId: number;
  dateIso: string;
  time: string;
  durationMinutes: number;
  isWaitlist?: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class ReservaStateService {
  private readonly selectionSignal = signal<ReservationSelection | null>(null);

  setSelection(selection: ReservationSelection): void {
    this.selectionSignal.set(selection);
  }

  getSelection(): ReservationSelection | null {
    return this.selectionSignal();
  }

  hasSelection(): boolean {
    return this.selectionSignal() !== null;
  }

  clearSelection(): void {
    this.selectionSignal.set(null);
  }
}
