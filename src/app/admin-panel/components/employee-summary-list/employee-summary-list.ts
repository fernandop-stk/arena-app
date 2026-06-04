import { Component, EventEmitter, Input, Output } from '@angular/core';

interface EmployeeSummaryUser {
  email: string;
  username: string;
  role: string;
}

@Component({
  selector: 'app-employee-summary-list',
  standalone: true,
  templateUrl: './employee-summary-list.html',
  styleUrl: './employee-summary-list.scss',
})
export class EmployeeSummaryListComponent {
  @Input() users: EmployeeSummaryUser[] = [];
  @Input() emptyMessage = 'No hay usuarios registrados.';
  @Input() hideSuperadmin = false;

  @Output() openEmployee = new EventEmitter<string>();

  protected getRoleLabel(role: string): string {
    switch (role) {
      case 'superadmin':
        return 'Super admin';
      case 'admin':
        return 'Admin';
      default:
        return 'Empleado';
    }
  }
}
