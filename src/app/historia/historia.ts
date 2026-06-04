import {
  AfterViewInit,
  Component,
  computed,
  ElementRef,
  HostListener,
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
  private autoRotateId: number | null = null;
  private readonly revealEl = viewChild<ElementRef<HTMLElement>>('revealEl');

  protected readonly title = this.historiaService.getTitle();
  protected readonly intro = this.historiaService.getIntro();
  protected readonly stories = this.historiaService.getStories();
  protected readonly isVisible = signal(false);
  protected readonly activeIndex = signal(0);
  protected readonly activeStory = computed(
    () => this.stories[this.activeIndex()] ?? this.stories[0],
  );
  protected readonly isCarouselOpen = signal(false);
  protected readonly carouselIndex = signal(0);
  protected readonly carouselStory = computed(
    () => this.stories[this.carouselIndex()] ?? this.stories[0],
  );

  ngAfterViewInit(): void {
    this.initRevealObserver();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.stopAutoRotate();
  }

  protected selectStory(index: number): void {
    if (index < 0 || index >= this.stories.length) {
      return;
    }

    this.activeIndex.set(index);
    this.restartAutoRotate();
  }

  protected showPreviousStory(): void {
    const nextIndex = this.activeIndex() === 0 ? this.stories.length - 1 : this.activeIndex() - 1;

    this.selectStory(nextIndex);
  }

  protected showNextStory(): void {
    this.selectStory((this.activeIndex() + 1) % this.stories.length);
  }

  protected openCarousel(index: number): void {
    if (index < 0 || index >= this.stories.length) {
      return;
    }

    this.carouselIndex.set(index);
    this.isCarouselOpen.set(true);
    this.stopAutoRotate();
  }

  protected closeCarousel(): void {
    if (!this.isCarouselOpen()) {
      return;
    }

    this.isCarouselOpen.set(false);
    this.selectStory(this.carouselIndex());
  }

  protected showPreviousCarouselImage(): void {
    this.carouselIndex.update((currentIndex) =>
      currentIndex === 0 ? this.stories.length - 1 : currentIndex - 1,
    );
  }

  protected showNextCarouselImage(): void {
    this.carouselIndex.update((currentIndex) => (currentIndex + 1) % this.stories.length);
  }

  protected selectCarouselImage(index: number): void {
    if (index < 0 || index >= this.stories.length) {
      return;
    }

    this.carouselIndex.set(index);
  }

  @HostListener('document:keydown', ['$event'])
  protected onDocumentKeydown(event: KeyboardEvent): void {
    if (!this.isCarouselOpen()) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeCarousel();
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.showPreviousCarouselImage();
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.showNextCarouselImage();
    }
  }

  private initRevealObserver(): void {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      this.isVisible.set(true);
      this.startAutoRotate();
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
        this.startAutoRotate();
        this.observer?.unobserve(entry.target);
      },
      {
        threshold: 0.25,
        rootMargin: '0px 0px -10% 0px',
      },
    );

    this.observer.observe(element);
  }

  private startAutoRotate(): void {
    if (typeof window === 'undefined' || this.stories.length < 2 || this.autoRotateId) {
      return;
    }

    this.autoRotateId = window.setInterval(() => {
      this.activeIndex.update((currentIndex) => (currentIndex + 1) % this.stories.length);
    }, 5000);
  }

  private stopAutoRotate(): void {
    if (!this.autoRotateId) {
      return;
    }

    clearInterval(this.autoRotateId);
    this.autoRotateId = null;
  }

  private restartAutoRotate(): void {
    this.stopAutoRotate();
    this.startAutoRotate();
  }
}
