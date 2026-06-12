import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class DondeEstamosService {
  getTitle(): string {
    return 'Dónde estamos';
  }

  getAddress(): string {
    return 'C. Asturias, 2, 28320 Pinto, Madrid';
  }

  getPhone(): string {
    return '91 952 16 11';
  }

  getWhatsApp(): string {
    return '614 716 238';
  }

  getHours(): string {
    return 'Horario · L-V 10:30-14:00 y 15:00-19:00 · Sáb 09:00-14:00';
  }

  getInstagramUrl(): string {
    return 'https://www.instagram.com/arenahairstudio';
  }

  getInstagramLabel(): string {
    return '@arenahairstudio';
  }

  getMapUrl(): string {
    return 'https://www.openstreetmap.org/export/embed.html?bbox=-3.7139%2C40.2308%2C-3.6810%2C40.2526&layer=mapnik&marker=40.2417%2C-3.6965';
  }
}
