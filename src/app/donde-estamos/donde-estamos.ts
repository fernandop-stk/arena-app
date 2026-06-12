import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { DondeEstamosService } from './donde-estamos.service';

@Component({
  selector: 'app-donde-estamos',
  imports: [RouterLink],
  templateUrl: './donde-estamos.html',
  styleUrl: './donde-estamos.scss',
})
export class DondeEstamosComponent implements AfterViewInit, OnDestroy {
  protected readonly dondeEstamosService = inject(DondeEstamosService);
  private readonly sanitizer = inject(DomSanitizer);
  private observer: IntersectionObserver | null = null;
  private readonly revealElements = viewChildren<ElementRef<HTMLElement>>('revealEl');

  protected readonly title = this.dondeEstamosService.getTitle();
  protected readonly address = this.dondeEstamosService.getAddress();
  protected readonly phone = this.dondeEstamosService.getPhone();
  protected readonly whatsapp = this.dondeEstamosService.getWhatsApp();
  protected readonly hours = this.dondeEstamosService.getHours();
  protected readonly instagramUrl = this.dondeEstamosService.getInstagramUrl();
  protected readonly instagramLabel = this.dondeEstamosService.getInstagramLabel();
  protected readonly visibleKeys = signal<string[]>([]);
  protected readonly mapUrl: SafeResourceUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
    this.dondeEstamosService.getMapUrl(),
  );

  ngAfterViewInit(): void {
    this.initRevealObserver();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  protected isVisible(key: string): boolean {
    return this.visibleKeys().includes(key);
  }

  private initRevealObserver(): void {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      this.visibleKeys.set(['hero', 'map']);
      return;
    }

    const elements = this.revealElements();

    if (!elements.length) {
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }

          const key = (entry.target as HTMLElement).dataset['key'];

          if (key) {
            this.visibleKeys.update((keys) => (keys.includes(key) ? keys : [...keys, key]));
          }

          this.observer?.unobserve(entry.target);
        });
      },
      {
        threshold: 0.2,
        rootMargin: '0px 0px -10% 0px',
      },
    );

    elements.forEach((element) => {
      this.observer?.observe(element.nativeElement);
    });
  }
}
