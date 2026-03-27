import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class DondeEstamosService {
  getTitle(): string {
    return 'Dónde estamos';
  }

  getAddress(): string {
    return 'C. de Castilla, 4, 28320 Pinto, Madrid';
  }

  getPhone(): string {
    return '618 787 878';
  }

  getMapUrl(): string {
    return 'https://www.openstreetmap.org/export/embed.html?bbox=-3.7139%2C40.2308%2C-3.6810%2C40.2526&layer=mapnik&marker=40.2417%2C-3.6965';
  }
}
