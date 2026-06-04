import { Component, EventEmitter, Input, Output } from '@angular/core';

interface ClientSummaryCard {
  id: string;
  fullName: string;
  treatments: unknown[];
}

@Component({
  selector: 'app-client-summary-list',
  standalone: true,
  templateUrl: './client-summary-list.html',
  styleUrl: './client-summary-list.scss',
})
export class ClientSummaryListComponent {
  @Input() cards: ClientSummaryCard[] = [];
  @Input() emptyMessage = 'Todavía no hay fichas de clientes.';

  @Output() openCard = new EventEmitter<string>();
}
