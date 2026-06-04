import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-employee-tracking-calendar-modal',
  standalone: true,
  templateUrl: './employee-tracking-calendar-modal.html',
  styleUrl: './employee-tracking-calendar-modal.scss',
})
export class EmployeeTrackingCalendarModalComponent {
  @Input() open = false;
  @Input() title = '';
  @Input() startDateIso = '';
  @Input() endDateIso = '';
  @Input() endLabel = 'Hasta';

  @Output() close = new EventEmitter<void>();
  @Output() startDateInput = new EventEmitter<Event>();
  @Output() endDateInput = new EventEmitter<Event>();
  @Output() confirm = new EventEmitter<void>();
}
