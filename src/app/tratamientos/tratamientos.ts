import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TratamientoItem, TratamientosService } from './tratamientos.service';

@Component({
  selector: 'app-tratamientos',
  imports: [RouterLink],
  templateUrl: './tratamientos.html',
  styleUrl: './tratamientos.scss',
})
export class TratamientosComponent implements AfterViewInit, OnDestroy {
  protected readonly tratamientosService = inject(TratamientosService);
  private readonly router = inject(Router);
  private observer: IntersectionObserver | null = null;
  private readonly cards = viewChildren<ElementRef<HTMLElement>>('cardEl');

  protected readonly title = this.tratamientosService.getTitle();
  protected readonly description = this.tratamientosService.getDescription();
  protected readonly tratamientos = this.tratamientosService.getTratamientos();
  protected readonly visibleCardIds = signal<number[]>([]);
  protected readonly selectedTratamiento = signal<TratamientoItem | null>(null);

  ngAfterViewInit(): void {
    this.initCardObserver();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  protected isCardVisible(id: number): boolean {
    return this.visibleCardIds().includes(id);
  }

  protected openTreatment(item: TratamientoItem): void {
    this.selectedTratamiento.set(item);
  }

  protected closeTreatment(): void {
    this.selectedTratamiento.set(null);
  }

  protected reserveTreatment(item: TratamientoItem): Promise<boolean> {
    return this.router.navigate(['/reservas/calendario'], {
      queryParams: {
        tipo: item.appointmentTypeId,
      },
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscapeKey(): void {
    this.closeTreatment();
  }

  private initCardObserver(): void {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      this.visibleCardIds.set(this.tratamientos.map((item) => item.id));
      return;
    }

    const cardElements = this.cards();

    if (!cardElements.length) {
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }

          const id = Number((entry.target as HTMLElement).dataset['id']);

          if (!Number.isNaN(id)) {
            this.visibleCardIds.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
          }

          this.observer?.unobserve(entry.target);
        });
      },
      {
        threshold: 0.2,
        rootMargin: '0px 0px -8% 0px',
      },
    );

    cardElements.forEach((card) => {
      this.observer?.observe(card.nativeElement);
    });
  }
}
