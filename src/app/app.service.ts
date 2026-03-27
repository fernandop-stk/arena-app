import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class AppService {
  getAppName(): string {
    return 'arena-app';
  }
}
