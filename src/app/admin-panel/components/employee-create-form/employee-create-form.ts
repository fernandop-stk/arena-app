import { Component, EventEmitter, Input, Output } from '@angular/core';

type EmployeeCreateRole = 'admin' | 'client';

@Component({
  selector: 'app-employee-create-form',
  standalone: true,
  templateUrl: './employee-create-form.html',
  styleUrl: './employee-create-form.scss',
})
export class EmployeeCreateFormComponent {
  @Input() username = '';
  @Input() email = '';
  @Input() password = '';
  @Input() role: EmployeeCreateRole = 'client';
  @Input() loading = false;

  @Output() usernameInput = new EventEmitter<Event>();
  @Output() emailInput = new EventEmitter<Event>();
  @Output() passwordInput = new EventEmitter<Event>();
  @Output() roleChange = new EventEmitter<Event>();
  @Output() submitCreate = new EventEmitter<void>();
}
