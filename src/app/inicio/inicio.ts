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
  protected readonly titleWords = this.title.split(' ');
  private readonly titleWordStartIndexes = this.titleWords.reduce<number[]>((acc, word, index) => {
    if (index === 0) {
      acc.push(0);
      return acc;
    }

    const previousWord = this.titleWords[index - 1] ?? '';
    const previousStart = acc[index - 1] ?? 0;
    acc.push(previousStart + previousWord.length + 1);
    return acc;
  }, []);
  protected readonly showIntro = signal(false);
  protected readonly showContent = signal(true);

  protected getIntroCharIndex(wordIndex: number, charIndex: number): number {
    return (this.titleWordStartIndexes[wordIndex] ?? 0) + charIndex;
  }

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
