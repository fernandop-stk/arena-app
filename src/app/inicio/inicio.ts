import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { InicioService } from './inicio.service';

let introAlreadyShownInRuntime = false;

@Component({
  selector: 'app-inicio',
  imports: [RouterLink],
  templateUrl: './inicio.html',
  styleUrl: './inicio.scss',
})
export class InicioComponent {
  protected readonly inicioService = inject(InicioService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly title = this.inicioService.getTitle();
  protected readonly subtitle = this.inicioService.getSubtitle();
  protected readonly options = this.inicioService.getOptions();
  protected readonly titleChars = Array.from(this.title);
  protected readonly showIntro = signal(false);
  protected readonly showContent = signal(true);

  constructor() {
    if (typeof window === 'undefined') {
      return;
    }

    if (!introAlreadyShownInRuntime) {
      introAlreadyShownInRuntime = true;
      this.showIntro.set(true);
      this.showContent.set(false);

      const introTimer = window.setTimeout(() => {
        this.showIntro.set(false);
        this.showContent.set(true);
      }, 3050);

      this.destroyRef.onDestroy(() => {
        window.clearTimeout(introTimer);
      });
    }
  }
}
