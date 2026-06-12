import { Component, EventEmitter, Input, Output } from '@angular/core';

type EmployeeCreateRole = 'admin' | 'client';

export type EmployeePermission =
  | 'agenda_ver'
  | 'agenda_gestionar'
  | 'bloqueos_gestionar'
  | 'reservas_ver'
  | 'reservas_gestionar'
  | 'cierre_registrar'
  | 'estadisticas_ver'
  | 'clientes_gestionar'
  | 'almacen_gestionar'
  | 'cobros_gestionar';

export const PERMISSION_LABELS: Record<EmployeePermission, string> = {
  agenda_ver: 'Ver agenda',
  agenda_gestionar: 'Gestionar agenda (mover/editar citas)',
  bloqueos_gestionar: 'Bloquear horas y días',
  reservas_ver: 'Ver listado de reservas',
  reservas_gestionar: 'Aceptar / rechazar reservas',
  cierre_registrar: 'Registrar cierre de caja',
  estadisticas_ver: 'Ver estadísticas',
  clientes_gestionar: 'Gestionar fichas de clientes',
  almacen_gestionar: 'Gestionar almacén',
  cobros_gestionar: 'Cobrar pagos',
};

export const ALL_PERMISSIONS = Object.keys(PERMISSION_LABELS) as EmployeePermission[];

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
  @Input() permissions: EmployeePermission[] = [];
  @Input() usernameError = '';
  @Input() emailError = '';
  @Input() passwordError = '';

  @Output() usernameInput = new EventEmitter<Event>();
  @Output() emailInput = new EventEmitter<Event>();
  @Output() passwordInput = new EventEmitter<Event>();
  @Output() roleChange = new EventEmitter<Event>();
  @Output() permissionsChange = new EventEmitter<EmployeePermission[]>();
  @Output() submitCreate = new EventEmitter<void>();

  protected readonly allPermissions = ALL_PERMISSIONS;
  protected readonly permissionLabels = PERMISSION_LABELS;

  protected isChecked(perm: EmployeePermission): boolean {
    return this.permissions.includes(perm);
  }

  protected togglePermission(perm: EmployeePermission): void {
    const next = this.isChecked(perm)
      ? this.permissions.filter((p) => p !== perm)
      : [...this.permissions, perm];
    this.permissionsChange.emit(next);
  }

  protected selectAll(): void {
    this.permissionsChange.emit([...ALL_PERMISSIONS]);
  }

  protected clearAll(): void {
    this.permissionsChange.emit([]);
  }

  protected hasError(message: string): boolean {
    return message.trim().length > 0;
  }
}
