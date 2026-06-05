import { Injectable } from '@angular/core';

export interface TratamientoItem {
  id: number;
  nombre: string;
  categoria?: string;
  descripcion: string;
  imagen: string;
  precio: string;
  duracionMinutos: number;
  appointmentTypeId?: number;
  invitadaOptions?: TratamientoInvitadaOption[];
}

export interface TratamientoInvitadaOption {
  nombre: string;
  descripcion: string;
  precio: string;
  duracionMinutos: number;
  appointmentTypeId: number;
}

@Injectable({
  providedIn: 'root',
})
export class TratamientosService {
  getTitle(): string {
    return 'Packs y tratamientos';
  }

  getDescription(): string {
    return 'Todos los packs incluyen asesoría y terapia capilar (lavado + hidratación) como base de cuidado.';
  }

  getPacks(): TratamientoItem[] {
    return [
      {
        id: 1,
        nombre: 'Pack Corte',
        descripcion: '• Asesoría • Terapia capilar (lavado + hidratación) • Corte',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Desde 40€',
        duracionMinutos: 60,
        appointmentTypeId: 1,
      },
      {
        id: 2,
        nombre: 'Pack Peinado',
        descripcion: '• Asesoría • Terapia capilar (lavado + hidratación) • Peinado',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Desde 40€',
        duracionMinutos: 60,
        appointmentTypeId: 2,
      },
      {
        id: 3,
        nombre: 'Pack Corte y Peinado',
        descripcion: '• Asesoría • Terapia capilar (lavado + hidratación) • Corte + peinado',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Desde 60€',
        duracionMinutos: 90,
        appointmentTypeId: 3,
      },
      {
        id: 4,
        nombre: 'Pack Color',
        descripcion:
          '• Asesoría • Técnica de color (raíz) • Terapia capilar (lavado + hidratación) • Corte + peinado',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Desde 70€',
        duracionMinutos: 120,
        appointmentTypeId: 4,
      },
      {
        id: 5,
        nombre: 'Pack Color Plus',
        descripcion:
          '• Asesoría • Color (matiz o completo) • Terapia capilar (lavado + hidratación) • Corte + peinado',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Desde 90€',
        duracionMinutos: 150,
        appointmentTypeId: 5,
      },
      {
        id: 6,
        nombre: 'Pack Ilumina',
        descripcion:
          '• Asesoría • Puntos de luz + matiz • Terapia capilar (lavado + hidratación) • Tratamiento personalizado • Corte + peinado',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Desde 140€',
        duracionMinutos: 210,
        appointmentTypeId: 6,
      },
      {
        id: 7,
        nombre: 'Pack Full Color',
        descripcion:
          '• Asesoría • Iluminación a medida • Terapia capilar (lavado + hidratación) • Tratamiento personalizado • Corte + peinado',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Desde 180€',
        duracionMinutos: 360,
        appointmentTypeId: 7,
      },
      {
        id: 8,
        nombre: 'Pack Invitada',
        descripcion:
          '• Incluye asesoría + terapia capilar (lavado + hidratación) • Elige una opción según el peinado que quieras',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Desde 40€',
        duracionMinutos: 60,
        appointmentTypeId: 8,
        invitadaOptions: [
          {
            nombre: '1️⃣ Suelto',
            descripcion: 'Asesoría + terapia capilar + peinado suelto',
            precio: '40€',
            duracionMinutos: 60,
            appointmentTypeId: 8,
          },
          {
            nombre: '2️⃣ Semirecogido / coleta / trenza',
            descripcion: 'Asesoría + terapia capilar + semirecogido / coleta / trenza',
            precio: '60€',
            duracionMinutos: 90,
            appointmentTypeId: 9,
          },
          {
            nombre: '3️⃣ Recogido',
            descripcion: 'Asesoría + terapia capilar + recogido',
            precio: '80€',
            duracionMinutos: 120,
            appointmentTypeId: 10,
          },
        ],
      },
      {
        id: 11,
        nombre: 'Pack Novia',
        descripcion: '• Asesoría • Prueba • Día de la boda',
        imagen: '/assets/branding/fondo.jpeg',
        precio: '300€',
        duracionMinutos: 180,
        appointmentTypeId: 11,
      },
    ];
  }

  getTratamientos(): TratamientoItem[] {
    return [
      {
        id: 101,
        nombre: 'Brushing Plus',
        categoria: 'Tratamientos Arena',
        descripcion:
          '• Embellece el cabello aportando salud y brillo • Prolonga la duración del peinado',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Suplemento: +10€',
        duracionMinutos: 20,
      },
      {
        id: 102,
        nombre: 'Blindaje de Color',
        categoria: 'Tratamientos Arena',
        descripcion:
          '• Mantiene tu color perfecto durante más tiempo • Aporta un brillo extra espectacular',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Suplemento: +10€',
        duracionMinutos: 20,
      },
      {
        id: 103,
        nombre: 'Tratamiento Exprés',
        categoria: 'Tratamientos exprés y personalizados',
        descripcion:
          '• Brillo inmediato • Hidratación rápida • Elasticidad visible en tiempo récord',
        imagen: '/assets/branding/fondo.jpeg',
        precio: '15€',
        duracionMinutos: 30,
      },
      {
        id: 104,
        nombre: 'Tratamiento Personalizado',
        categoria: 'Tratamientos exprés y personalizados',
        descripcion:
          '• Servicio 100% adaptado a tu cabello • Potenciadores de reparación, nutrición o blindaje de color • Diseñado según tus necesidades',
        imagen: '/assets/branding/fondo.jpeg',
        precio: '25€ + pack de color / 60€ con peinado',
        duracionMinutos: 60,
      },
      {
        id: 105,
        nombre: 'Nutrición Extrema',
        categoria: 'Tratamientos intensivos',
        descripcion:
          '• Tratamiento inteligente según necesidad del cabello • Rellena la fibra capilar • Devuelve fuerza, nutrición y densidad • Resultado: cabello más sano, fuerte y duradero',
        imagen: '/assets/branding/fondo.jpeg',
        precio: '40€ + pack de color / 80€ con peinado',
        duracionMinutos: 75,
      },
      {
        id: 106,
        nombre: 'Tratamiento Reconstructor',
        categoria: 'Tratamientos intensivos',
        descripcion:
          '• Reconstrucción profunda y cauterización • Ideal para cabello dañado por procesos químicos • Repara desde el interior • Protege la fibra antes, durante y después de trabajos técnicos',
        imagen: '/assets/branding/fondo.jpeg',
        precio: '40€ + pack de color / 80€ con peinado',
        duracionMinutos: 75,
      },
      {
        id: 107,
        nombre: 'Bono “Recupera tu Melena”',
        categoria: 'Tratamientos intensivos',
        descripcion:
          '• Bono de 3 sesiones personalizadas • Combinación de reconstrucción y nutrición • Adaptado a las necesidades de tu cabello',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Antes: 240€ · Precio especial: 180€',
        duracionMinutos: 180,
      },
      {
        id: 108,
        nombre: 'Liso Perfecto',
        categoria: 'Tratamientos con asesoría previa',
        descripcion:
          '• Requiere asesoría previa • Alisado orgánico para cabello liso, pulido y manejable • Ideal para amantes del liso impecable',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Con asesoría previa · consultar',
        duracionMinutos: 180,
      },
      {
        id: 109,
        nombre: 'Semi-Definitiva',
        categoria: 'Tratamientos con asesoría previa',
        descripcion:
          '• Requiere asesoría previa • Control total incluso en cabellos rebeldes • Melena lisa, suave y duradera',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Con asesoría previa · consultar',
        duracionMinutos: 180,
      },
      {
        id: 110,
        nombre: 'Anti-Frizz',
        categoria: 'Tratamientos con asesoría previa',
        descripcion:
          '• Requiere asesoría previa • Elimina el encrespamiento • Mantiene tu textura natural con control, suavidad y brillo',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Con asesoría previa · consultar',
        duracionMinutos: 120,
      },
      {
        id: 111,
        nombre: 'Bioplastia',
        categoria: 'Tratamientos con asesoría previa',
        descripcion:
          '• Requiere asesoría previa • Tecnología que alisa, repara y nutre en un solo paso • Resultado: cabello transformado, sano y brillante',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Con asesoría previa · consultar',
        duracionMinutos: 180,
      },
      {
        id: 112,
        nombre: 'Definición de Rizos',
        categoria: 'Cuidados y prevención',
        descripcion:
          '• Hidratación específica para cabello rizado • Definición y volumen controlado • Rizos elásticos, sueltos y llenos de vida',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Consultar según diagnóstico',
        duracionMinutos: 90,
      },
      {
        id: 113,
        nombre: 'Botox Capilar',
        categoria: 'Cuidados y prevención',
        descripcion:
          '• Tratamiento intensivo de relleno de fibra capilar • Rejuvenece el cabello • Aporta suavidad profunda y acabado sedoso',
        imagen: '/assets/branding/fondo.jpeg',
        precio: 'Consultar según diagnóstico',
        duracionMinutos: 90,
      },
    ];
  }
}
