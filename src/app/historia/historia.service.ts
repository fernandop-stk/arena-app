import { Injectable } from '@angular/core';

export type HistoriaStory = {
  title: string;
  text: string;
  imageSrc: string;
  imageAlt: string;
  badge: string;
  caption: string;
};

@Injectable({
  providedIn: 'root',
})
export class HistoriaService {
  private readonly stories: HistoriaStory[] = [
    {
      title: 'Una experiencia creada para ti',
      text: 'En Arena Hair Studio entendemos la peluquería como una experiencia de bienestar personalizada, pensada para realzar tu esencia.',
      imageSrc: '/assets/conocenos/espejos3.jpeg',
      imageAlt: 'Interior del salón con espejos y acabado luminoso.',
      badge: 'Signature',
      caption:
        'Un entorno luminoso, elegante y cuidado al detalle para que cada visita se sienta especial desde el primer instante.',
    },
    {
      title: 'Un recibimiento sereno y sofisticado',
      text: 'Cada cita comienza en un ambiente acogedor que invita a desconectar, relajarte y disfrutar del tiempo para ti.',
      imageSrc: '/assets/conocenos/recepcion.jpeg',
      imageAlt: 'Recepción del salón Arena Hair Studio.',
      badge: 'Bienvenida',
      caption:
        'La bienvenida al salón transmite la misma intención que define cada servicio: cercanía, estilo y mimo.',
    },
    {
      title: 'Belleza que también se siente',
      text: 'La experiencia está diseñada para que te sientas cómoda, cuidada y acompañada en cada momento del proceso.',
      imageSrc: '/assets/conocenos/espera.jpeg',
      imageAlt: 'Zona de espera acogedora del salón.',
      badge: 'Calma',
      caption:
        'Queremos que el salón sea ese lugar donde haces una pausa, te reconectas contigo y sales renovada.',
    },
    {
      title: 'Especialistas en color y transformación',
      text: 'Nos especializamos en coloración, tratamientos capilares y extensiones, trabajando con precisión, delicadeza y sentido estético.',
      imageSrc: '/assets/conocenos/especialistas-en-color.jpeg',
      imageAlt: 'Zona de trabajo con espejos en Arena Hair Studio.',
      badge: 'Técnica',
      caption:
        'La técnica se pone al servicio de un resultado natural, favorecedor y alineado con tu estilo.',
    },
    {
      title: 'Cuidar la belleza y la salud del cabello',
      text: 'Cada detalle se trabaja con atención para potenciar la belleza de tu melena sin perder de vista su salud y su equilibrio.',
      imageSrc: '/assets/conocenos/posicion-5.png',
      imageAlt: 'Detalle del interior del salón con zona de productos.',
      badge: 'Cuidado',
      caption:
        'Buscamos resultados que no solo se vean bonitos, sino que también se mantengan sanos y coherentes contigo.',
    },
    {
      title: 'Experiencia, formación y sensibilidad',
      text: 'Detrás de Arena Hair Studio hay experiencia, formación continua y una auténtica pasión por acompañarte en cada cambio.',
      imageSrc: '/assets/conocenos/lava-cabezas.jpeg',
      imageAlt: 'Zona de lavado de cabello en Arena Hair Studio.',
      badge: 'Trayectoria',
      caption:
        'La evolución constante permite ofrecer una mirada actual, técnica y profundamente personalizada.',
    },
    {
      title: 'Un espacio con identidad propia',
      text: 'Arena Hair Studio es un espacio sofisticado y acogedor, pensado para envolverte en una experiencia estética completa.',
      imageSrc: '/assets/conocenos/identidad-propia.jpeg',
      imageAlt: 'Vista exterior del local Arena Hair Studio.',
      badge: 'Espacio',
      caption:
        'Desde la fachada hasta el interior, todo refleja una estética cálida, cuidada y coherente con la marca.',
    },
  ];

  getTitle(): string {
    return 'Conócenos';
  }

  getIntro(): string {
    return 'Un recorrido visual por el universo Arena Hair Studio: técnica, sensibilidad y una forma de cuidar tu cabello que convierte cada cita en una experiencia.';
  }

  getStories(): HistoriaStory[] {
    return this.stories;
  }
}
