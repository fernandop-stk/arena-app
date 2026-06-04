import { Injectable } from '@angular/core';

export interface HomeOption {
  id: number;
  titulo: string;
  descripcion: string;
  ruta: string;
  icono: string;
  etiqueta: string;
}

@Injectable({
  providedIn: 'root',
})
export class InicioService {
  getTitle(): string {
    return 'Arena Hair Studio';
  }

  getSubtitle(): string {
    return 'Tu espacio de belleza y cuidado personal';
  }

  getOptions(): HomeOption[] {
    return [
      {
        id: 1,
        titulo: 'Packs',
        descripcion: 'Descubre todos los packs disponibles en el salón.',
        ruta: '/packs',
        icono: '✂️',
        etiqueta: 'Servicios',
      },
      {
        id: 2,
        titulo: 'Reservas',
        descripcion: 'Reserva tu cita en pocos pasos desde tu móvil.',
        ruta: '/reservas',
        icono: '📅',
        etiqueta: 'Cita online',
      },
      {
        id: 3,
        titulo: 'Conócenos',
        descripcion: 'Conoce la esencia y trayectoria de Arena Studio.',
        ruta: '/conocenos',
        icono: '✨',
        etiqueta: 'Nuestra esencia',
      },
      {
        id: 4,
        titulo: 'Dónde estamos',
        descripcion: 'Encuentra nuestra ubicación y ven a visitarnos.',
        ruta: '/donde-estamos',
        icono: '📍',
        etiqueta: 'Ubicación',
      },
    ];
  }
}
