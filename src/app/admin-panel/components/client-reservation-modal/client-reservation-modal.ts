import { Component, EventEmitter, Input, Output } from '@angular/core';

type SelectionType = 'pack' | 'treatment';

interface ReservationServiceOption {
  id: number;
  nombre: string;
}

@Component({
  selector: 'app-client-reservation-modal',
  standalone: true,
  templateUrl: './client-reservation-modal.html',
  styleUrl: './client-reservation-modal.scss',
})
export class ClientReservationModalComponent {
  @Input() visible = false;
  @Input() clientName = '';
  @Input() clientEmail = '';
  @Input() clientPhone = '';
  @Input() packOptions: ReservationServiceOption[] = [];
  @Input() treatmentOptions: ReservationServiceOption[] = [];
  @Input() timeOptions: string[] = [];
  @Input() selectedType: SelectionType = 'pack';
  @Input() selectedTypeId = 0;
  @Input() reservationDateIso = '';
  @Input() reservationTime = '';
  @Input() availabilityLoading = false;
  @Input() loading = false;
  @Input() error = '';

  @Output() close = new EventEmitter<void>();
  @Output() confirm = new EventEmitter<void>();
  @Output() typeChange = new EventEmitter<SelectionType>();
  @Output() selectionChange = new EventEmitter<{ id: number; type: SelectionType }>();
  @Output() dateChange = new EventEmitter<string>();
  @Output() timeChange = new EventEmitter<string>();

  protected get currentOptions(): ReservationServiceOption[] {
    return this.selectedType === 'pack' ? this.packOptions : this.treatmentOptions;
  }

  protected get currentSelectionLabel(): string {
    return this.currentOptions.find((option) => option.id === this.selectedTypeId)?.nombre ?? '';
  }

  protected setSelectedType(type: SelectionType): void {
    this.typeChange.emit(type);
  }

  protected onSelectionChange(event: Event, type: SelectionType): void {
    const target = event.target as HTMLSelectElement;
    const nextId = Number(target.value);

    if (Number.isFinite(nextId) && nextId > 0) {
      this.selectionChange.emit({ id: nextId, type });
    }
  }

  protected onDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.dateChange.emit(target.value);
  }

  protected onTimeInput(value: string): void {
    this.timeChange.emit(value);
  }
}
