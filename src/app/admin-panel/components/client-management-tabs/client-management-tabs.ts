import { Component, EventEmitter, Input, Output } from '@angular/core';

type ClientManagementTab = 'crear' | 'listado' | 'buscar';

@Component({
  selector: 'app-client-management-tabs',
  standalone: true,
  templateUrl: './client-management-tabs.html',
  styleUrl: './client-management-tabs.scss',
})
export class ClientManagementTabsComponent {
  @Input() activeTab: ClientManagementTab = 'listado';
  @Output() tabChange = new EventEmitter<ClientManagementTab>();

  protected setTab(tab: ClientManagementTab): void {
    this.tabChange.emit(tab);
  }
}
