import { Injectable } from '@angular/core';
import { Router } from '@angular/router';

export interface AppointmentType {
  id: number;
  nombre: string;
  duracionMinutos: number;
  descripcion: string;
  requiresReservationSignal?: boolean;
  provisionalHoldHours?: number;
}

@Injectable({
  providedIn: 'root',
})
export class CitasService {
  constructor(private readonly router: Router) {}

  getSalonName(): string {
    return 'Arena Studio';
  }

  getHeadline(): string {
    return 'Tu cita de peluquería, en 3 pasos';
  }

  getDescription(): string {
    return 'Elige tu pack y reserva cuando quieras.';
  }

  getPrimaryButtonLabel(): string {
    return 'Reservar';
  }

  getAppointmentTypes(): AppointmentType[] {
    return [
      {
        id: 1,
        nombre: 'Pack Corte',
        duracionMinutos: 60,
        descripcion: 'Asesoría personalizada + spa capilar + corte.',
      },
      {
        id: 2,
        nombre: 'Pack Peinado',
        duracionMinutos: 60,
        descripcion: 'Asesoría personalizada + spa capilar + peinado.',
      },
      {
        id: 3,
        nombre: 'Pack Corte y Peinado',
        duracionMinutos: 90,
        descripcion: 'Asesoría + spa capilar + corte + peinado.',
      },
      {
        id: 4,
        nombre: 'Pack Color',
        duracionMinutos: 120,
        descripcion: 'Asesoría + técnica de color raíz + spa capilar + corte + peinado.',
      },
      {
        id: 5,
        nombre: 'Pack Color Plus',
        duracionMinutos: 150,
        descripcion: 'Asesoría + color con matiz o global + spa capilar + corte + peinado.',
      },
      {
        id: 6,
        nombre: 'Pack Ilumina',
        duracionMinutos: 210,
        descripcion: 'Asesoría + puntos de luz con matiz + spa capilar + corte + peinado.',
        requiresReservationSignal: true,
        provisionalHoldHours: 48,
      },
      {
        id: 7,
        nombre: 'Pack Full Color',
        duracionMinutos: 330,
        descripcion:
          'Asesoría + iluminación a medida + spa capilar + tratamiento reparador + corte + peinado.',
        requiresReservationSignal: true,
        provisionalHoldHours: 48,
      },
      {
        id: 8,
        nombre: 'Pack Invitada · Opción 1',
        duracionMinutos: 60,
        descripcion: 'Asesoría + spa capilar + peinado suelto.',
      },
      {
        id: 9,
        nombre: 'Pack Invitada · Opción 2',
        duracionMinutos: 90,
        descripcion: 'Asesoría + spa capilar + semirecogido, coleta o trenza.',
      },
      {
        id: 10,
        nombre: 'Pack Invitada · Opción 3',
        duracionMinutos: 120,
        descripcion: 'Asesoría + spa capilar + recogido.',
      },
      {
        id: 11,
        nombre: 'Pack Novia',
        duracionMinutos: 180,
        descripcion: 'Asesoría + prueba + día de la boda.',
      },
    ];
  }

  formatDuration(minutes: number): string {
    if (minutes < 60) {
      return `${minutes} min`;
    }

    const hours = minutes / 60;

    if (Number.isInteger(hours)) {
      return hours === 1 ? '1 hora' : `${hours} horas`;
    }

    const h = Math.floor(minutes / 60);
    const m = minutes % 60;

    return `${h} h ${m} min`;
  }

  buildReservationMessage(): string {
    return 'Perfecto. En el siguiente paso podrás elegir día y hora.';
  }

  getDefaultAppointmentTypeId(appointmentTypes: AppointmentType[]): number {
    return appointmentTypes[0]?.id ?? 0;
  }

  getSelectedTypeFromQuery(queryType: string | null, appointmentTypes: AppointmentType[]): number {
    const parsedType = Number(queryType);
    const exists = appointmentTypes.some((type) => type.id === parsedType);

    if (exists) {
      return parsedType;
    }

    return this.getDefaultAppointmentTypeId(appointmentTypes);
  }

  goToReservationCalendar(appointmentTypeId: number): Promise<boolean> {
    return this.router.navigate(['/reservas/calendario'], {
      queryParams: {
        tipo: appointmentTypeId,
      },
    });
  }

  requiresReservationSignal(appointmentTypeId: number): boolean {
    return this.getAppointmentTypes().some(
      (appointmentType) =>
        appointmentType.id === appointmentTypeId && appointmentType.requiresReservationSignal,
    );
  }

  getProvisionalHoldHours(appointmentTypeId: number): number {
    return (
      this.getAppointmentTypes().find((appointmentType) => appointmentType.id === appointmentTypeId)
        ?.provisionalHoldHours ?? 0
    );
  }
}
