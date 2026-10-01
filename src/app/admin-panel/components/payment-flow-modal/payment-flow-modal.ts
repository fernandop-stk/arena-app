import { Component, EventEmitter, Input, Output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { getPackPriceByName } from '../../../../shared/pack-prices';
import { PaymentMethodSelectorComponent } from '../../../shared/payment-method-selector/payment-method-selector';

interface PaymentTreatmentItem {
  id: string;
  name: string;
  priceEuro?: number;
  paymentMethod?: 'efectivo' | 'tarjeta' | 'bizum' | 'bono' | null;
}

interface SelectedTreatmentItem {
  id: string;
  name: string;
  priceEuro?: number;
}

interface PaymentGiftVoucherItem {
  id: string;
  balanceEuro: number;
}

@Component({
  selector: 'app-payment-flow-modal',
  standalone: true,
  imports: [PaymentMethodSelectorComponent, DecimalPipe],
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
  @Input() giftVouchers: PaymentGiftVoucherItem[] = [];
  @Input() selectedGiftVoucherId = '';
  @Input() giftVoucherAmount = '0';

  @Output() close = new EventEmitter<void>();
  @Output() pickTreatment = new EventEmitter<SelectedTreatmentItem>();
  @Output() back = new EventEmitter<void>();
  @Output() methodChange = new EventEmitter<'efectivo' | 'tarjeta' | 'bizum'>();
  @Output() amountChange = new EventEmitter<string>();
  @Output() giftVoucherChange = new EventEmitter<string>();
  @Output() giftVoucherAmountChange = new EventEmitter<string>();
  @Output() confirm = new EventEmitter<void>();

  protected getDisplayPrice(treatment: PaymentTreatmentItem): number {
    return treatment.priceEuro ?? getPackPriceByName(treatment.name);
  }

  protected getSelectedGiftVoucher(): PaymentGiftVoucherItem | null {
    return this.giftVouchers.find((voucher) => voucher.id === this.selectedGiftVoucherId) ?? null;
  }

  protected getCashAmountRemaining(): number {
    const total = Math.max(0, Number(this.paymentAmount.replace(',', '.')) || 0);
    const voucherAmount = Math.max(0, Number(this.giftVoucherAmount.replace(',', '.')) || 0);
    return Math.max(0, Number((total - voucherAmount).toFixed(2)));
  }
}
