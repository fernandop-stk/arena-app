import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  TratamientoInvitadaOption,
  TratamientoItem,
  TratamientosService,
} from './tratamientos.service';

@Component({
  selector: 'app-tratamientos',
  imports: [RouterLink],
  templateUrl: './tratamientos.html',
  styleUrl: './tratamientos.scss',
})
export class TratamientosComponent {
  protected readonly tratamientosService = inject(TratamientosService);
  private readonly router = inject(Router);

  protected readonly title = this.tratamientosService.getTitle();
  protected readonly description = this.tratamientosService.getDescription();
  protected readonly packs = this.tratamientosService.getPacks();
  protected readonly tratamientos = this.tratamientosService.getTratamientos();
  protected readonly activeSection = signal<'packs' | 'tratamientos'>('packs');
  protected readonly currentItems = computed(() =>
    this.activeSection() === 'packs' ? this.packs : this.tratamientos,
  );
  protected readonly groupedTratamientos = computed(() => {
    const order = [
      'Tratamientos Arena',
      'Tratamientos exprés y personalizados',
      'Tratamientos intensivos',
      'Tratamientos con asesoría previa',
      'Cuidados y prevención',
    ];

    const groups = new Map<string, TratamientoItem[]>();

    order.forEach((name) => groups.set(name, []));

    this.tratamientos.forEach((item) => {
      const key = item.categoria ?? 'Cuidados y prevención';

      if (!groups.has(key)) {
        groups.set(key, []);
      }

      groups.get(key)?.push(item);
    });

    return order
      .map((title) => ({ title, items: groups.get(title) ?? [] }))
      .filter((group) => group.items.length > 0);
  });
  protected readonly selectedTratamiento = signal<TratamientoItem | null>(null);

  protected selectSection(section: 'packs' | 'tratamientos'): void {
    this.activeSection.set(section);
    this.closeTreatment();
  }

  protected isCardVisible(id: number): boolean {
    return id > 0;
  }

  protected openTreatment(item: TratamientoItem): void {
    this.selectedTratamiento.set(item);
  }

  protected closeTreatment(): void {
    this.selectedTratamiento.set(null);
  }

  protected getDescripcionItems(descripcion: string): string[] {
    return descripcion
      .split('•')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  protected reserveTreatment(item: TratamientoItem): Promise<boolean> {
    if (!this.canReserveTreatment(item)) {
      return Promise.resolve(false);
    }

    return this.router.navigate(['/reservas/calendario'], {
      queryParams: {
        tipo: item.appointmentTypeId,
      },
    });
  }

  protected canReserveTreatment(item: TratamientoItem): boolean {
    return Boolean(item.appointmentTypeId && item.appointmentTypeId > 0);
  }

  protected reserveInvitadaOption(option: TratamientoInvitadaOption): Promise<boolean> {
    return this.router.navigate(['/reservas/calendario'], {
      queryParams: {
        tipo: option.appointmentTypeId,
      },
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscapeKey(): void {
    this.closeTreatment();
  }
}
