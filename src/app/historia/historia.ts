import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { HistoriaService } from './historia.service';

@Component({
  selector: 'app-historia',
  imports: [RouterLink],
  templateUrl: './historia.html',
  styleUrl: './historia.scss',
})
export class HistoriaComponent implements AfterViewInit, OnDestroy {
  protected readonly historiaService = inject(HistoriaService);
  private observer: IntersectionObserver | null = null;
  private readonly revealEl = viewChild<ElementRef<HTMLElement>>('revealEl');

  protected readonly title = this.historiaService.getTitle();
  protected readonly text = this.historiaService.getText();
  protected readonly isVisible = signal(false);

  ngAfterViewInit(): void {
    this.initRevealObserver();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private initRevealObserver(): void {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      this.isVisible.set(true);
      return;
    }

    const element = this.revealEl()?.nativeElement;

    if (!element) {
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;

        if (!entry?.isIntersecting) {
          return;
        }

        this.isVisible.set(true);
        this.observer?.unobserve(entry.target);
      },
      {
        threshold: 0.25,
        rootMargin: '0px 0px -10% 0px',
      },
    );

    this.observer.observe(element);
  }
}
