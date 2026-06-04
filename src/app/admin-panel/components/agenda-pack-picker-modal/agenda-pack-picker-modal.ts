import { Component, EventEmitter, Input, Output, signal } from '@angular/core';

interface AgendaPackOption {
  id: number;
  nombre: string;
}

type SelectionType = 'pack' | 'treatment';
type TabType = 'packs' | 'treatments';

@Component({
  selector: 'app-agenda-pack-picker-modal',
  standalone: true,
  templateUrl: './agenda-pack-picker-modal.html',
  styleUrl: './agenda-pack-picker-modal.scss',
})
export class AgendaPackPickerModalComponent {
  @Input() visible = false;
  @Input() packOptions: AgendaPackOption[] = [];
  @Input() treatmentOptions: AgendaPackOption[] = [];
  @Input() selectedTypeId = 1;

  @Output() close = new EventEmitter<void>();
  @Output() selectType = new EventEmitter<{ id: number; type: SelectionType }>();
  @Output() confirm = new EventEmitter<void>();

  protected readonly selectedTab = signal<TabType>('packs');
  protected selectionType: SelectionType = 'pack';

  protected setSelectedTab(tab: TabType): void {
    this.selectedTab.set(tab);
  }

  protected onSelectChange(event: Event, type: SelectionType): void {
    const target = event.target as HTMLSelectElement;
    const next = Number(target.value);

    if (Number.isFinite(next) && next > 0) {
      this.selectionType = type;
      this.selectType.emit({ id: next, type });
    }
  }
}
