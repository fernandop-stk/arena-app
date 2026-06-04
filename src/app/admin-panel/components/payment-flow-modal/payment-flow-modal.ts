import { Component, EventEmitter, Input, Output } from '@angular/core';
import { getPackPriceByName } from '../../../../shared/pack-prices';
import { PaymentMethodSelectorComponent } from '../../../shared/payment-method-selector/payment-method-selector';

interface PaymentTreatmentItem {
  id: string;
  name: string;
  priceEuro?: number;
  paymentMethod?: 'efectivo' | 'tarjeta' | 'bizum' | null;
}

interface SelectedTreatmentItem {
  id: string;
  name: string;
  priceEuro?: number;
}

@Component({
  selector: 'app-payment-flow-modal',
  standalone: true,
  imports: [PaymentMethodSelectorComponent],
  templateUrl: './payment-flow-modal.html',
  styleUrl: './payment-flow-modal.scss',
})
export class PaymentFlowModalComponent {
  @Input() showTreatmentPicker = false;
  @Input() showMethodPicker = false;
  @Input() treatments: PaymentTreatmentItem[] = [];
  @Input() paymentError = '';
  @Input() paymentLoading = false;
  @Input() selectedTreatment: SelectedTreatmentItem | null = null;
  @Input() selectedMethod: 'efectivo' | 'tarjeta' | 'bizum' | null = null;
  @Input() paymentAmount = '';

  @Output() close = new EventEmitter<void>();
  @Output() pickTreatment = new EventEmitter<SelectedTreatmentItem>();
  @Output() back = new EventEmitter<void>();
  @Output() methodChange = new EventEmitter<'efectivo' | 'tarjeta' | 'bizum'>();
  @Output() amountChange = new EventEmitter<string>();
  @Output() confirm = new EventEmitter<void>();

  protected getDisplayPrice(treatment: PaymentTreatmentItem): number {
    return treatment.priceEuro ?? getPackPriceByName(treatment.name);
  }
}
