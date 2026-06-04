import { Component, EventEmitter, Input, Output } from '@angular/core';

type EmployeeRoleFilter = 'all' | 'superadmin' | 'admin' | 'client';

@Component({
  selector: 'app-employee-search-filters',
  standalone: true,
  templateUrl: './employee-search-filters.html',
  styleUrl: './employee-search-filters.scss',
})
export class EmployeeSearchFiltersComponent {
  @Input() search = '';
  @Input() roleFilter: EmployeeRoleFilter = 'all';

  @Output() searchInput = new EventEmitter<Event>();
  @Output() roleFilterChange = new EventEmitter<Event>();
}
