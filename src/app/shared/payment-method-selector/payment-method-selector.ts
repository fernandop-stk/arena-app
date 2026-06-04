import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-payment-method-selector',
  standalone: true,
  templateUrl: './payment-method-selector.html',
  styleUrl: './payment-method-selector.scss',
})
export class PaymentMethodSelectorComponent {
  @Input() selectedMethod: 'efectivo' | 'tarjeta' | 'bizum' | null = null;
  @Output() methodChange = new EventEmitter<'efectivo' | 'tarjeta' | 'bizum'>();

  protected select(method: 'efectivo' | 'tarjeta' | 'bizum'): void {
    this.methodChange.emit(method);
  }
}
