import { Injectable } from '@angular/core';

interface EmployeeTrackingHistoryItem {
  action: string;
  createdAtIso: string;
  note: string;
}

interface EmployeeUserLike {
  email: string;
  username: string;
  role: string;
  tracking: {
    history: EmployeeTrackingHistoryItem[];
  };
}

@Injectable({
  providedIn: 'root',
})
export class EmployeeAdminService {
  getRoleLabel(role: string): string {
    switch (role) {
      case 'superadmin':
        return 'Superadmin';
      case 'admin':
        return 'Admin';
      default:
        return 'Empleado';
    }
  }

  getWorkStatusLabel(status: string): string {
    switch (status) {
      case 'working':
        return 'Trabajando';
      case 'vacation':
        return 'Vacaciones';
      case 'sick_leave':
        return 'Baja';
      case 'recovering_hours':
        return 'Recuperando horas';
      default:
        return 'Sin estado activo';
    }
  }

  getSummaryUsers<T extends EmployeeUserLike>(users: T[]): T[] {
    return users.filter((user) => user.role !== 'superadmin');
  }

  getFilteredUsers<T extends EmployeeUserLike>(
    users: T[],
    search: string,
    roleFilter: string,
  ): T[] {
    const normalizedSearch = search.trim().toLowerCase();

    if (!normalizedSearch) {
      return [];
    }

    return users.filter((user) => {
      const matchesRole = roleFilter === 'all' || user.role === roleFilter;
      const matchesSearch =
        user.username.toLowerCase().includes(normalizedSearch) ||
        user.email.toLowerCase().includes(normalizedSearch);

      return matchesRole && matchesSearch;
    });
  }

  getFilteredHistory<T extends EmployeeTrackingHistoryItem>(
    history: T[],
    startDateIso: string,
    endDateIso: string,
  ): T[] {
    return history.filter((item) => {
      const itemDateIso = item.createdAtIso.slice(0, 10);

      if (startDateIso && itemDateIso < startDateIso) {
        return false;
      }

      if (endDateIso && itemDateIso > endDateIso) {
        return false;
      }

      return true;
    });
  }
}
