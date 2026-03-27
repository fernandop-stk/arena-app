import { Injectable } from '@angular/core';
import { Router } from '@angular/router';

export interface AppointmentType {
  id: number;
  nombre: string;
  duracionMinutos: number;
  descripcion: string;
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
    return 'Elige el servicio, revisa la duración y reserva cuando quieras.';
  }

  getPrimaryButtonLabel(): string {
    return 'Reservar';
  }

  getAppointmentTypes(): AppointmentType[] {
    return [
      {
        id: 1,
        nombre: 'Corte',
        duracionMinutos: 30,
        descripcion: 'Corte personalizado adaptado a tu estilo.',
      },
      {
        id: 2,
        nombre: 'Corte y peinado',
        duracionMinutos: 45,
        descripcion: 'Corte profesional con peinado y acabado final.',
      },
      {
        id: 3,
        nombre: 'Tinte',
        duracionMinutos: 60,
        descripcion: 'Aplicación de color completo con secado incluido.',
      },
      {
        id: 4,
        nombre: 'Mechas',
        duracionMinutos: 120,
        descripcion: 'Técnica de iluminación parcial con matiz final.',
      },
      {
        id: 5,
        nombre: 'Extensiones',
        duracionMinutos: 240,
        descripcion: 'Colocación de extensiones naturales o sintéticas.',
      },
      {
        id: 6,
        nombre: 'Balayage',
        duracionMinutos: 300,
        descripcion: 'Técnica de iluminación manual degradada y personalizada.',
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
}
