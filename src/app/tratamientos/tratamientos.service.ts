import { Injectable } from '@angular/core';

export interface TratamientoItem {
  id: number;
  nombre: string;
  descripcion: string;
  imagen: string;
  precio: string;
  duracionMinutos: number;
  appointmentTypeId: number;
}

@Injectable({
  providedIn: 'root',
})
export class TratamientosService {
  getTitle(): string {
    return 'Tratamientos';
  }

  getDescription(): string {
    return 'Listado inicial de tratamientos que iremos completando contigo.';
  }

  getLoremIpsum(): string {
    return 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.';
  }

  getTratamientos(): TratamientoItem[] {
    const texto = this.getLoremIpsum();

    return [
      {
        id: 1,
        nombre: 'Corte',
        descripcion: texto,
        imagen: '/assets/branding/fondo.png',
        precio: 'Desde 15,00 €',
        duracionMinutos: 30,
        appointmentTypeId: 1,
      },
      {
        id: 2,
        nombre: 'Corte y peinado',
        descripcion: texto,
        imagen: '/assets/branding/fondo.png',
        precio: 'Desde 25,00 €',
        duracionMinutos: 45,
        appointmentTypeId: 2,
      },
      {
        id: 3,
        nombre: 'Tinte',
        descripcion: texto,
        imagen: '/assets/branding/fondo.png',
        precio: 'Desde 40,00 €',
        duracionMinutos: 60,
        appointmentTypeId: 3,
      },
      {
        id: 4,
        nombre: 'Mechas',
        descripcion: texto,
        imagen: '/assets/branding/fondo.png',
        precio: 'Desde 65,00 €',
        duracionMinutos: 120,
        appointmentTypeId: 4,
      },
      {
        id: 5,
        nombre: 'Extensiones',
        descripcion: texto,
        imagen: '/assets/branding/fondo.png',
        precio: 'Desde 120,00 €',
        duracionMinutos: 240,
        appointmentTypeId: 5,
      },
      {
        id: 6,
        nombre: 'Balayage',
        descripcion: texto,
        imagen: '/assets/branding/fondo.png',
        precio: 'Desde 90,00 €',
        duracionMinutos: 300,
        appointmentTypeId: 6,
      },
    ];
  }
}
