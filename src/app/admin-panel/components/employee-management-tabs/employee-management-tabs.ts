import { Component, EventEmitter, Input, Output } from '@angular/core';

type EmployeeManagementTab = 'crear' | 'listado' | 'buscar' | 'superadmin';

@Component({
  selector: 'app-employee-management-tabs',
  standalone: true,
  templateUrl: './employee-management-tabs.html',
  styleUrl: './employee-management-tabs.scss',
})
export class EmployeeManagementTabsComponent {
  @Input() activeTab: EmployeeManagementTab = 'listado';
  @Output() tabChange = new EventEmitter<EmployeeManagementTab>();

  protected setTab(tab: EmployeeManagementTab): void {
    this.tabChange.emit(tab);
  }
}
