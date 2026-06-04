import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-role-change-confirm-modal',
  standalone: true,
  templateUrl: './role-change-confirm-modal.html',
  styleUrl: './role-change-confirm-modal.scss',
})
export class RoleChangeConfirmModalComponent {
  @Input() open = false;
  @Input() employeeName = '';
  @Input() summaryText = '';

  @Output() cancel = new EventEmitter<void>();
  @Output() accept = new EventEmitter<void>();
}
