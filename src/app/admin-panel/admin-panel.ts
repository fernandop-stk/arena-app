import { DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnDestroy, afterNextRender, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CitasService, type AppointmentType } from '../citas/citas.service';
import { getPackPriceByName } from '../../shared/pack-prices';
import { TratamientosService, type TratamientoItem } from '../tratamientos/tratamientos.service';
import { AgendaPackPickerModalComponent } from './components/agenda-pack-picker-modal/agenda-pack-picker-modal';
import { PaymentFlowModalComponent } from './components/payment-flow-modal/payment-flow-modal';
import { ClientManagementTabsComponent } from './components/client-management-tabs/client-management-tabs';
import { ClientSummaryListComponent } from './components/client-summary-list/client-summary-list';
import { EmployeeManagementTabsComponent } from './components/employee-management-tabs/employee-management-tabs';
import { EmployeeSummaryListComponent } from './components/employee-summary-list/employee-summary-list';
import {
  EmployeeCreateFormComponent,
  type EmployeePermission,
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
} from './components/employee-create-form/employee-create-form';
import { EmployeeSearchFiltersComponent } from './components/employee-search-filters/employee-search-filters';
import { EmployeeTrackingCalendarModalComponent } from './components/employee-tracking-calendar-modal/employee-tracking-calendar-modal';
import { RoleChangeConfirmModalComponent } from './components/role-change-confirm-modal/role-change-confirm-modal';
import { NotificationBadgeComponent } from './components/notification-badge/notification-badge.component';
import { EmployeeAdminService } from './services/employee-admin.service';

type AdminTab =
  | 'home'
  | 'agenda'
  | 'empleados'
  | 'clientes'
  | 'estadisticas'
  | 'almacen'
  | 'cierre'
  | 'ayuda';
type AgendaManagementTab = 'listado' | 'gestion' | 'bloqueos';
type AgendaRange = 'hoy' | 'semana' | 'mes';
type ReservationListRangeTab = 'none' | 'dia' | 'semana' | 'mes' | 'total';
type StockManagementTab = 'crear' | 'ver' | 'vender' | 'historial';
type CierreManagementTab = 'registro' | 'historial' | 'estadisticas';
type CierreStatsRange = 'semana' | 'mes' | 'anio';
type CierreStatsMetric = 'efectivo' | 'tarjeta' | 'bizum' | 'digital' | 'total';
type AdminCardTarget = 'packs' | 'reservas' | 'agenda' | 'clientes' | 'almacen' | 'cierre';
type EmployeeManagementTab = 'crear' | 'listado' | 'buscar' | 'superadmin';
type ClientManagementTab = 'crear' | 'listado' | 'buscar';
type AdminUserRole = 'superadmin' | 'admin' | 'client';
type EmployeeWorkStatus = 'idle' | 'working' | 'vacation' | 'sick_leave' | 'recovering_hours';
type GlobalTreatmentFilterPreset = 'all' | 'month' | 'last30' | 'year' | 'custom';
type GlobalTreatmentTimelineGrouping = 'month' | 'week' | 'day';
type GlobalTreatmentTimelineGroupingOption = 'auto' | GlobalTreatmentTimelineGrouping;
type EmployeeTrackingAction =
  | 'check_in'
  | 'check_out'
  | 'vacation'
  | 'sick_leave'
  | 'recovering_hours'
  | 'clear_status';

type EmployeeTrackingCalendarAction = 'vacation' | 'sick_leave' | 'recovering_hours';
type AgendaPreferredView = 'week' | 'month';

interface EmployeeTrackingHistoryItem {
  action: EmployeeTrackingAction;
  createdAtIso: string;
  note: string;
}

interface EmployeeTrackingStats {
  checkIns: number;
  checkOuts: number;
  vacations: number;
  sickLeaves: number;
  recoveryHours: number;
  clearedStates: number;
}

interface AdminReservationItem {
  id: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  appointmentTypeName: string;
  paymentReceived: boolean;
  adminStatus: 'pending' | 'accepted' | 'rejected';
  clientConfirmationStatus: 'pending' | 'confirmed';
  clientConfirmationReminderSentAtIso?: string | null;
  createdByEmail?: string | null;
  createdAtIso: string;
}

interface AdminBlockedPeriodItem {
  id: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  reason: string;
  createdAtIso: string;
}

interface AdminCalendarDay {
  dateIso: string;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isPast: boolean;
  isFullBlocked: boolean;
  hasPartialBlocked: boolean;
  reservationCount: number;
}

interface AgendaMonthCalendarDay {
  dateIso: string;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  reservationCount: number;
  isClosedDay: boolean;
}

interface AgendaWeekDay {
  dateIso: string;
  label: string;
  shortLabel: string;
  isToday: boolean;
  reservationCount: number;
  alertCount: number;
  pendingAlertCount: number;
  isClosedDay: boolean;
}

interface AgendaDayWorkerSection {
  workerKey: string;
  workerLabel: string;
}

interface AgendaAlertItem {
  id: string;
  clientEmail: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  appointmentTypeName: string;
  status: 'active' | 'completed' | 'cancelled';
  approvalStatus: 'pending' | 'approved' | 'rejected';
  createdAtIso: string;
  approvedAtIso?: string | null;
  approvedByEmail?: string | null;
}

interface AdminEmployeeUser {
  email: string;
  username: string;
  role: AdminUserRole;
  createdAtIso: string;
  permissions: EmployeePermission[];
  tracking: {
    workStatus: EmployeeWorkStatus;
    lastCheckInIso: string;
    lastCheckOutIso: string;
    vacationNote: string;
    sickLeaveNote: string;
    recoveryHoursNote: string;
    history: EmployeeTrackingHistoryItem[];
  };
}

interface ClientCardItem {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  birthDateIso?: string;
  notes: string;
  createdAtIso: string;
  createdByEmail: string;
  treatments: Array<{
    id: string;
    name: string;
    note: string;
    createdAtIso: string;
    createdByEmail: string;
    priceEuro?: number;
    paymentMethod?: 'efectivo' | 'tarjeta' | 'bizum' | null;
  }>;
}

interface StockProductItem {
  id: string;
  productName: string;
  brand: string;
  quantity: number;
  price: number;
  color: string;
  isSellable: boolean;
  createdAtIso: string;
  createdByEmail: string;
}

interface StockSaleHistoryItem {
  id: string;
  productId: string;
  productName: string;
  soldUnits: number;
  unitPrice: number;
  totalAmount: number;
  paymentMethod: 'efectivo' | 'tarjeta' | 'bizum';
  soldByEmail: string;
  soldAtIso: string;
}

interface CierreOperationDetailItem {
  id: string;
  operationType: 'stock_sale' | 'client_pack_payment' | 'reservation_payment';
  concept: string;
  amount: number;
  paymentMethod: 'efectivo' | 'tarjeta' | 'bizum';
  performedByEmail: string;
  createdAtIso: string;
}

interface CierreCajaItem {
  id: string;
  fechaIso: string;
  efectivo: number;
  tarjeta: number;
  bizum: number;
  total: number;
  notas: string;
  registradoPorEmail: string;
  createdAtIso: string;
  // preparado para envío a servicio fiscal externo
  enviadoAlServicioFiscal: boolean;
  idServicioFiscal: string;
  operationDetails: CierreOperationDetailItem[];
}

interface CierreAutoDiario {
  dateIso: string;
  efectivo: number;
  tarjeta: number;
  bizum: number;
  total: number;
  updatedAtIso: string;
  operationDetails: CierreOperationDetailItem[];
}

interface ClientTreatmentPieSlice {
  name: string;
  count: number;
  percentage: number;
  color: string;
}

interface ClientTreatmentPieData {
  total: number;
  gradient: string;
  slices: ClientTreatmentPieSlice[];
}

interface RevenueCategoryRow {
  name: string;
  amount: number;
  percentage: number;
  color: string;
  heightPercent: number;
}

interface RevenuePieData {
  total: number;
  gradient: string;
  slices: RevenueCategoryRow[];
}

interface RevenueTimelineRow {
  key: string;
  label: string;
  shortLabel: string;
  tooltipLabel: string;
  amount: number;
  color: string;
  heightPercent: number;
  showLabel: boolean;
}

type ClientChartType = 'bar' | 'pie';

interface ClientTreatmentCategoryRow {
  name: string;
  count: number;
  percentage: number;
  color: string;
  heightPercent: number;
}

interface GlobalTreatmentTimelineRow {
  key: string;
  label: string;
  shortLabel: string;
  tooltipLabel: string;
  count: number;
  color: string;
  heightPercent: number;
  showLabel: boolean;
}

interface GlobalTreatmentEmployeeOption {
  email: string;
  label: string;
}

interface GlobalTreatmentEmployeeRankingRow {
  email: string;
  label: string;
  count: number;
  percentage: number;
  color: string;
  widthPercent: number;
}

interface GlobalTreatmentEmployeeSpecialtyItem {
  name: string;
  count: number;
}

interface GlobalTreatmentEmployeeSpecialtyRow {
  email: string;
  label: string;
  totalCount: number;
  topTreatmentLabel: string;
  uniqueTreatmentsCount: number;
  topTreatments: GlobalTreatmentEmployeeSpecialtyItem[];
}

interface GlobalTreatmentPreferencesStorage {
  chartType: ClientChartType;
  employeeFilterEmail: string;
  filterPreset: GlobalTreatmentFilterPreset;
  startDateIso: string;
  endDateIso: string;
  timelineGrouping: GlobalTreatmentTimelineGroupingOption;
  treatmentNames: string[];
}

interface GlobalTreatmentSavedView {
  id: string;
  name: string;
  updatedAtIso: string;
  preferences: GlobalTreatmentPreferencesStorage;
}

interface EmployeeCreateFieldErrors {
  username: string;
  email: string;
  password: string;
}

interface ClientTreatmentCatalogOption {
  name: string;
  priceEuro?: number;
  priceLabel: string;
}

@Component({
  selector: 'app-admin-panel',
  imports: [
    RouterLink,
    DecimalPipe,
    AgendaPackPickerModalComponent,
    PaymentFlowModalComponent,
    ClientManagementTabsComponent,
    ClientSummaryListComponent,
    EmployeeManagementTabsComponent,
    EmployeeSummaryListComponent,
    EmployeeCreateFormComponent,
    EmployeeSearchFiltersComponent,
    EmployeeTrackingCalendarModalComponent,
    RoleChangeConfirmModalComponent,
    NotificationBadgeComponent,
  ],
  templateUrl: './admin-panel.html',
  styleUrl: './admin-panel.scss',
})
export class AdminPanelComponent implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly citasService = inject(CitasService);
  private readonly tratamientosService = inject(TratamientosService);
  private readonly employeeAdminService = inject(EmployeeAdminService);
  private readonly globalTreatmentPreferencesStorageKey =
    'arena-app:admin-panel:global-treatment-preferences';
  private readonly globalTreatmentSavedViewsStorageKey =
    'arena-app:admin-panel:global-treatment-saved-views';
  private readonly agendaPreferredViewStorageKey = 'arena-app:admin-panel:agenda-preferred-view';
  private readonly cierreManagementTabStorageKey = 'arena-app:admin-panel:cierre-management-tab';
  protected readonly clientPackOptions: ClientTreatmentCatalogOption[] = this.tratamientosService
    .getPacks()
    .map((item) => ({
      name: item.nombre,
      priceEuro: this.getPackPriceByName(item.nombre),
      priceLabel: item.precio,
    }))
    .filter((option, index, list) => list.findIndex((item) => item.name === option.name) === index);
  protected readonly clientTratamientoOptions: ClientTreatmentCatalogOption[] =
    this.tratamientosService
      .getTratamientos()
      .map((item) => ({
        name: item.nombre,
        priceEuro: this.getPackPriceByName(item.nombre),
        priceLabel: item.precio,
      }))
      .filter(
        (option, index, list) => list.findIndex((item) => item.name === option.name) === index,
      );
  private readonly clientTreatmentPalette = [
    '#d97757',
    '#d9a441',
    '#7e9f7d',
    '#7aa7d8',
    '#b48ad8',
    '#f18b8b',
    '#90c8b1',
    '#f3b076',
  ];

  protected readonly isChecking = signal(true);
  protected readonly showInactivityWarning = signal(false);
  protected readonly showForcedCheckInModal = signal(false);
  protected readonly forcedCheckInLoading = signal(false);
  protected readonly forcedCheckInError = signal('');
  private inactivityTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityMs = 0;
  private readonly INACTIVITY_MS = 5 * 60 * 1000;
  private readonly WARNING_MS = 4 * 60 * 1000;
  private readonly onReturnHomeFromHeader = (): void => {
    this.closeTransientOverlaysBeforeHomeNavigation();
    this.setActiveTab('home');

    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };
  protected readonly activeTab = signal<AdminTab>('home');
  protected readonly agendaManagementTab = signal<AgendaManagementTab>('listado');
  protected readonly agendaRange = signal<AgendaRange>('hoy');
  protected readonly agendaSelectedDateIso = signal('');
  protected readonly showAgendaPackPicker = signal(false);
  protected readonly agendaPackOptions = this.citasService.getAppointmentTypes();
  protected readonly agendaTreatmentCatalog = this.tratamientosService.getTratamientos();
  protected readonly agendaTreatmentOptions = this.agendaTreatmentCatalog.map((t) => ({
    id: t.id,
    nombre: t.nombre,
  }));
  protected readonly agendaSelectedPackTypeId = signal<number>(
    this.citasService.getAppointmentTypes()[0]?.id ?? 1,
  );
  protected readonly agendaSelectedServiceType = signal<'pack' | 'treatment'>('pack');
  protected readonly isLoadingReservations = signal(false);
  protected readonly showAgendaCalendarModal = signal(false);
  protected readonly agendaCalendarMonthIso = signal('');
  protected readonly showAgendaWeekScheduleModal = signal(false);
  protected readonly agendaWeekStartIso = signal('');
  protected readonly agendaAlerts = signal<AgendaAlertItem[]>([]);
  protected readonly agendaAlertsLoading = signal(false);
  protected readonly agendaAlertsError = signal('');
  protected readonly agendaAlertActionLoadingId = signal('');
  protected readonly showAgendaDayScheduleModal = signal(false);
  protected readonly agendaDayScheduleDateIso = signal('');
  protected readonly agendaDayScheduleError = signal('');
  protected readonly agendaDayScheduleLoadingReservationId = signal('');
  protected readonly agendaDraggedReservationId = signal('');
  protected readonly agendaTimeSlotOptions = this.buildHalfHourOptions('09:00', '18:00');
  protected readonly agendaDurationOptions = Array.from(
    { length: 12 },
    (_, index) => (index + 1) * 30,
  );
  protected readonly agendaDurationDraftByReservationId = signal<Record<string, number>>({});
  protected readonly agendaDropToast = signal('');
  protected readonly agendaDetailReservation = signal<AdminReservationItem | null>(null);
  protected readonly agendaDetailMode = signal<'view' | 'edit'>('view');
  protected readonly agendaEditDraftName = signal('');
  protected readonly agendaEditDraftDuration = signal(0);
  protected readonly agendaDetailSaving = signal(false);
  protected readonly agendaDetailError = signal('');
  protected readonly agendaDetailCancelling = signal(false);
  protected readonly agendaDetailConfirmAfterPaymentReservationId = signal('');
  protected readonly showAgendaConfirmReservationModal = signal(false);
  protected readonly agendaConfirmReservationWorkerEmail = signal('');
  protected readonly showAgendaUnassignedReservationsModal = signal(false);
  protected readonly agendaUnassignedAssignReservationId = signal('');
  protected readonly agendaUnassignedAssignWorkerEmail = signal('');
  protected readonly agendaUnassignedAssignLoadingId = signal('');
  protected readonly agendaUnassignedAssignError = signal('');
  protected readonly showQuickReserveModal = signal(false);
  protected readonly showAgendaManualReserveModal = signal(false);
  protected readonly agendaManualReserveLoading = signal(false);
  protected readonly agendaManualReserveError = signal('');
  protected readonly agendaManualReserveDateIso = signal('');
  protected readonly agendaManualReserveTime = signal('');
  protected readonly agendaManualReserveWorkerEmail = signal('');
  protected readonly agendaManualReserveAssignToMe = signal(true);
  protected readonly agendaManualReserveCustomerName = signal('');
  protected readonly agendaManualReserveCustomerPhone = signal('');
  protected readonly agendaManualReserveCustomerEmail = signal('');
  protected readonly agendaManualReserveServiceType = signal<'pack' | 'treatment'>('pack');
  protected readonly agendaManualReserveServiceId = signal<number>(
    this.agendaPackOptions[0]?.id ?? 1,
  );
  protected readonly agendaManualReserveDuration = signal<number>(
    this.agendaPackOptions[0]?.duracionMinutos ?? 60,
  );
  protected readonly helpSearch = signal('');
  protected readonly isLoadingBlockedPeriods = signal(false);
  protected readonly ownerEmail = signal('');
  protected readonly ownerUsername = signal('');
  protected readonly stockManagementTab = signal<StockManagementTab>('crear');
  protected readonly stockProducts = signal<StockProductItem[]>([]);
  protected readonly isLoadingStockProducts = signal(false);
  protected readonly stockError = signal('');
  protected readonly stockMessage = signal('');
  protected readonly stockCreateName = signal('');
  protected readonly stockCreateBrand = signal('');
  protected readonly stockCreateQuantity = signal('');
  protected readonly stockCreatePrice = signal('');
  protected readonly stockCreateColor = signal('');
  protected readonly stockCreateIsSellable = signal(false);
  protected readonly stockCreateLoading = signal(false);
  protected readonly stockFilterName = signal('');
  protected readonly stockFilterBrand = signal('');
  protected readonly stockFilterColor = signal('');
  protected readonly stockFilterMinQuantity = signal('');
  protected readonly stockFilterMaxPrice = signal('');
  protected readonly stockAdjustingProductId = signal('');
  protected readonly stockDeletingProductId = signal('');
  protected readonly showDeleteStockConfirmModal = signal(false);
  protected readonly deleteStockTargetProductId = signal('');
  protected readonly showEditStockModal = signal(false);
  protected readonly editStockTargetProductId = signal('');
  protected readonly editStockName = signal('');
  protected readonly editStockPrice = signal('');
  protected readonly editStockIsSellable = signal(false);
  protected readonly editStockLoading = signal(false);
  protected readonly stockAdjustError = signal('');
  protected readonly stockSaleProductId = signal('');
  protected readonly stockSaleUnits = signal('1');
  protected readonly stockSalePaymentMethod = signal<'efectivo' | 'tarjeta' | 'bizum' | ''>('');
  protected readonly stockSaleLoading = signal(false);
  protected readonly stockSaleError = signal('');
  protected readonly showStockSaleModal = signal(false);
  protected readonly stockSalesHistory = signal<StockSaleHistoryItem[]>([]);
  protected readonly stockSalesHistoryLoading = signal(false);
  protected readonly stockSalesHistoryDateFilter = signal('');
  protected readonly stockSalesHistoryMethodFilter = signal<
    'all' | 'efectivo' | 'tarjeta' | 'bizum'
  >('all');

  // ── Cierre de caja ──────────────────────────────────────────────────────────
  protected readonly cierreEfectivo = signal('');
  protected readonly cierreTarjeta = signal('');
  protected readonly cierreBizum = signal('');
  protected readonly cierreNotas = signal('');
  protected readonly cierreLoading = signal(false);
  protected readonly cierreError = signal('');
  protected readonly cierreMessage = signal('');
  protected readonly cierreAlreadyClosedToday = signal(false);
  protected readonly cierreManagementTab = signal<CierreManagementTab>('registro');
  protected readonly cierreHistorial = signal<CierreCajaItem[]>([]);
  protected readonly isLoadingCierres = signal(false);
  protected readonly cierreAutoDiario = signal<CierreAutoDiario | null>(null);
  protected readonly isLoadingCierreAutoDiario = signal(false);
  protected readonly cierreStatsRange = signal<CierreStatsRange>('mes');
  protected readonly cierreStatsMetric = signal<CierreStatsMetric>('total');
  protected readonly showCierreDetailsModal = signal(false);
  protected readonly selectedCierreForDetails = signal<CierreCajaItem | null>(null);
  protected readonly cierreDetailsMethodFilters = signal({
    efectivo: true,
    tarjeta: true,
    bizum: true,
  });
  protected readonly cierreDetailsEmployeeFilter = signal('all');
  // Edición de cierre
  protected readonly editingCierre = signal<CierreCajaItem | null>(null);
  protected readonly editCierreEfectivo = signal('');
  protected readonly editCierreTarjeta = signal('');
  protected readonly editCierreBizum = signal('');
  protected readonly editCierreNotas = signal('');
  protected readonly editCierreLoading = signal(false);
  protected readonly editCierreError = signal('');
  // Borrado de cierre
  protected readonly deletingCierreId = signal('');
  protected readonly deleteCierreLoading = signal(false);
  protected readonly cierreTotal = computed(() => {
    const ef = parseFloat(this.cierreEfectivo()) || 0;
    const ta = parseFloat(this.cierreTarjeta()) || 0;
    const bi = parseFloat(this.cierreBizum()) || 0;
    return ef + ta + bi;
  });
  protected readonly cierreEfectivoNum = computed(() => parseFloat(this.cierreEfectivo()) || 0);
  protected readonly cierreTarjetaNum = computed(() => parseFloat(this.cierreTarjeta()) || 0);
  protected readonly cierreBizumNum = computed(() => parseFloat(this.cierreBizum()) || 0);

  protected readonly reservations = signal<AdminReservationItem[]>([]);
  protected readonly reservationListRangeTab = signal<ReservationListRangeTab>('none');
  protected readonly reservationFilterName = signal('');
  protected readonly reservationFilterDate = signal('');
  protected readonly reservationFilterPack = signal('');
  protected readonly hasSelectedReservationListRange = computed(
    () => this.reservationListRangeTab() !== 'none',
  );
  protected readonly reservationsInSelectedListRange = computed(() => {
    const visibleReservations = this.getReservationListVisibleReservations();
    const rangeTab = this.reservationListRangeTab();

    if (rangeTab === 'none') {
      return [];
    }

    if (rangeTab === 'total') {
      return visibleReservations;
    }

    const baseDateIso = this.agendaSelectedDateIso() || this.getTodayIso();

    if (rangeTab === 'dia') {
      return visibleReservations.filter((reservation) => reservation.dateIso === baseDateIso);
    }

    if (rangeTab === 'semana') {
      const baseDate = new Date(`${baseDateIso}T00:00:00`);
      const weekDay = baseDate.getDay();
      const diffToMonday = weekDay === 0 ? -6 : 1 - weekDay;
      const weekStart = new Date(baseDate);
      weekStart.setDate(baseDate.getDate() + diffToMonday);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      const startIso = this.toDateIso(weekStart);
      const endIso = this.toDateIso(weekEnd);

      return visibleReservations.filter(
        (reservation) => reservation.dateIso >= startIso && reservation.dateIso <= endIso,
      );
    }

    const [yearRaw, monthRaw] = baseDateIso.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);

    if (Number.isNaN(year) || Number.isNaN(month)) {
      return [];
    }

    const monthStartIso = `${year}-${`${month}`.padStart(2, '0')}-01`;
    const monthEndIso = this.toDateIso(new Date(year, month, 0));

    return visibleReservations.filter(
      (reservation) => reservation.dateIso >= monthStartIso && reservation.dateIso <= monthEndIso,
    );
  });
  protected readonly isReservationFilterActive = computed(
    () =>
      !!this.reservationFilterName() ||
      !!this.reservationFilterDate() ||
      !!this.reservationFilterPack(),
  );
  protected readonly filteredReservations = computed(() => {
    const name = this.reservationFilterName().trim().toLowerCase();
    const date = this.reservationFilterDate().trim();
    const pack = this.reservationFilterPack().trim().toLowerCase();
    return this.reservationsInSelectedListRange().filter((r) => {
      if (name && !r.customerName.toLowerCase().includes(name)) return false;
      if (date && r.dateIso !== date) return false;
      if (pack && !r.appointmentTypeName.toLowerCase().includes(pack)) return false;
      return true;
    });
  });
  protected readonly blockedPeriods = signal<AdminBlockedPeriodItem[]>([]);
  protected readonly listError = signal('');
  protected readonly actionError = signal('');
  protected readonly actionLoadingId = signal('');
  protected readonly showPaymentMethodModal = signal(false);
  protected readonly paymentMethodReservationId = signal('');
  protected readonly showClientTypePickerModal = signal(false);
  protected readonly clientTypePickerReservationId = signal('');
  protected readonly selectedPaymentMethod = signal<'efectivo' | 'tarjeta' | 'bizum' | ''>('');
  protected readonly paymentMethodReservation = computed<AdminReservationItem | null>(() => {
    const reservationId = this.paymentMethodReservationId();

    if (!reservationId) {
      return null;
    }

    return this.reservations().find((item) => item.id === reservationId) ?? null;
  });
  protected readonly paymentMethodReservationPriceEuro = computed(() => {
    const reservation = this.paymentMethodReservation();

    if (!reservation) {
      return 0;
    }

    return this.getPackPriceByName(reservation.appointmentTypeName);
  });
  protected readonly blockDateIso = signal('');
  protected readonly calendarMonthIso = signal('');
  protected readonly blockStartTime = signal('10:00');
  protected readonly blockEndTime = signal('18:30');
  protected readonly blockStartOptions = this.buildHalfHourOptions('09:00', '18:00');
  protected readonly blockEndOptions = this.buildHalfHourOptions('09:30', '18:30');
  protected readonly blockReason = signal('');
  protected readonly isFullDayBlock = signal(true);
  protected readonly blockMessage = signal('');
  protected readonly blockError = signal('');
  protected readonly blockActionLoading = signal(false);
  protected readonly showDayReservationsModal = signal(false);
  protected readonly dayReservationsDateIso = signal('');
  protected readonly dayReservations = signal<AdminReservationItem[]>([]);
  protected readonly isSuperadmin = signal(false);
  protected readonly myPermissions = signal<EmployeePermission[]>([]);
  protected readonly showNoPermissionModal = signal(false);
  protected readonly noPermissionActionLabel = signal('');
  protected readonly noPermissionTooltip =
    'No tienes permiso para entrar aqui o realizar esta accion.';
  protected readonly employeeCreatePermissions = signal<EmployeePermission[]>([...ALL_PERMISSIONS]);
  protected readonly editingPermissionsEmail = signal('');
  protected readonly editingPermissions = signal<EmployeePermission[]>([]);
  protected readonly savingPermissions = signal(false);
  protected readonly employeeUsers = signal<AdminEmployeeUser[]>([]);
  protected readonly isLoadingEmployees = signal(false);
  protected readonly employeeActionLoadingEmail = signal('');
  protected readonly employeeError = signal('');
  protected readonly employeeMessage = signal('');
  protected readonly employeeSearch = signal('');
  protected readonly employeeRoleFilter = signal<'all' | 'admin' | 'client' | 'superadmin'>('all');
  protected readonly employeeTrackingNote = signal<Record<string, string>>({});
  protected readonly employeeManagementTab = signal<EmployeeManagementTab>('listado');
  protected readonly showEmployeeDetailModal = signal(false);
  protected readonly employeeDetailTab = signal<'acciones' | 'movimientos'>('movimientos');
  protected readonly showEmployeeTrackingCalendarModal = signal(false);
  protected readonly employeeTrackingCalendarEmail = signal('');
  protected readonly employeeTrackingCalendarAction =
    signal<EmployeeTrackingCalendarAction>('vacation');
  protected readonly employeeTrackingCalendarStartDateIso = signal('');
  protected readonly employeeTrackingCalendarEndDateIso = signal('');
  protected readonly showRoleChangeConfirmModal = signal(false);
  protected readonly roleChangeTargetEmail = signal('');
  protected readonly roleChangeTargetRole = signal<'admin' | 'client'>('client');
  protected readonly employeeHistoryStartDateIso = signal('');
  protected readonly employeeHistoryEndDateIso = signal('');
  protected readonly selectedEmployeeEmail = signal('');
  protected readonly employeeCreateUsername = signal('');
  protected readonly employeeCreateEmail = signal('');
  protected readonly employeeCreatePassword = signal('');
  protected readonly employeeCreateRole = signal<'admin' | 'client'>('admin');
  protected readonly employeeCreateLoading = signal(false);
  protected readonly superadminEditUsername = signal('');
  protected readonly superadminEditEmail = signal('');
  protected readonly superadminEditPassword = signal('');
  protected readonly superadminEditLoading = signal(false);
  protected readonly showSuperadminEditPassword = signal(false);
  protected readonly employeeCreateFieldErrors = signal<EmployeeCreateFieldErrors>({
    username: '',
    email: '',
    password: '',
  });
  protected readonly clientCards = signal<ClientCardItem[]>([]);
  protected readonly isLoadingClientCards = signal(false);
  protected readonly clientCardsError = signal('');
  protected readonly clientCardsMessage = signal('');
  protected readonly clientManagementTab = signal<ClientManagementTab>('listado');
  protected readonly showClientDetailModal = signal(false);
  protected readonly showDeleteClientConfirmModal = signal(false);
  protected readonly showClientStatsModal = signal(false);
  protected readonly selectedClientId = signal('');
  protected readonly clientFullName = signal('');
  protected readonly clientEmail = signal('');
  protected readonly clientPhone = signal('');
  protected readonly clientBirthDateIso = signal('');
  protected readonly clientNotes = signal('');
  protected readonly clientCardsSearch = signal('');
  protected readonly clientFormLoading = signal(false);
  protected readonly clientEditFullName = signal('');
  protected readonly clientEditEmail = signal('');
  protected readonly clientEditPhone = signal('');
  protected readonly clientEditBirthDateIso = signal('');
  protected readonly clientEditNotes = signal('');
  protected readonly clientEditLoading = signal(false);
  protected readonly clientDeleteLoading = signal(false);
  protected readonly clientTreatmentName = signal('');
  protected readonly clientTreatmentNote = signal('');
  protected readonly clientTreatmentLoading = signal(false);
  protected readonly paymentModalOpen = signal(false);
  protected readonly paymentSelectTreatmentOpen = signal(false);
  protected readonly selectedTreatmentForPayment = signal<{
    id: string;
    name: string;
    priceEuro?: number;
  } | null>(null);
  protected readonly paymentMethod = signal<'efectivo' | 'tarjeta' | 'bizum' | null>(null);
  protected readonly paymentAmount = signal('');
  protected readonly paymentLoading = signal(false);
  protected readonly paymentError = signal('');
  protected readonly clientChartType = signal<ClientChartType>('pie');
  protected readonly globalTreatmentFilterPreset = signal<GlobalTreatmentFilterPreset>('all');
  protected readonly globalTreatmentStartDateIso = signal('');
  protected readonly globalTreatmentEndDateIso = signal('');
  protected readonly globalTreatmentEmployeeFilterEmail = signal('all');
  protected readonly globalTreatmentNameFilters = signal<string[]>([]);
  protected readonly globalTreatmentTimelineGrouping =
    signal<GlobalTreatmentTimelineGroupingOption>('auto');
  protected readonly globalTreatmentSavedViewName = signal('');
  protected readonly globalTreatmentSavedViews = signal<GlobalTreatmentSavedView[]>([]);
  protected readonly hasHelpResults = computed(() => {
    const matches: boolean[] = [
      this.matchesHelpQuery('agenda citas reserva bloquear horas calendario cancelar modificar'),
      this.matchesHelpQuery('clientes clienta ficha alta buscar editar tratamiento pagos'),
      this.matchesHelpQuery('cierre caja importe historico editar eliminar pdf'),
      this.matchesHelpQuery('almacen productos stock inventario precio marca cantidad'),
      this.matchesHelpQuery('packs servicios tratamiento precio'),
      this.matchesHelpQuery('problemas frecuentes cita cancelada permisos cierre clienta'),
    ];

    if (this.isSuperadmin()) {
      matches.push(this.matchesHelpQuery('empleados permisos rol superadmin admin estado laboral'));
    }

    return matches.some(Boolean);
  });

  constructor() {
    this.resetEmployeeHistoryRangeToCurrentMonth();

    if (typeof window !== 'undefined') {
      window.addEventListener('arena-admin-return-home', this.onReturnHomeFromHeader);
    }

    // Use afterNextRender so the session check only runs AFTER full hydration.
    // Making HTTP calls during hydration with withEventReplay() can cause the
    // observable to never complete, leaving isChecking=true forever.
    afterNextRender(() => {
      this.restoreGlobalTreatmentSavedViews();
      this.restoreGlobalTreatmentPreferences();

      this.http
        .get<{
          ok: boolean;
          isAdmin: boolean;
          role?: AdminUserRole;
          email?: string;
          username?: string;
          permissions?: EmployeePermission[];
        }>('/api/auth/session')
        .subscribe({
          next: (response) => {
            if (!response.isAdmin) {
              void this.router.navigate(['/acceso']);
              return;
            }

            this.ownerEmail.set(response.email ?? '');
            this.ownerUsername.set(response.username ?? '');
            this.isSuperadmin.set(response.role === 'superadmin');
            this.myPermissions.set(response.permissions ?? []);
            this.loadReservations();
            this.loadAgendaAlerts();
            this.loadBlockedPeriods();
            this.loadClientCards();

            this.loadEmployeeUsers();

            const requestedTab = this.route.snapshot.queryParamMap.get('tab');

            if (requestedTab === 'empleados' && response.role === 'superadmin') {
              this.activeTab.set('empleados');
            } else if (requestedTab === 'estadisticas') {
              this.activeTab.set('estadisticas');
            } else if (requestedTab === 'agenda') {
              this.activeTab.set('agenda');
            }

            const today = new Date();
            const year = today.getFullYear();
            const month = `${today.getMonth() + 1}`.padStart(2, '0');
            const day = `${today.getDate()}`.padStart(2, '0');
            this.blockDateIso.set(`${year}-${month}-${day}`);
            this.calendarMonthIso.set(`${year}-${month}`);
            this.agendaCalendarMonthIso.set(`${year}-${month}`);
            this.agendaSelectedDateIso.set(`${year}-${month}-${day}`);

            // Start inactivity watcher for all admin users
            this.startInactivityWatcher();

            // For non-superadmin employees, check if they need to clock in today
            if (response.role === 'admin') {
              this.checkForcedCheckIn();
            }
          },
          error: () => {
            this.isChecking.set(false);
            void this.router.navigate(['/acceso']);
          },
          complete: () => {
            this.isChecking.set(false);
          },
        });
    });
  }

  protected setActiveTab(tab: AdminTab): void {
    if (!this.canAccessAdminTab(tab)) {
      this.openNoPermissionModal(this.getAdminTabActionLabel(tab));
      return;
    }

    if (tab === 'empleados' && !this.isSuperadmin()) {
      return;
    }

    this.activeTab.set(tab);
    this.listError.set('');
    this.actionError.set('');
    this.blockError.set('');
    this.blockMessage.set('');
    this.employeeError.set('');
    this.employeeMessage.set('');
    this.clientCardsError.set('');
    this.clientCardsMessage.set('');
    this.stockError.set('');
    this.stockMessage.set('');
    this.closeAgendaWeekScheduleModal();
    this.closeAgendaCalendarModal();
    this.employeeSearch.set('');
    this.employeeRoleFilter.set('all');

    if (tab === 'empleados' && this.isSuperadmin()) {
      this.employeeManagementTab.set('crear');
      this.loadEmployeeUsers();
    } else if (tab === 'agenda') {
      this.agendaManagementTab.set('listado');
      this.reservationListRangeTab.set('none');
      if (!this.agendaSelectedDateIso()) {
        this.agendaSelectedDateIso.set(this.getTodayIso());
      }

      const preferredAgendaView = this.getAgendaPreferredView();

      if (preferredAgendaView === 'month') {
        this.openAgendaCalendarModal();
      } else {
        this.openAgendaWeekScheduleModal(this.agendaSelectedDateIso() || this.getTodayIso());
      }
    } else if (tab === 'almacen') {
      this.stockManagementTab.set('crear');
      this.loadStockProducts();
    } else if (tab === 'cierre') {
      this.cierreManagementTab.set(this.getPreferredCierreManagementTab());
      this.cierreError.set('');
      this.cierreMessage.set('');
      this.loadCierres();
      this.loadCierreAutoDiario();
    }
  }

  protected setCierreManagementTab(tab: CierreManagementTab): void {
    this.cierreManagementTab.set(tab);
    this.persistCierreManagementTab(tab);
    this.cierreError.set('');
    this.cierreMessage.set('');

    if (tab === 'historial' || tab === 'estadisticas') {
      this.loadCierres();
    }

    if (tab === 'registro') {
      this.loadCierreAutoDiario();
    }
  }

  private closeTransientOverlaysBeforeHomeNavigation(): void {
    this.closeAgendaPackPicker();
    this.closeAgendaReservationDetail();
    this.closeAgendaCalendarModal();
    this.closeAgendaWeekScheduleModal();
    this.closeAgendaUnassignedReservationsModal();
    this.closeAgendaManualReserveModal();
    this.showQuickReserveModal.set(false);
    this.closeDeleteStockConfirmModal();
    this.closeEditStockModal();
    this.closeStockSaleModal();
    this.closeDeleteClientConfirmModal();
    this.closeClientStatsModal();
    this.closeClientDetailModal();
    this.closeCierreDetailsModal();
    this.closePaymentModal();
    this.closeDayReservationsModal();
    this.closeClientTypePickerModal();
    this.closePaymentMethodModal();
    this.closeNoPermissionModal();
    this.closeEmployeeTrackingCalendarModal();
    this.closeEmployeeDetailModal();
    this.cancelRoleChangeConfirm();
  }

  protected openAdminCard(target: AdminCardTarget): void {
    if (!this.canAccessAdminCard(target)) {
      this.openNoPermissionModal(this.getAdminCardActionLabel(target));
      return;
    }

    if (target === 'packs') {
      void this.router.navigate(['/packs']);
      return;
    }

    if (target === 'reservas') {
      void this.router.navigate(['/reservas']);
      return;
    }

    if (target === 'agenda') {
      this.setActiveTab('agenda');
      return;
    }

    if (target === 'clientes') {
      this.setActiveTab('clientes');
      return;
    }

    if (target === 'almacen') {
      this.setActiveTab('almacen');
      return;
    }

    this.setActiveTab('cierre');
  }

  protected setAgendaManagementTab(tab: AgendaManagementTab): void {
    if (tab === 'gestion') {
      return;
    }

    this.agendaManagementTab.set(tab);
  }

  protected openAgendaPackPicker(): void {
    this.showAgendaPackPicker.set(true);
  }

  protected closeAgendaPackPicker(): void {
    this.showAgendaPackPicker.set(false);
  }

  protected onAgendaPackTypeChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const next = Number(target.value);

    this.setAgendaSelectedPackTypeId({ id: next, type: 'pack' });
  }

  protected setAgendaSelectedPackTypeId(data: { id: number; type: 'pack' | 'treatment' }): void {
    if (!Number.isFinite(data.id) || data.id <= 0) {
      return;
    }

    this.agendaSelectedPackTypeId.set(data.id);
    this.agendaSelectedServiceType.set(data.type);
  }

  protected goToCalendarWithSelectedPack(): void {
    const selectedTypeId = this.agendaSelectedPackTypeId();

    this.showAgendaPackPicker.set(false);
    void this.router.navigate(['/reservas/calendario'], {
      queryParams: {
        tipo: selectedTypeId,
      },
    });
  }

  protected setAgendaRange(range: AgendaRange): void {
    this.agendaRange.set(range);

    if (!this.agendaSelectedDateIso()) {
      this.agendaSelectedDateIso.set(this.getTodayIso());
    }
  }

  protected openAgendaCalendarModal(): void {
    if (!this.requirePermission('agenda_ver', 'Ver agenda')) return;
    if (!this.agendaCalendarMonthIso()) {
      const today = new Date();
      this.agendaCalendarMonthIso.set(
        `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}`,
      );
    }

    this.persistAgendaPreferredView('month');
    this.agendaDayScheduleError.set('');
    this.showAgendaCalendarModal.set(true);
  }

  protected openAgendaWeekScheduleModal(anchorDateIso?: string): void {
    if (!this.requirePermission('agenda_ver', 'Ver agenda')) return;
    const baseDateIso = anchorDateIso || this.agendaSelectedDateIso() || this.getTodayIso();
    this.agendaWeekStartIso.set(this.getWeekStartIso(baseDateIso));
    this.persistAgendaPreferredView('week');
    this.agendaDayScheduleError.set('');
    this.loadAgendaAlerts();
    this.showAgendaWeekScheduleModal.set(true);
  }

  protected closeAgendaWeekScheduleModal(): void {
    this.showAgendaWeekScheduleModal.set(false);
    this.agendaDayScheduleError.set('');
    this.agendaDraggedReservationId.set('');
  }

  protected getAgendaUnassignedReservations(): AdminReservationItem[] {
    return this.getAgendaVisibleReservations()
      .filter(
        (reservation) =>
          this.getReservationWorkerKey(reservation.createdByEmail) === '__sin_asignar__',
      )
      .sort((a, b) => {
        const byDate = a.dateIso.localeCompare(b.dateIso);

        if (byDate !== 0) {
          return byDate;
        }

        return a.startTime.localeCompare(b.startTime);
      });
  }

  protected getAgendaUnassignedReservationsCount(): number {
    return this.getAgendaUnassignedReservations().length;
  }

  protected openAgendaUnassignedReservationsModal(): void {
    if (!this.requirePermission('citas_asignar', 'Asignar citas sin adjudicar')) {
      return;
    }

    this.agendaUnassignedAssignError.set('');
    this.showAgendaUnassignedReservationsModal.set(true);
  }

  protected closeAgendaUnassignedReservationsModal(): void {
    this.showAgendaUnassignedReservationsModal.set(false);
    this.agendaUnassignedAssignReservationId.set('');
    this.agendaUnassignedAssignWorkerEmail.set('');
    this.agendaUnassignedAssignError.set('');
  }

  protected goToPreviousAgendaWeek(): void {
    this.shiftAgendaWeek(-7);
  }

  protected goToNextAgendaWeek(): void {
    this.shiftAgendaWeek(7);
  }

  protected getAgendaWeekRangeLabel(): string {
    const weekStartIso = this.agendaWeekStartIso();

    if (!weekStartIso) {
      return '';
    }

    const weekStart = new Date(`${weekStartIso}T00:00:00`);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const monthName = weekStart.toLocaleDateString('es-ES', {
      month: 'long',
      year: 'numeric',
    });

    return `${weekStart.getDate()} - ${weekEnd.getDate()} ${monthName}`;
  }

  protected getAgendaWeekDays(): AgendaWeekDay[] {
    const weekStartIso = this.agendaWeekStartIso();

    if (!weekStartIso) {
      return [];
    }

    const weekStart = new Date(`${weekStartIso}T00:00:00`);
    const todayIso = this.getTodayIso();
    const reservationsByDate = new Map<string, number>();
    const alertsByDate = new Map<string, { total: number; pending: number }>();

    this.getAgendaCalendarReservations().forEach((reservation) => {
      const current = reservationsByDate.get(reservation.dateIso) ?? 0;
      reservationsByDate.set(reservation.dateIso, current + 1);
    });

    this.agendaAlerts().forEach((alert) => {
      const current = alertsByDate.get(alert.dateIso) ?? { total: 0, pending: 0 };
      current.total += 1;
      if (alert.approvalStatus === 'pending') {
        current.pending += 1;
      }
      alertsByDate.set(alert.dateIso, current);
    });

    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + index);
      const dateIso = this.toDateIso(date);

      return {
        dateIso,
        label: date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric' }),
        shortLabel: date.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' }),
        isToday: dateIso === todayIso,
        reservationCount: reservationsByDate.get(dateIso) ?? 0,
        alertCount: alertsByDate.get(dateIso)?.total ?? 0,
        pendingAlertCount: alertsByDate.get(dateIso)?.pending ?? 0,
        isClosedDay: this.isAgendaRecurringClosedDay(dateIso),
      };
    });
  }

  protected closeAgendaCalendarModal(): void {
    this.showAgendaCalendarModal.set(false);
    this.closeAgendaDayScheduleModal();
  }

  protected closeAgendaDayScheduleModal(): void {
    this.showAgendaDayScheduleModal.set(false);
    this.agendaDayScheduleDateIso.set('');
    this.agendaDayScheduleError.set('');
    this.agendaDraggedReservationId.set('');
    this.agendaDurationDraftByReservationId.set({});
  }

  protected goToPreviousAgendaCalendarMonth(): void {
    this.shiftAgendaCalendarMonth(-1);
  }

  protected goToNextAgendaCalendarMonth(): void {
    this.shiftAgendaCalendarMonth(1);
  }

  protected getAgendaCalendarMonthLabel(): string {
    const monthIso = this.agendaCalendarMonthIso();

    if (!monthIso) {
      return '';
    }

    const date = new Date(`${monthIso}-01T00:00:00`);

    return date.toLocaleDateString('es-ES', {
      month: 'long',
      year: 'numeric',
    });
  }

  protected getAgendaCalendarDays(): AgendaMonthCalendarDay[] {
    const monthIso = this.agendaCalendarMonthIso();

    if (!monthIso) {
      return [];
    }

    const [yearRaw, monthRaw] = monthIso.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);

    if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
      return [];
    }

    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    const firstWeekday = (monthStart.getDay() + 6) % 7;
    const gridStart = new Date(year, month - 1, 1 - firstWeekday);
    const todayIso = this.getTodayIso();
    const reservationsByDate = new Map<string, number>();

    this.getAgendaCalendarReservations().forEach((reservation) => {
      const current = reservationsByDate.get(reservation.dateIso) ?? 0;
      reservationsByDate.set(reservation.dateIso, current + 1);
    });

    const days: AgendaMonthCalendarDay[] = [];

    for (let index = 0; index < 42; index += 1) {
      const dayDate = new Date(gridStart);
      dayDate.setDate(gridStart.getDate() + index);
      const dateIso = this.toDateIso(dayDate);

      days.push({
        dateIso,
        dayNumber: dayDate.getDate(),
        isCurrentMonth: dayDate >= monthStart && dayDate <= monthEnd,
        isToday: dateIso === todayIso,
        reservationCount: reservationsByDate.get(dateIso) ?? 0,
        isClosedDay: this.isAgendaRecurringClosedDay(dateIso),
      });
    }

    return days;
  }

  protected openAgendaDaySchedule(dateIso: string): void {
    this.agendaDayScheduleDateIso.set(dateIso);
    this.showAgendaDayScheduleModal.set(true);
    this.agendaDayScheduleError.set('');
    this.agendaDraggedReservationId.set('');

    const durationDrafts: Record<string, number> = {};

    this.getAgendaDayReservations().forEach((reservation) => {
      durationDrafts[reservation.id] = reservation.durationMinutes;
    });

    this.agendaDurationDraftByReservationId.set(durationDrafts);
  }

  protected getAgendaDayReservations(): AdminReservationItem[] {
    const dateIso = this.agendaDayScheduleDateIso();

    if (!dateIso) {
      return [];
    }

    return this.getAgendaCalendarReservations()
      .filter((reservation) => reservation.dateIso === dateIso)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  protected getAgendaReservationsByStartTime(startTime: string): AdminReservationItem[] {
    return this.getAgendaDayReservations().filter(
      (reservation) => reservation.startTime === startTime,
    );
  }

  protected getAgendaReservationsByDateAndStartTime(
    dateIso: string,
    startTime: string,
  ): AdminReservationItem[] {
    return this.getAgendaCalendarReservations()
      .filter(
        (reservation) => reservation.dateIso === dateIso && reservation.startTime === startTime,
      )
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  private getAgendaVisibleReservations(): AdminReservationItem[] {
    return this.reservations().filter((reservation) => reservation.adminStatus !== 'rejected');
  }

  private getAgendaCalendarReservations(): AdminReservationItem[] {
    return this.getAgendaVisibleReservations().filter(
      (reservation) =>
        this.getReservationWorkerKey(reservation.createdByEmail) !== '__sin_asignar__',
    );
  }

  private getReservationListVisibleReservations(): AdminReservationItem[] {
    return this.reservations().filter((reservation) => reservation.adminStatus !== 'rejected');
  }

  protected getAgendaAlertsByDateAndStartTime(
    dateIso: string,
    startTime: string,
  ): AgendaAlertItem[] {
    return this.agendaAlerts()
      .filter(
        (alert) =>
          alert.dateIso === dateIso && alert.startTime === startTime && alert.status === 'active',
      )
      .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  }

  protected hasAgendaAlerts(dateIso: string, startTime: string): boolean {
    return this.getAgendaAlertsByDateAndStartTime(dateIso, startTime).length > 0;
  }

  protected getAgendaAlertBadgeLabel(dateIso: string): string {
    const dayAlerts = this.agendaAlerts().filter(
      (alert) => alert.dateIso === dateIso && alert.status === 'active',
    );
    const pendingCount = dayAlerts.filter((alert) => alert.approvalStatus === 'pending').length;

    if (dayAlerts.length === 0) {
      return '';
    }

    if (pendingCount === dayAlerts.length) {
      return `Avísame · ${pendingCount}`;
    }

    return `Avísame · ${dayAlerts.length}`;
  }

  protected approveAgendaAlert(alertId: string): void {
    if (!alertId) {
      return;
    }

    this.agendaAlertActionLoadingId.set(alertId);
    this.agendaAlertsError.set('');

    this.http
      .patch<{
        ok: boolean;
        error?: string;
      }>(`/api/admin/alertas/${encodeURIComponent(alertId)}/aprobar`, {})
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.agendaAlertsError.set(response.error ?? 'No se pudo aprobar la alerta.');
            return;
          }

          this.loadAgendaAlerts();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.agendaAlertsError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo aprobar la alerta.',
          );
        },
        complete: () => {
          this.agendaAlertActionLoadingId.set('');
        },
      });
  }

  protected rejectAgendaAlert(alertId: string): void {
    if (!alertId) {
      return;
    }

    this.agendaAlertActionLoadingId.set(alertId);
    this.agendaAlertsError.set('');

    this.http
      .patch<{
        ok: boolean;
        error?: string;
      }>(`/api/admin/alertas/${encodeURIComponent(alertId)}/rechazar`, {})
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.agendaAlertsError.set(response.error ?? 'No se pudo rechazar la alerta.');
            return;
          }

          this.loadAgendaAlerts();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.agendaAlertsError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo rechazar la alerta.',
          );
        },
        complete: () => {
          this.agendaAlertActionLoadingId.set('');
        },
      });
  }

  protected getAgendaDurationDraft(reservationId: string, fallbackDuration: number): number {
    return this.agendaDurationDraftByReservationId()[reservationId] ?? fallbackDuration;
  }

  protected onAgendaDurationDraftChange(reservationId: string, event: Event): void {
    const target = event.target as HTMLSelectElement;
    const nextDuration = Number(target.value);

    if (!Number.isFinite(nextDuration) || nextDuration < 30 || nextDuration % 30 !== 0) {
      return;
    }

    this.agendaDurationDraftByReservationId.update((drafts) => ({
      ...drafts,
      [reservationId]: nextDuration,
    }));
  }

  protected saveAgendaReservationDuration(reservation: AdminReservationItem): void {
    if (!this.isSuperadmin()) {
      this.showAgendaDropToast('⚠️ Solo el superadmin puede ajustar la duráción de una cita.');
      return;
    }

    const nextDuration = this.getAgendaDurationDraft(reservation.id, reservation.durationMinutes);

    if (!Number.isFinite(nextDuration) || nextDuration < 30 || nextDuration % 30 !== 0) {
      this.showAgendaDropToast('⚠️ La duración debe ser en bloques de 30 minutos.');
      return;
    }

    if (nextDuration === reservation.durationMinutes) {
      return;
    }

    if (
      !this.isSuperadmin() &&
      this.hasReservationConflict(
        reservation.dateIso,
        reservation.startTime,
        nextDuration,
        reservation.id,
        reservation.createdByEmail,
      )
    ) {
      this.showAgendaDropToast('⚠️ Ese ajuste solapa con otra cita existente.');
      return;
    }

    this.updateReservationSchedule(
      reservation,
      reservation.dateIso,
      reservation.startTime,
      nextDuration,
    );
  }

  protected onAgendaReservationDragStart(event: DragEvent, reservationId: string): void {
    if (!reservationId) {
      return;
    }

    this.agendaDraggedReservationId.set(reservationId);

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', reservationId);
    }
  }

  protected onAgendaReservationDragEnd(): void {
    this.agendaDraggedReservationId.set('');
  }

  protected allowAgendaReservationDrop(event: DragEvent): void {
    event.preventDefault();

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  protected onAgendaReservationDrop(event: DragEvent, targetStartTime: string): void {
    event.preventDefault();

    const draggedReservationId =
      event.dataTransfer?.getData('text/plain') || this.agendaDraggedReservationId();

    if (!draggedReservationId) {
      return;
    }

    const reservation = this.getAgendaDayReservations().find(
      (item) => item.id === draggedReservationId,
    );

    if (!reservation) {
      this.agendaDraggedReservationId.set('');
      return;
    }

    if (reservation.startTime === targetStartTime) {
      this.agendaDraggedReservationId.set('');
      return;
    }

    if (
      !this.isSuperadmin() &&
      this.hasReservationConflict(
        reservation.dateIso,
        targetStartTime,
        reservation.durationMinutes,
        reservation.id,
        reservation.createdByEmail,
      )
    ) {
      this.showAgendaDropToast(
        `⚠️ Ese horario ya está ocupado. La cita "${reservation.appointmentTypeName}" dura ${this.formatDuration(reservation.durationMinutes)} y solapa con otra existente.`,
      );
      this.agendaDraggedReservationId.set('');
      return;
    }

    this.updateReservationSchedule(
      reservation,
      reservation.dateIso,
      targetStartTime,
      reservation.durationMinutes,
    );
  }

  protected onAgendaReservationDropToDateTime(
    event: DragEvent,
    targetDateIso: string,
    targetStartTime: string,
  ): void {
    event.preventDefault();

    const draggedReservationId =
      event.dataTransfer?.getData('text/plain') || this.agendaDraggedReservationId();

    if (!draggedReservationId) {
      return;
    }

    const reservation = this.reservations().find((item) => item.id === draggedReservationId);

    if (!reservation) {
      this.agendaDraggedReservationId.set('');
      return;
    }

    if (reservation.dateIso === targetDateIso && reservation.startTime === targetStartTime) {
      this.agendaDraggedReservationId.set('');
      return;
    }

    if (
      !this.isSuperadmin() &&
      this.hasReservationConflict(
        targetDateIso,
        targetStartTime,
        reservation.durationMinutes,
        reservation.id,
        reservation.createdByEmail,
      )
    ) {
      this.showAgendaDropToast(
        `⚠️ Ese horario ya está ocupado. La cita "${reservation.appointmentTypeName}" dura ${this.formatDuration(reservation.durationMinutes)} y solapa con otra existente.`,
      );
      this.agendaDraggedReservationId.set('');
      return;
    }

    this.updateReservationSchedule(
      reservation,
      targetDateIso,
      targetStartTime,
      reservation.durationMinutes,
    );
  }

  protected getAppointmentTypeColor(appointmentTypeName: string): string {
    const typeName = appointmentTypeName.trim().toLocaleLowerCase('es');

    if (!typeName) {
      return this.clientTreatmentPalette[0];
    }

    const index = this.agendaPackOptions.findIndex(
      (option) => option.nombre.trim().toLocaleLowerCase('es') === typeName,
    );

    if (index < 0) {
      return this.clientTreatmentPalette[0];
    }

    return this.clientTreatmentPalette[index % this.clientTreatmentPalette.length];
  }

  protected onAgendaSelectedDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.agendaSelectedDateIso.set(target.value);
  }

  protected onHelpSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.helpSearch.set(target.value);
  }

  protected clearHelpSearch(): void {
    this.helpSearch.set('');
  }

  protected matchesHelpQuery(keywords: string): boolean {
    const query = this.normalizeSearchText(this.helpSearch());

    if (!query) {
      return true;
    }

    return this.normalizeSearchText(keywords).includes(query);
  }

  protected setReservationListRangeTab(tab: ReservationListRangeTab): void {
    this.reservationListRangeTab.set(tab);

    if (!this.agendaSelectedDateIso()) {
      this.agendaSelectedDateIso.set(this.getTodayIso());
    }
  }

  protected getAgendaTotalReservationsInRange(): number {
    return this.getAgendaReservationsInRange().length;
  }

  protected getAgendaSelectedDateReservations(): AdminReservationItem[] {
    const selectedDateIso = this.agendaSelectedDateIso();

    if (!selectedDateIso) {
      return [];
    }

    return this.reservations().filter((reservation) => reservation.dateIso === selectedDateIso);
  }

  protected getAgendaRangeLabel(): string {
    const range = this.agendaRange();

    if (range === 'hoy') {
      return 'Hoy';
    }

    if (range === 'semana') {
      return 'Semana';
    }

    return 'Mes';
  }

  protected setStockManagementTab(tab: StockManagementTab): void {
    this.stockManagementTab.set(tab);
    this.stockSaleError.set('');

    if (tab === 'ver' || tab === 'vender' || tab === 'historial') {
      this.loadStockProducts();

      if (tab === 'vender' && !this.stockSaleProductId()) {
        const firstSellable = this.getAvailableSellableStockProducts()[0];
        this.stockSaleProductId.set(firstSellable?.id ?? '');
      }

      if (tab === 'historial') {
        this.loadStockSalesHistory();
      }
    }
  }

  protected onStockCreateNameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockCreateName.set(target.value);
  }

  protected onStockCreateBrandInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockCreateBrand.set(target.value);
  }

  protected onStockCreateQuantityInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockCreateQuantity.set(target.value);
  }

  protected onStockCreatePriceInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockCreatePrice.set(target.value);
  }

  protected onStockCreateColorInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockCreateColor.set(target.value);
  }

  protected onStockCreateIsSellableInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockCreateIsSellable.set(target.checked);
  }

  protected onStockFilterNameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockFilterName.set(target.value);
  }

  protected onStockFilterBrandInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockFilterBrand.set(target.value);
  }

  protected onStockFilterColorInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockFilterColor.set(target.value);
  }

  protected onStockFilterMinQuantityInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockFilterMinQuantity.set(target.value);
  }

  protected onStockFilterMaxPriceInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockFilterMaxPrice.set(target.value);
  }

  protected clearStockFilters(): void {
    this.stockFilterName.set('');
    this.stockFilterBrand.set('');
    this.stockFilterColor.set('');
    this.stockFilterMinQuantity.set('');
    this.stockFilterMaxPrice.set('');
  }

  protected getFilteredStockProducts(): StockProductItem[] {
    const nameFilter = this.stockFilterName().trim().toLowerCase();
    const brandFilter = this.stockFilterBrand().trim().toLowerCase();
    const colorFilter = this.stockFilterColor().trim().toLowerCase();
    const minQuantity = Number(this.stockFilterMinQuantity());
    const maxPrice = Number(this.stockFilterMaxPrice());

    return this.stockProducts().filter((product) => {
      if (nameFilter && !product.productName.toLowerCase().includes(nameFilter)) {
        return false;
      }

      if (brandFilter && !product.brand.toLowerCase().includes(brandFilter)) {
        return false;
      }

      if (colorFilter && !product.color.toLowerCase().includes(colorFilter)) {
        return false;
      }

      if (!Number.isNaN(minQuantity) && this.stockFilterMinQuantity().trim() !== '') {
        if (product.quantity < minQuantity) {
          return false;
        }
      }

      if (!Number.isNaN(maxPrice) && this.stockFilterMaxPrice().trim() !== '') {
        if (product.price > maxPrice) {
          return false;
        }
      }

      return true;
    });
  }

  protected getSellableStockProducts(): StockProductItem[] {
    return this.stockProducts()
      .filter((product) => product.isSellable)
      .sort((a, b) => a.productName.localeCompare(b.productName));
  }

  protected getAvailableSellableStockProducts(): StockProductItem[] {
    return this.getSellableStockProducts().filter((product) => product.quantity > 0);
  }

  protected selectStockSaleProduct(productId: string): void {
    if (!productId) {
      return;
    }

    this.stockSaleProductId.set(productId);
    this.stockSaleUnits.set('1');
    this.stockSalePaymentMethod.set('');
    this.stockSaleError.set('');
  }

  protected openStockSaleModal(productId: string): void {
    this.selectStockSaleProduct(productId);
    this.showStockSaleModal.set(true);
  }

  protected closeStockSaleModal(): void {
    if (this.stockSaleLoading()) {
      return;
    }

    this.showStockSaleModal.set(false);
    this.stockSaleUnits.set('1');
    this.stockSalePaymentMethod.set('');
    this.stockSaleError.set('');
  }

  protected getSelectedStockSaleProduct(): StockProductItem | null {
    const productId = this.stockSaleProductId();

    if (!productId) {
      return null;
    }

    return this.stockProducts().find((product) => product.id === productId) ?? null;
  }

  protected getSelectedStockSaleDescription(product: StockProductItem): string {
    const brand = product.brand.trim();
    const color = product.color.trim();

    if (brand && color) {
      return `${brand} · ${color}`;
    }

    if (brand) {
      return brand;
    }

    if (color) {
      return color;
    }

    return 'Sin descripcion adicional.';
  }

  protected onStockSaleUnitsInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockSaleUnits.set(target.value);
  }

  protected setStockSalePaymentMethod(method: 'efectivo' | 'tarjeta' | 'bizum'): void {
    this.stockSalePaymentMethod.set(method);
    this.stockSaleError.set('');
  }

  protected getStockSaleUnitsValue(): number {
    const units = Number(this.stockSaleUnits().trim());
    return Number.isInteger(units) ? units : 0;
  }

  protected getStockSaleTotalAmount(): number {
    const product = this.getSelectedStockSaleProduct();

    if (!product) {
      return 0;
    }

    const units = this.getStockSaleUnitsValue();

    if (units <= 0) {
      return 0;
    }

    return Number((product.price * units).toFixed(2));
  }

  protected submitStockSale(): void {
    const product = this.getSelectedStockSaleProduct();
    const units = this.getStockSaleUnitsValue();
    const paymentMethod = this.stockSalePaymentMethod();

    this.stockSaleError.set('');
    this.stockError.set('');
    this.stockMessage.set('');

    if (!product) {
      this.stockSaleError.set('Selecciona un producto para vender.');
      return;
    }

    if (!paymentMethod) {
      this.stockSaleError.set('Selecciona un metodo de pago.');
      return;
    }

    if (!Number.isInteger(units) || units <= 0) {
      this.stockSaleError.set('Las unidades deben ser un entero mayor que 0.');
      return;
    }

    if (units > product.quantity) {
      this.stockSaleError.set('No hay suficiente stock para esa venta.');
      return;
    }

    this.stockSaleLoading.set(true);

    this.http
      .post<{
        ok: boolean;
        product?: StockProductItem;
        soldUnits?: number;
        totalAmount?: number;
        paymentMethod?: 'efectivo' | 'tarjeta' | 'bizum';
        error?: string;
      }>(`/api/admin/almacen/${encodeURIComponent(product.id)}/sell`, {
        units,
        paymentMethod,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.stockSaleError.set(response.error ?? 'No se pudo registrar la venta.');
            return;
          }

          if (response.product) {
            this.stockProducts.update((products) =>
              products.map((item) => (item.id === response.product?.id ? response.product : item)),
            );
          }

          const soldUnits = response.soldUnits ?? units;
          const totalAmount = Number(response.totalAmount ?? this.getStockSaleTotalAmount());
          this.stockMessage.set(
            `Venta registrada: ${soldUnits} ud de ${product.productName} por ${totalAmount.toFixed(2)} EUR (${paymentMethod}).`,
          );
          this.stockSaleUnits.set('1');
          this.stockSalePaymentMethod.set('');
          this.showStockSaleModal.set(false);
          this.loadStockSalesHistory();
          this.loadCierreAutoDiario();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.stockSaleError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo registrar la venta.',
          );
        },
        complete: () => {
          this.stockSaleLoading.set(false);
        },
      });
  }

  protected createStockProduct(): void {
    const productName = this.stockCreateName().trim();
    const brand = this.stockCreateBrand().trim();
    const quantity = Number(this.stockCreateQuantity());
    const priceRaw = this.stockCreatePrice().trim().replace(',', '.');
    const price = priceRaw === '' ? 0 : Number(priceRaw);
    const color = this.stockCreateColor().trim();
    const isSellable = this.stockCreateIsSellable();

    this.stockError.set('');
    this.stockMessage.set('');

    if (!productName || !brand) {
      this.stockError.set('Nombre y marca son obligatorios.');
      return;
    }

    if (Number.isNaN(quantity) || quantity < 0) {
      this.stockError.set('La cantidad debe ser un número válido igual o mayor que 0.');
      return;
    }

    if (Number.isNaN(price) || price < 0) {
      this.stockError.set('El precio debe ser un número válido igual o mayor que 0.');
      return;
    }

    this.stockCreateLoading.set(true);

    this.http
      .post<{ ok: boolean; product?: StockProductItem; error?: string }>('/api/admin/almacen', {
        productName,
        brand,
        quantity,
        price,
        color,
        isSellable,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.stockError.set(response.error ?? 'No se pudo añadir el producto.');
            return;
          }

          this.stockMessage.set('Producto añadido correctamente.');
          this.stockCreateName.set('');
          this.stockCreateBrand.set('');
          this.stockCreateQuantity.set('');
          this.stockCreatePrice.set('');
          this.stockCreateColor.set('');
          this.stockCreateIsSellable.set(false);
          this.loadStockProducts();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.stockError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo añadir el producto.',
          );
        },
        complete: () => {
          this.stockCreateLoading.set(false);
        },
      });
  }

  protected adjustStockQuantity(productId: string, delta: number): void {
    if (this.stockAdjustingProductId()) return;
    this.stockAdjustError.set('');
    this.stockAdjustingProductId.set(productId);

    this.http
      .patch<{
        ok: boolean;
        product?: StockProductItem;
        error?: string;
      }>(`/api/admin/almacen/${productId}/quantity`, { delta })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.stockAdjustError.set(response.error ?? 'No se pudo actualizar el stock.');
            return;
          }
          if (response.product) {
            this.stockProducts.update((products) =>
              products.map((p) =>
                p.id === productId ? (response.product as StockProductItem) : p,
              ),
            );
          }
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.stockAdjustError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo actualizar el stock.',
          );
        },
        complete: () => {
          this.stockAdjustingProductId.set('');
        },
      });
  }

  protected deleteStockProduct(productId: string): void {
    if (!productId || this.stockDeletingProductId()) {
      return;
    }

    this.stockError.set('');
    this.stockMessage.set('');
    this.stockAdjustError.set('');
    this.stockDeletingProductId.set(productId);

    this.http
      .delete<{
        ok: boolean;
        error?: string;
      }>(`/api/admin/almacen/${encodeURIComponent(productId)}`)
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.stockError.set(response.error ?? 'No se pudo eliminar el producto.');
            return;
          }

          this.stockProducts.update((products) => products.filter((p) => p.id !== productId));
          this.stockMessage.set('Producto eliminado correctamente.');
          this.showDeleteStockConfirmModal.set(false);
          this.deleteStockTargetProductId.set('');
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.stockError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo eliminar el producto.',
          );
        },
        complete: () => {
          this.stockDeletingProductId.set('');
        },
      });
  }

  protected openEditStockModal(product: StockProductItem): void {
    if (!product || this.editStockLoading()) {
      return;
    }

    this.stockError.set('');
    this.stockMessage.set('');
    this.stockAdjustError.set('');
    this.editStockTargetProductId.set(product.id);
    this.editStockName.set(product.productName);
    this.editStockPrice.set(`${product.price}`);
    this.editStockIsSellable.set(product.isSellable);
    this.showEditStockModal.set(true);
  }

  protected closeEditStockModal(): void {
    if (this.editStockLoading()) {
      return;
    }

    this.showEditStockModal.set(false);
    this.editStockTargetProductId.set('');
    this.editStockName.set('');
    this.editStockPrice.set('');
    this.editStockIsSellable.set(false);
  }

  protected onEditStockNameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.editStockName.set(target.value);
  }

  protected onEditStockPriceInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.editStockPrice.set(target.value);
  }

  protected onEditStockIsSellableInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.editStockIsSellable.set(target.checked);
  }

  protected saveStockProductEdit(): void {
    const productId = this.editStockTargetProductId().trim();
    const productName = this.editStockName().trim();
    const priceRaw = this.editStockPrice().trim().replace(',', '.');
    const price = priceRaw === '' ? 0 : Number(priceRaw);
    const isSellable = this.editStockIsSellable();

    this.stockError.set('');
    this.stockMessage.set('');
    this.stockAdjustError.set('');

    if (!productId) {
      this.stockError.set('Producto inválido para editar.');
      return;
    }

    if (!productName) {
      this.stockError.set('El titulo del producto es obligatorio.');
      return;
    }

    if (!Number.isFinite(price) || price < 0) {
      this.stockError.set('El precio debe ser un número válido igual o mayor que 0.');
      return;
    }

    this.editStockLoading.set(true);

    this.http
      .patch<{ ok: boolean; product?: StockProductItem; error?: string }>(
        `/api/admin/almacen/${encodeURIComponent(productId)}`,
        {
          productName,
          price,
          isSellable,
        },
      )
      .subscribe({
        next: (response) => {
          if (!response.ok || !response.product) {
            this.stockError.set(response.error ?? 'No se pudo guardar la edición del producto.');
            this.editStockLoading.set(false);
            return;
          }

          this.stockProducts.update((products) =>
            products.map((product) =>
              product.id === response.product?.id ? response.product : product,
            ),
          );
          this.stockMessage.set('Producto actualizado correctamente.');
          this.editStockLoading.set(false);
          this.closeEditStockModal();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.stockError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo guardar la edición del producto.',
          );
          this.editStockLoading.set(false);
        },
      });
  }

  protected openDeleteStockConfirmModal(productId: string): void {
    if (!productId || this.stockDeletingProductId()) {
      return;
    }

    this.stockError.set('');
    this.stockMessage.set('');
    this.deleteStockTargetProductId.set(productId);
    this.showDeleteStockConfirmModal.set(true);
  }

  protected closeDeleteStockConfirmModal(): void {
    if (this.stockDeletingProductId()) {
      return;
    }

    this.showDeleteStockConfirmModal.set(false);
    this.deleteStockTargetProductId.set('');
  }

  protected confirmDeleteStockProduct(): void {
    const productId = this.deleteStockTargetProductId();

    if (!productId) {
      this.showDeleteStockConfirmModal.set(false);
      return;
    }

    this.deleteStockProduct(productId);
  }

  protected getDeleteStockTargetProductLabel(): string {
    const productId = this.deleteStockTargetProductId();

    if (!productId) {
      return 'este producto';
    }

    const product = this.stockProducts().find((item) => item.id === productId);

    if (!product) {
      return 'este producto';
    }

    const brand = product.brand.trim();
    return brand ? `${product.productName} (${brand})` : product.productName;
  }

  protected onStockSalesHistoryDateFilterInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.stockSalesHistoryDateFilter.set(target.value.trim());
  }

  protected onStockSalesHistoryMethodFilterChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const next = target.value;
    this.stockSalesHistoryMethodFilter.set(
      next === 'efectivo' || next === 'tarjeta' || next === 'bizum' ? next : 'all',
    );
  }

  protected clearStockSalesHistoryFilters(): void {
    this.stockSalesHistoryDateFilter.set('');
    this.stockSalesHistoryMethodFilter.set('all');
  }

  protected getFilteredStockSalesHistory(): StockSaleHistoryItem[] {
    const dateFilter = this.stockSalesHistoryDateFilter();
    const methodFilter = this.stockSalesHistoryMethodFilter();

    return this.stockSalesHistory().filter((sale) => {
      if (dateFilter && !sale.soldAtIso.startsWith(dateFilter)) {
        return false;
      }

      if (methodFilter !== 'all' && sale.paymentMethod !== methodFilter) {
        return false;
      }

      return true;
    });
  }

  private loadStockSalesHistory(): void {
    this.stockSalesHistoryLoading.set(true);

    this.http
      .get<{
        ok: boolean;
        sales?: StockSaleHistoryItem[];
        error?: string;
      }>('/api/admin/almacen/sales')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.stockSaleError.set(response.error ?? 'No se pudo cargar el historial de ventas.');
            return;
          }

          this.stockSalesHistory.set(response.sales ?? []);
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.stockSaleError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo cargar el historial de ventas.',
          );
        },
        complete: () => {
          this.stockSalesHistoryLoading.set(false);
        },
      });
  }

  private getAgendaReservationsInRange(): AdminReservationItem[] {
    const range = this.agendaRange();
    const selectedDateIso = this.agendaSelectedDateIso() || this.getTodayIso();

    if (range === 'hoy') {
      return this.reservations().filter(
        (reservation) => reservation.dateIso === this.getTodayIso(),
      );
    }

    if (range === 'semana') {
      const selectedDate = new Date(`${selectedDateIso}T00:00:00`);
      const weekDay = selectedDate.getDay();
      const diffToMonday = weekDay === 0 ? -6 : 1 - weekDay;
      const weekStart = new Date(selectedDate);
      weekStart.setDate(selectedDate.getDate() + diffToMonday);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      const startIso = this.toDateIso(weekStart);
      const endIso = this.toDateIso(weekEnd);

      return this.reservations().filter(
        (reservation) => reservation.dateIso >= startIso && reservation.dateIso <= endIso,
      );
    }

    const [yearRaw, monthRaw] = selectedDateIso.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);

    if (Number.isNaN(year) || Number.isNaN(month)) {
      return [];
    }

    const monthStartIso = `${year}-${`${month}`.padStart(2, '0')}-01`;
    const monthEndIso = this.toDateIso(new Date(year, month, 0));

    return this.reservations().filter(
      (reservation) => reservation.dateIso >= monthStartIso && reservation.dateIso <= monthEndIso,
    );
  }

  protected clearReservationFilters(): void {
    this.reservationFilterName.set('');
    this.reservationFilterDate.set('');
    this.reservationFilterPack.set('');
  }

  protected setClientManagementTab(tab: ClientManagementTab): void {
    this.clientManagementTab.set(tab);

    if (tab === 'buscar') {
      this.clientCardsSearch.set('');
    }
  }

  protected openClientDetailModal(clientId: string): void {
    const card = this.clientCards().find((item) => item.id === clientId) ?? null;

    if (!card) {
      this.clientCardsError.set('No se pudo abrir la ficha seleccionada.');
      return;
    }

    this.selectedClientId.set(clientId);
    this.clientEditFullName.set(card.fullName);
    this.clientEditEmail.set(card.email);
    this.clientEditPhone.set(card.phone);
    this.clientEditBirthDateIso.set(card.birthDateIso ?? '');
    this.clientEditNotes.set(card.notes ?? '');
    this.showClientDetailModal.set(true);
    this.showDeleteClientConfirmModal.set(false);
    this.clientDeleteLoading.set(false);
    this.clientTreatmentName.set('');
    this.clientTreatmentNote.set('');
    this.clientChartType.set('pie');
  }

  protected openClientStatsModal(): void {
    this.showClientStatsModal.set(true);
    this.clientChartType.set('pie');
  }

  protected closeClientDetailModal(): void {
    this.showClientDetailModal.set(false);
    this.showDeleteClientConfirmModal.set(false);
    this.selectedClientId.set('');
    this.clientEditFullName.set('');
    this.clientEditEmail.set('');
    this.clientEditPhone.set('');
    this.clientEditBirthDateIso.set('');
    this.clientEditNotes.set('');
    this.clientEditLoading.set(false);
    this.clientDeleteLoading.set(false);
    this.clientTreatmentName.set('');
    this.clientTreatmentNote.set('');
    this.clientChartType.set('pie');
  }

  protected closeClientStatsModal(): void {
    this.showClientStatsModal.set(false);
    this.clientChartType.set('pie');
  }

  protected onGlobalTreatmentFilterPresetChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const value = target.value;

    if (
      value !== 'all' &&
      value !== 'month' &&
      value !== 'last30' &&
      value !== 'year' &&
      value !== 'custom'
    ) {
      this.applyGlobalTreatmentFilterPreset('all');
      return;
    }

    this.applyGlobalTreatmentFilterPreset(value);
  }

  protected onGlobalTreatmentStartDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const nextValue = target.value;
    this.globalTreatmentStartDateIso.set(nextValue);
    this.globalTreatmentFilterPreset.set('custom');

    if (
      nextValue &&
      this.globalTreatmentEndDateIso() &&
      nextValue > this.globalTreatmentEndDateIso()
    ) {
      this.globalTreatmentEndDateIso.set(nextValue);
    }

    this.persistGlobalTreatmentPreferences();
  }

  protected onGlobalTreatmentEndDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const nextValue = target.value;
    this.globalTreatmentEndDateIso.set(nextValue);
    this.globalTreatmentFilterPreset.set('custom');

    if (
      nextValue &&
      this.globalTreatmentStartDateIso() &&
      nextValue < this.globalTreatmentStartDateIso()
    ) {
      this.globalTreatmentStartDateIso.set(nextValue);
    }

    this.persistGlobalTreatmentPreferences();
  }

  protected onGlobalTreatmentTimelineGroupingChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const value = target.value;

    if (value === 'auto' || value === 'month' || value === 'week' || value === 'day') {
      this.globalTreatmentTimelineGrouping.set(value);
      this.persistGlobalTreatmentPreferences();
      return;
    }

    this.globalTreatmentTimelineGrouping.set('auto');
    this.persistGlobalTreatmentPreferences();
  }

  protected onGlobalTreatmentEmployeeFilterChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.globalTreatmentEmployeeFilterEmail.set(target.value || 'all');
    this.persistGlobalTreatmentPreferences();
  }

  protected applyGlobalTreatmentEmployeeFilter(email: string): void {
    if (!this.canApplyGlobalTreatmentEmployeeFilter(email)) {
      return;
    }

    this.globalTreatmentEmployeeFilterEmail.set(email);
    this.persistGlobalTreatmentPreferences();
  }

  protected canApplyGlobalTreatmentEmployeeFilter(email: string): boolean {
    return !!email && email !== 'all' && email !== 'others' && email !== 'unknown';
  }

  protected isGlobalTreatmentEmployeeFilterSelected(email: string): boolean {
    return this.globalTreatmentEmployeeFilterEmail() === email;
  }

  protected hasGlobalTreatmentEmployeeFilterSelected(): boolean {
    return this.globalTreatmentEmployeeFilterEmail() !== 'all';
  }

  protected clearGlobalTreatmentEmployeeFilter(): void {
    this.globalTreatmentEmployeeFilterEmail.set('all');
    this.persistGlobalTreatmentPreferences();
  }

  protected applyGlobalTreatmentNameFilter(name: string): void {
    if (!this.canApplyGlobalTreatmentNameFilter(name)) {
      return;
    }

    const currentNames = this.globalTreatmentNameFilters();

    if (currentNames.includes(name)) {
      this.globalTreatmentNameFilters.set(
        currentNames.filter((currentName) => currentName !== name),
      );
      this.persistGlobalTreatmentPreferences();
      return;
    }

    this.globalTreatmentNameFilters.set([...currentNames, name]);
    this.persistGlobalTreatmentPreferences();
  }

  protected clearGlobalTreatmentNameFilter(): void {
    this.globalTreatmentNameFilters.set([]);
    this.persistGlobalTreatmentPreferences();
  }

  protected canApplyGlobalTreatmentNameFilter(name: string): boolean {
    return !!name && name !== 'all' && name !== 'Otros';
  }

  protected hasGlobalTreatmentNameFilterSelected(): boolean {
    return this.globalTreatmentNameFilters().length > 0;
  }

  protected isGlobalTreatmentNameFilterSelected(name: string): boolean {
    return this.globalTreatmentNameFilters().includes(name);
  }

  protected clearGlobalTreatmentDateRange(): void {
    this.applyGlobalTreatmentFilterPreset('all');
    this.globalTreatmentEmployeeFilterEmail.set('all');
    this.globalTreatmentNameFilters.set([]);
    this.persistGlobalTreatmentPreferences();
  }

  protected resetGlobalTreatmentPreferencesToDefaults(): void {
    this.applyGlobalTreatmentPreferences(this.getDefaultGlobalTreatmentPreferences());
    this.persistGlobalTreatmentPreferences();
  }

  protected onGlobalTreatmentSavedViewNameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.globalTreatmentSavedViewName.set(target.value);
  }

  protected canSaveGlobalTreatmentView(): boolean {
    return this.globalTreatmentSavedViewName().trim().length >= 3;
  }

  protected saveCurrentGlobalTreatmentView(): void {
    const trimmedName = this.globalTreatmentSavedViewName().trim();

    if (trimmedName.length < 3) {
      return;
    }

    const nowIso = new Date().toISOString();
    const normalizedName = trimmedName.toLocaleLowerCase('es');
    const nextView: GlobalTreatmentSavedView = {
      id: this.buildGlobalTreatmentSavedViewId(trimmedName),
      name: trimmedName,
      updatedAtIso: nowIso,
      preferences: this.getCurrentGlobalTreatmentPreferences(),
    };

    const existingViews = this.globalTreatmentSavedViews();
    const existingIndex = existingViews.findIndex(
      (view) => view.name.trim().toLocaleLowerCase('es') === normalizedName,
    );

    const nextViews = [...existingViews];

    if (existingIndex >= 0) {
      nextViews.splice(existingIndex, 1, {
        ...nextViews[existingIndex],
        name: trimmedName,
        updatedAtIso: nowIso,
        preferences: nextView.preferences,
      });
    } else {
      nextViews.unshift(nextView);
    }

    this.globalTreatmentSavedViews.set(
      [...nextViews].sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso)).slice(0, 8),
    );
    this.globalTreatmentSavedViewName.set('');
    this.persistGlobalTreatmentSavedViews();
  }

  protected applyGlobalTreatmentSavedView(savedViewId: string): void {
    const savedView = this.globalTreatmentSavedViews().find((view) => view.id === savedViewId);

    if (!savedView) {
      return;
    }

    this.applyGlobalTreatmentPreferences(savedView.preferences);
    this.persistGlobalTreatmentPreferences();
  }

  protected deleteGlobalTreatmentSavedView(savedViewId: string): void {
    const nextViews = this.globalTreatmentSavedViews().filter((view) => view.id !== savedViewId);

    if (nextViews.length === this.globalTreatmentSavedViews().length) {
      return;
    }

    this.globalTreatmentSavedViews.set(nextViews);
    this.persistGlobalTreatmentSavedViews();
  }

  protected isGlobalTreatmentSavedViewActive(savedViewId: string): boolean {
    const savedView = this.globalTreatmentSavedViews().find((view) => view.id === savedViewId);

    if (!savedView) {
      return false;
    }

    return this.areGlobalTreatmentPreferencesEqual(
      savedView.preferences,
      this.getCurrentGlobalTreatmentPreferences(),
    );
  }

  protected getGlobalTreatmentSavedViews(): GlobalTreatmentSavedView[] {
    return this.globalTreatmentSavedViews();
  }

  protected getSelectedClientCard(): ClientCardItem | null {
    const id = this.selectedClientId();

    if (!id) {
      return null;
    }

    return this.clientCards().find((card) => card.id === id) ?? null;
  }

  protected setEmployeeManagementTab(tab: EmployeeManagementTab): void {
    this.employeeManagementTab.set(tab);

    if (tab === 'buscar') {
      this.employeeSearch.set('');
      this.employeeRoleFilter.set('all');
    }
  }

  protected openEmployeeDetailModal(email: string): void {
    this.selectedEmployeeEmail.set(email);
    this.employeeDetailTab.set('movimientos');
    this.showEmployeeDetailModal.set(true);
  }

  protected closeEmployeeDetailModal(): void {
    this.showEmployeeDetailModal.set(false);
    this.employeeDetailTab.set('movimientos');
    this.closeEmployeeTrackingCalendarModal();
  }

  protected setEmployeeDetailTab(tab: 'acciones' | 'movimientos'): void {
    this.employeeDetailTab.set(tab);
  }

  protected isEmployeeDetailTab(tab: 'acciones' | 'movimientos'): boolean {
    return this.employeeDetailTab() === tab;
  }

  protected openEmployeeTrackingCalendarModal(
    email: string,
    action: EmployeeTrackingCalendarAction,
  ): void {
    const todayIso = this.getTodayIso();
    this.employeeTrackingCalendarEmail.set(email);
    this.employeeTrackingCalendarAction.set(action);
    this.employeeTrackingCalendarStartDateIso.set(todayIso);
    this.employeeTrackingCalendarEndDateIso.set(action === 'sick_leave' ? '' : todayIso);
    this.showEmployeeTrackingCalendarModal.set(true);
  }

  protected closeEmployeeTrackingCalendarModal(): void {
    this.showEmployeeTrackingCalendarModal.set(false);
    this.employeeTrackingCalendarEmail.set('');
    this.employeeTrackingCalendarAction.set('vacation');
    this.employeeTrackingCalendarStartDateIso.set('');
    this.employeeTrackingCalendarEndDateIso.set('');
  }

  protected getEmployeeTrackingCalendarTitle(): string {
    const action = this.employeeTrackingCalendarAction();

    if (action === 'vacation') {
      return 'Registrar vacaciones';
    }

    if (action === 'sick_leave') {
      return 'Registrar baja';
    }

    return 'Registrar recuperación de horas';
  }

  protected getEmployeeTrackingCalendarEndLabel(): string {
    return this.employeeTrackingCalendarAction() === 'sick_leave' ? 'Hasta (opcional)' : 'Hasta';
  }

  protected requiresEmployeeTrackingEndDate(): boolean {
    return this.employeeTrackingCalendarAction() !== 'sick_leave';
  }

  protected onEmployeeTrackingCalendarStartDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.employeeTrackingCalendarStartDateIso.set(target.value);

    const currentEndDateIso = this.employeeTrackingCalendarEndDateIso();

    if (currentEndDateIso && target.value && currentEndDateIso < target.value) {
      this.employeeTrackingCalendarEndDateIso.set(target.value);
    }
  }

  protected onEmployeeTrackingCalendarEndDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.employeeTrackingCalendarEndDateIso.set(target.value);
  }

  protected confirmEmployeeTrackingCalendar(): void {
    const email = this.employeeTrackingCalendarEmail().trim().toLowerCase();
    const action = this.employeeTrackingCalendarAction();
    const startDateIso = this.employeeTrackingCalendarStartDateIso();
    const endDateIso = this.employeeTrackingCalendarEndDateIso();

    if (!email) {
      this.employeeError.set('No se pudo identificar al empleado.');
      return;
    }

    if (!startDateIso) {
      this.employeeError.set('Debes seleccionar la fecha de inicio.');
      return;
    }

    if (this.requiresEmployeeTrackingEndDate() && !endDateIso) {
      this.employeeError.set('Debes seleccionar la fecha final.');
      return;
    }

    if (endDateIso && endDateIso < startDateIso) {
      this.employeeError.set('La fecha final no puede ser anterior a la fecha de inicio.');
      return;
    }

    const customNote = this.buildEmployeeTrackingCalendarNote(action, startDateIso, endDateIso);

    this.closeEmployeeTrackingCalendarModal();
    this.updateEmployeeTracking(email, action, customNote);
  }

  protected getSelectedEmployeeDetail(): AdminEmployeeUser | null {
    const selectedEmail = this.selectedEmployeeEmail();

    if (!selectedEmail) {
      return null;
    }

    return this.employeeUsers().find((user) => user.email === selectedEmail) ?? null;
  }

  protected onClientFullNameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.clientFullName.set(target.value);
  }

  protected onClientEmailInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.clientEmail.set(target.value);
  }

  protected onClientPhoneInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.clientPhone.set(target.value);
  }

  protected onClientBirthDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.clientBirthDateIso.set(target.value);
  }

  protected onClientNotesInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.clientNotes.set(target.value);
  }

  protected onClientEditFullNameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.clientEditFullName.set(target.value);
  }

  protected onClientEditEmailInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.clientEditEmail.set(target.value);
  }

  protected onClientEditPhoneInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.clientEditPhone.set(target.value);
  }

  protected onClientEditBirthDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.clientEditBirthDateIso.set(target.value);
  }

  protected onClientEditNotesInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.clientEditNotes.set(target.value);
  }

  protected onClientSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.clientCardsSearch.set(target.value);
  }

  protected onClientTreatmentNameInput(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.clientTreatmentName.set(target.value);
  }

  protected getClientTreatmentOptionLabel(option: ClientTreatmentCatalogOption): string {
    const formattedPrice = option.priceLabel?.trim();

    if (formattedPrice) {
      return `${option.name} · ${formattedPrice}`;
    }

    if (typeof option.priceEuro === 'number' && option.priceEuro > 0) {
      return `${option.name} · ${option.priceEuro}€`;
    }

    return `${option.name} · Consultar`;
  }

  protected onClientChartTypeChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const value = target.value;

    if (value === 'bar' || value === 'pie') {
      this.clientChartType.set(value);
      this.persistGlobalTreatmentPreferences();
      return;
    }

    this.clientChartType.set('pie');
    this.persistGlobalTreatmentPreferences();
  }

  protected onClientTreatmentNoteInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.clientTreatmentNote.set(target.value);
  }

  protected clearClientSearch(): void {
    this.clientCardsSearch.set('');
  }

  protected getFilteredClientCards(): ClientCardItem[] {
    const search = this.clientCardsSearch().trim().toLowerCase();

    if (!search) {
      return [];
    }

    return this.clientCards().filter((card) => {
      return (
        card.fullName.toLowerCase().includes(search) ||
        card.email.toLowerCase().includes(search) ||
        card.phone.toLowerCase().includes(search)
      );
    });
  }

  protected getClientSummaryCards(): ClientCardItem[] {
    return this.clientCards();
  }

  protected getClientLatestTreatmentLabel(card: ClientCardItem): string {
    const latest = (card.treatments ?? [])[0];

    if (!latest) {
      return 'Sin packs todavía';
    }

    return `${latest.name} · ${this.formatDateTime(latest.createdAtIso)}`;
  }

  protected getAllClientTreatments(): ClientCardItem['treatments'] {
    return this.clientCards().flatMap((card) => card.treatments ?? []);
  }

  protected getFilteredGlobalTreatments(): ClientCardItem['treatments'] {
    return this.getAllClientTreatments().filter((treatment) =>
      this.matchesGlobalTreatmentFilters(treatment),
    );
  }

  protected getGlobalTreatmentsCount(): number {
    return this.getAllClientTreatments().length;
  }

  protected getClientsWithTreatmentsCount(): number {
    return this.clientCards().filter((card) => (card.treatments ?? []).length > 0).length;
  }

  protected getFilteredClientsWithTreatmentsCount(): number {
    return this.clientCards().filter((card) => {
      return (card.treatments ?? []).some((treatment) =>
        this.matchesGlobalTreatmentFilters(treatment),
      );
    }).length;
  }

  protected getFilteredGlobalTreatmentsCount(): number {
    return this.getFilteredGlobalTreatments().length;
  }

  protected getGlobalLatestTreatmentLabel(): string {
    const latest = this.getAllClientTreatments()
      .slice()
      .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso))[0];

    if (!latest) {
      return 'Sin packs todavía';
    }

    return `${latest.name} · ${this.formatDateTime(latest.createdAtIso)}`;
  }

  protected getFilteredGlobalLatestTreatmentLabel(): string {
    const latest = this.getFilteredGlobalTreatments()
      .slice()
      .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso))[0];

    if (!latest) {
      return 'Sin packs en el periodo';
    }

    return `${latest.name} · ${this.formatDateTime(latest.createdAtIso)}`;
  }

  protected getGlobalTreatmentFilterLabel(): string {
    const preset = this.globalTreatmentFilterPreset();

    if (preset === 'month') {
      return 'Mes actual';
    }

    if (preset === 'last30') {
      return 'Últimos 30 días';
    }

    if (preset === 'year') {
      return 'Año actual';
    }

    if (preset === 'custom') {
      const startDateIso = this.globalTreatmentStartDateIso();
      const endDateIso = this.globalTreatmentEndDateIso();

      if (startDateIso && endDateIso) {
        return `${this.formatDate(startDateIso)} → ${this.formatDate(endDateIso)}`;
      }

      if (startDateIso) {
        return `Desde ${this.formatDate(startDateIso)}`;
      }

      if (endDateIso) {
        return `Hasta ${this.formatDate(endDateIso)}`;
      }
    }

    return 'Todo el histórico';
  }

  protected getGlobalTreatmentEmployeeOptions(): GlobalTreatmentEmployeeOption[] {
    const optionsByEmail = new Map<string, GlobalTreatmentEmployeeOption>();

    this.employeeUsers().forEach((user) => {
      if (user.role === 'superadmin') {
        return;
      }

      optionsByEmail.set(user.email, {
        email: user.email,
        label: user.username || user.email,
      });
    });

    this.getAllClientTreatments().forEach((treatment) => {
      const email = treatment.createdByEmail?.trim();

      if (!email || optionsByEmail.has(email)) {
        return;
      }

      optionsByEmail.set(email, {
        email,
        label: this.formatGlobalTreatmentEmployeeFallbackLabel(email),
      });
    });

    const ownerEmail = this.ownerEmail().trim();

    if (ownerEmail && !optionsByEmail.has(ownerEmail)) {
      optionsByEmail.set(ownerEmail, {
        email: ownerEmail,
        label: this.formatGlobalTreatmentEmployeeFallbackLabel(ownerEmail),
      });
    }

    return Array.from(optionsByEmail.values()).sort((a, b) => a.label.localeCompare(b.label, 'es'));
  }

  protected getGlobalTreatmentEmployeeFilterLabel(): string {
    const selectedEmail = this.globalTreatmentEmployeeFilterEmail();

    if (!selectedEmail || selectedEmail === 'all') {
      return 'Todos';
    }

    return (
      this.getGlobalTreatmentEmployeeOptions().find((option) => option.email === selectedEmail)
        ?.label ?? this.formatGlobalTreatmentEmployeeFallbackLabel(selectedEmail)
    );
  }

  protected getGlobalTreatmentNameFilterLabel(): string {
    const selectedNames = this.globalTreatmentNameFilters();

    if (selectedNames.length === 0) {
      return 'Todos';
    }

    if (selectedNames.length <= 2) {
      return selectedNames.join(' · ');
    }

    return `${selectedNames.slice(0, 2).join(' · ')} +${selectedNames.length - 2}`;
  }

  protected getGlobalTreatmentEmployeeRankingRows(): GlobalTreatmentEmployeeRankingRow[] {
    const filteredTreatments = this.getFilteredGlobalTreatments();

    if (filteredTreatments.length === 0) {
      return [];
    }

    const countsByEmployee = new Map<string, number>();

    filteredTreatments.forEach((treatment) => {
      const email = treatment.createdByEmail?.trim() || 'unknown';
      countsByEmployee.set(email, (countsByEmployee.get(email) ?? 0) + 1);
    });

    const total = filteredTreatments.length;
    const rawRows = Array.from(countsByEmployee.entries())
      .map(([email, count]) => ({
        email,
        label: this.getGlobalTreatmentEmployeeDisplayLabel(email),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));

    const rows =
      rawRows.length > 6
        ? [
            ...rawRows.slice(0, 5),
            {
              email: 'others',
              label: 'Otros',
              count: rawRows.slice(5).reduce((sum, row) => sum + row.count, 0),
            },
          ]
        : rawRows;

    const max = rows.reduce((highest, row) => Math.max(highest, row.count), 0) || 1;

    return rows.map((row, index) => ({
      ...row,
      percentage: Math.round((row.count / total) * 100),
      color: this.clientTreatmentPalette[index % this.clientTreatmentPalette.length],
      widthPercent: Math.max(12, Math.round((row.count / max) * 100)),
    }));
  }

  protected getGlobalTopEmployeeLabel(): string {
    const topEmployee = this.getGlobalTreatmentEmployeeRankingRows()[0];

    if (!topEmployee) {
      return 'Sin datos';
    }

    return `${topEmployee.label} · ${topEmployee.count} packs`;
  }

  protected getGlobalTreatmentEmployeeSpecialtyRows(): GlobalTreatmentEmployeeSpecialtyRow[] {
    const filteredTreatments = this.getFilteredGlobalTreatments();

    if (filteredTreatments.length === 0) {
      return [];
    }

    const treatmentsByEmployee = new Map<string, ClientCardItem['treatments']>();

    filteredTreatments.forEach((treatment) => {
      const email = treatment.createdByEmail?.trim() || 'unknown';
      const current = treatmentsByEmployee.get(email) ?? [];
      current.push(treatment);
      treatmentsByEmployee.set(email, current);
    });

    return Array.from(treatmentsByEmployee.entries())
      .map(([email, treatments]) => {
        const specialtyRows = this.buildTreatmentCategoryRows(treatments);
        const topTreatment = specialtyRows[0];

        return {
          email,
          label: this.getGlobalTreatmentEmployeeDisplayLabel(email),
          totalCount: treatments.length,
          topTreatmentLabel: topTreatment
            ? `${topTreatment.name} · ${topTreatment.count}`
            : 'Sin packs',
          uniqueTreatmentsCount: new Set(treatments.map((treatment) => treatment.name.trim())).size,
          topTreatments: specialtyRows.slice(0, 3).map((row) => ({
            name: row.name,
            count: row.count,
          })),
        } satisfies GlobalTreatmentEmployeeSpecialtyRow;
      })
      .sort((a, b) => b.totalCount - a.totalCount || a.label.localeCompare(b.label, 'es'))
      .slice(0, 6);
  }

  private applyGlobalTreatmentFilterPreset(preset: GlobalTreatmentFilterPreset): void {
    this.globalTreatmentFilterPreset.set(preset);

    if (preset === 'all') {
      this.globalTreatmentStartDateIso.set('');
      this.globalTreatmentEndDateIso.set('');
      this.persistGlobalTreatmentPreferences();
      return;
    }

    const today = new Date();
    const endDateIso = this.toDateOnlyIso(today);

    if (preset === 'month') {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      this.globalTreatmentStartDateIso.set(this.toDateOnlyIso(start));
      this.globalTreatmentEndDateIso.set(endDateIso);
      this.persistGlobalTreatmentPreferences();
      return;
    }

    if (preset === 'last30') {
      const start = new Date(today);
      start.setDate(today.getDate() - 29);
      this.globalTreatmentStartDateIso.set(this.toDateOnlyIso(start));
      this.globalTreatmentEndDateIso.set(endDateIso);
      this.persistGlobalTreatmentPreferences();
      return;
    }

    if (preset === 'year') {
      const start = new Date(today.getFullYear(), 0, 1);
      this.globalTreatmentStartDateIso.set(this.toDateOnlyIso(start));
      this.globalTreatmentEndDateIso.set(endDateIso);
      this.persistGlobalTreatmentPreferences();
      return;
    }
  }

  private getDefaultGlobalTreatmentPreferences(): GlobalTreatmentPreferencesStorage {
    return {
      chartType: 'pie',
      employeeFilterEmail: 'all',
      filterPreset: 'all',
      startDateIso: '',
      endDateIso: '',
      timelineGrouping: 'auto',
      treatmentNames: [],
    };
  }

  private getCurrentGlobalTreatmentPreferences(): GlobalTreatmentPreferencesStorage {
    return {
      chartType: this.clientChartType(),
      employeeFilterEmail: this.globalTreatmentEmployeeFilterEmail(),
      filterPreset: this.globalTreatmentFilterPreset(),
      startDateIso: this.globalTreatmentStartDateIso(),
      endDateIso: this.globalTreatmentEndDateIso(),
      timelineGrouping: this.globalTreatmentTimelineGrouping(),
      treatmentNames: [...this.globalTreatmentNameFilters()],
    };
  }

  private applyGlobalTreatmentPreferences(preferences: GlobalTreatmentPreferencesStorage): void {
    this.clientChartType.set(preferences.chartType === 'bar' ? 'bar' : 'pie');
    this.globalTreatmentEmployeeFilterEmail.set(preferences.employeeFilterEmail || 'all');
    this.globalTreatmentTimelineGrouping.set(
      preferences.timelineGrouping === 'month' ||
        preferences.timelineGrouping === 'week' ||
        preferences.timelineGrouping === 'day'
        ? preferences.timelineGrouping
        : 'auto',
    );
    this.globalTreatmentNameFilters.set([...preferences.treatmentNames]);

    if (preferences.filterPreset === 'custom') {
      this.globalTreatmentFilterPreset.set('custom');
      this.globalTreatmentStartDateIso.set(preferences.startDateIso || '');
      this.globalTreatmentEndDateIso.set(preferences.endDateIso || '');
      return;
    }

    if (
      preferences.filterPreset === 'all' ||
      preferences.filterPreset === 'month' ||
      preferences.filterPreset === 'last30' ||
      preferences.filterPreset === 'year'
    ) {
      this.applyGlobalTreatmentFilterPreset(preferences.filterPreset);
      return;
    }

    this.applyGlobalTreatmentFilterPreset('all');
  }

  private areGlobalTreatmentPreferencesEqual(
    left: GlobalTreatmentPreferencesStorage,
    right: GlobalTreatmentPreferencesStorage,
  ): boolean {
    const leftTreatments = [...left.treatmentNames].sort();
    const rightTreatments = [...right.treatmentNames].sort();

    return (
      left.chartType === right.chartType &&
      left.employeeFilterEmail === right.employeeFilterEmail &&
      left.filterPreset === right.filterPreset &&
      left.startDateIso === right.startDateIso &&
      left.endDateIso === right.endDateIso &&
      left.timelineGrouping === right.timelineGrouping &&
      leftTreatments.length === rightTreatments.length &&
      leftTreatments.every((name, index) => name === rightTreatments[index])
    );
  }

  private buildGlobalTreatmentSavedViewId(name: string): string {
    const slug = name
      .trim()
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

    return `${slug || 'vista'}-${Date.now()}`;
  }

  private normalizeSearchText(value: string): string {
    return value
      .trim()
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  private persistGlobalTreatmentSavedViews(): void {
    if (!this.canUseLocalStorage()) {
      return;
    }

    window.localStorage.setItem(
      this.globalTreatmentSavedViewsStorageKey,
      JSON.stringify(this.globalTreatmentSavedViews()),
    );
  }

  private restoreGlobalTreatmentSavedViews(): void {
    if (!this.canUseLocalStorage()) {
      return;
    }

    const rawValue = window.localStorage.getItem(this.globalTreatmentSavedViewsStorageKey);

    if (!rawValue) {
      return;
    }

    try {
      const parsed = JSON.parse(rawValue) as unknown;

      if (!Array.isArray(parsed)) {
        window.localStorage.removeItem(this.globalTreatmentSavedViewsStorageKey);
        return;
      }

      const savedViews = parsed
        .map((item) => this.parseGlobalTreatmentSavedView(item))
        .filter((item): item is GlobalTreatmentSavedView => item !== null)
        .sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso))
        .slice(0, 8);

      this.globalTreatmentSavedViews.set(savedViews);
      this.persistGlobalTreatmentSavedViews();
    } catch {
      window.localStorage.removeItem(this.globalTreatmentSavedViewsStorageKey);
    }
  }

  private parseGlobalTreatmentSavedView(value: unknown): GlobalTreatmentSavedView | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const candidate = value as Partial<GlobalTreatmentSavedView> & {
      preferences?: Partial<GlobalTreatmentPreferencesStorage>;
    };

    if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
      return null;
    }

    const preferences = this.normalizeGlobalTreatmentPreferences(candidate.preferences);

    return {
      id:
        typeof candidate.id === 'string' && candidate.id.trim()
          ? candidate.id
          : this.buildGlobalTreatmentSavedViewId(candidate.name),
      name: candidate.name.trim(),
      updatedAtIso:
        typeof candidate.updatedAtIso === 'string' && candidate.updatedAtIso.trim()
          ? candidate.updatedAtIso
          : new Date().toISOString(),
      preferences,
    };
  }

  private normalizeGlobalTreatmentPreferences(
    value: Partial<GlobalTreatmentPreferencesStorage> | undefined,
  ): GlobalTreatmentPreferencesStorage {
    const defaults = this.getDefaultGlobalTreatmentPreferences();

    if (!value) {
      return defaults;
    }

    return {
      chartType: value.chartType === 'bar' ? 'bar' : 'pie',
      employeeFilterEmail:
        typeof value.employeeFilterEmail === 'string' && value.employeeFilterEmail.trim()
          ? value.employeeFilterEmail
          : defaults.employeeFilterEmail,
      filterPreset:
        value.filterPreset === 'month' ||
        value.filterPreset === 'last30' ||
        value.filterPreset === 'year' ||
        value.filterPreset === 'custom'
          ? value.filterPreset
          : 'all',
      startDateIso: typeof value.startDateIso === 'string' ? value.startDateIso : '',
      endDateIso: typeof value.endDateIso === 'string' ? value.endDateIso : '',
      timelineGrouping:
        value.timelineGrouping === 'month' ||
        value.timelineGrouping === 'week' ||
        value.timelineGrouping === 'day'
          ? value.timelineGrouping
          : 'auto',
      treatmentNames: Array.isArray(value.treatmentNames)
        ? value.treatmentNames.filter((name): name is string => typeof name === 'string' && !!name)
        : [],
    };
  }

  private persistGlobalTreatmentPreferences(): void {
    if (!this.canUseLocalStorage()) {
      return;
    }

    const payload = this.getCurrentGlobalTreatmentPreferences();

    window.localStorage.setItem(this.globalTreatmentPreferencesStorageKey, JSON.stringify(payload));
  }

  private restoreGlobalTreatmentPreferences(): void {
    if (!this.canUseLocalStorage()) {
      return;
    }

    const rawValue = window.localStorage.getItem(this.globalTreatmentPreferencesStorageKey);

    if (!rawValue) {
      return;
    }

    try {
      const parsed = JSON.parse(rawValue) as Partial<GlobalTreatmentPreferencesStorage>;
      this.applyGlobalTreatmentPreferences(this.normalizeGlobalTreatmentPreferences(parsed));
      this.persistGlobalTreatmentPreferences();
    } catch {
      window.localStorage.removeItem(this.globalTreatmentPreferencesStorageKey);
    }
  }

  private canUseLocalStorage(): boolean {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  }

  private getGlobalTreatmentDateRange(): { startDateIso: string; endDateIso: string } | null {
    const startDateIso = this.globalTreatmentStartDateIso();
    const endDateIso = this.globalTreatmentEndDateIso();

    if (!startDateIso && !endDateIso) {
      return null;
    }

    return {
      startDateIso: startDateIso || '0000-01-01',
      endDateIso: endDateIso || '9999-12-31',
    };
  }

  private toDateOnlyIso(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private matchesGlobalTreatmentFilters(treatment: ClientCardItem['treatments'][number]): boolean {
    const range = this.getGlobalTreatmentDateRange();

    if (range) {
      const dateIso = treatment.createdAtIso.slice(0, 10);

      if (dateIso < range.startDateIso || dateIso > range.endDateIso) {
        return false;
      }
    }

    const employeeFilterEmail = this.globalTreatmentEmployeeFilterEmail();

    if (employeeFilterEmail !== 'all' && treatment.createdByEmail !== employeeFilterEmail) {
      return false;
    }

    const treatmentNameFilters = this.globalTreatmentNameFilters();

    if (treatmentNameFilters.length > 0 && !treatmentNameFilters.includes(treatment.name)) {
      return false;
    }

    return true;
  }

  private formatGlobalTreatmentEmployeeFallbackLabel(email: string): string {
    const normalized = email.trim();

    if (!normalized) {
      return 'Sin empleado';
    }

    if (normalized === 'cliente-auto-registro') {
      return 'Cliente auto-registro';
    }

    const localPart = normalized.includes('@')
      ? (normalized.split('@')[0] ?? normalized)
      : normalized;
    const cleaned = localPart
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      return 'Sin empleado';
    }

    return cleaned
      .split(' ')
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  }

  protected getWorkerDisplayName(email: string | null | undefined): string {
    const normalized = (email ?? '').trim();

    if (!normalized) {
      return 'Sin usuario';
    }

    const normalizedLower = normalized.toLowerCase();
    const matchingEmployee = this.employeeUsers().find(
      (employee) => employee.email.trim().toLowerCase() === normalizedLower,
    );

    if (matchingEmployee?.username?.trim()) {
      return matchingEmployee.username.trim();
    }

    const ownerEmail = this.ownerEmail().trim().toLowerCase();
    const ownerUsername = this.ownerUsername().trim();

    if (ownerEmail && ownerUsername && ownerEmail === normalizedLower) {
      return ownerUsername;
    }

    return this.formatGlobalTreatmentEmployeeFallbackLabel(normalized);
  }

  private getGlobalTreatmentEmployeeDisplayLabel(email: string): string {
    if (email === 'unknown') {
      return 'Sin empleado';
    }

    return (
      this.getGlobalTreatmentEmployeeOptions().find((option) => option.email === email)?.label ??
      this.formatGlobalTreatmentEmployeeFallbackLabel(email)
    );
  }

  private buildTreatmentCategoryRows(
    treatments: Array<{ name: string }>,
  ): ClientTreatmentCategoryRow[] {
    const counter = new Map<string, number>();

    treatments.forEach((treatment) => {
      const key = treatment.name.trim() || 'Sin nombre';
      counter.set(key, (counter.get(key) ?? 0) + 1);
    });

    const rows = Array.from(counter.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    if (rows.length > 6) {
      const primaryRows = rows.slice(0, 5);
      const othersCount = rows.slice(5).reduce((total, row) => total + row.count, 0);
      rows.length = 0;
      rows.push(...primaryRows, { name: 'Otros', count: othersCount });
    }

    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const max = rows[0]?.count ?? 1;

    if (total === 0) {
      return [];
    }

    return rows.map((row, index) => ({
      ...row,
      percentage: Math.round((row.count / total) * 100),
      color: this.clientTreatmentPalette[index % this.clientTreatmentPalette.length],
      heightPercent: Math.max(12, Math.round((row.count / max) * 100)),
    }));
  }

  protected getClientTreatmentCategoryRows(card: ClientCardItem): ClientTreatmentCategoryRow[] {
    return this.buildTreatmentCategoryRows(card.treatments ?? []);
  }

  protected getGlobalTreatmentCategoryRows(): ClientTreatmentCategoryRow[] {
    return this.buildTreatmentCategoryRows(this.getFilteredGlobalTreatments());
  }

  protected getGlobalTimelineTreatmentRows(): GlobalTreatmentTimelineRow[] {
    const filteredTreatments = this.getFilteredGlobalTreatments();
    const grouping = this.getResolvedGlobalTreatmentTimelineGrouping();

    if (filteredTreatments.length === 0) {
      return [];
    }

    const countsByPeriod = new Map<string, number>();

    filteredTreatments.forEach((treatment) => {
      const date = new Date(treatment.createdAtIso);
      const periodStart = this.getTimelinePeriodStart(date, grouping);
      const periodKey = this.getTimelinePeriodKey(periodStart, grouping);
      countsByPeriod.set(periodKey, (countsByPeriod.get(periodKey) ?? 0) + 1);
    });

    const { startPeriod, endPeriod } = this.getGlobalTimelineRange(filteredTreatments, grouping);
    const timelineRows: Array<{ key: string; label: string; count: number }> = [];
    const cursor = new Date(startPeriod);
    const endCursor = new Date(endPeriod);

    while (cursor <= endCursor) {
      const periodKey = this.getTimelinePeriodKey(cursor, grouping);
      timelineRows.push({
        key: periodKey,
        label: this.formatTimelineLabel(cursor, grouping),
        count: countsByPeriod.get(periodKey) ?? 0,
      });
      this.incrementTimelineCursor(cursor, grouping);
    }

    const max = timelineRows.reduce((highest, row) => Math.max(highest, row.count), 0) || 1;
    const totalPoints = timelineRows.length;

    return timelineRows.map((row, index) => ({
      ...row,
      shortLabel: this.getTimelineShortLabel(row, grouping),
      tooltipLabel: this.getTimelineTooltipLabel(row, grouping),
      color: this.clientTreatmentPalette[index % this.clientTreatmentPalette.length],
      heightPercent: row.count === 0 ? 4 : Math.max(12, Math.round((row.count / max) * 100)),
      showLabel: this.shouldShowTimelineLabel(index, totalPoints, grouping),
    }));
  }

  protected getGlobalTimelineChartMinWidthRem(pointsCount: number): number {
    const grouping = this.getResolvedGlobalTreatmentTimelineGrouping();

    if (grouping === 'day') {
      return Math.max(18, pointsCount * 3.1);
    }

    if (grouping === 'week') {
      return Math.max(18, pointsCount * 3.8);
    }

    return Math.max(18, pointsCount * 4.2);
  }

  protected getGlobalTreatmentTimelineGroupingLabel(): string {
    const grouping = this.getResolvedGlobalTreatmentTimelineGrouping();

    if (grouping === 'day') {
      return 'Días';
    }

    if (grouping === 'week') {
      return 'Semanas';
    }

    return 'Meses';
  }

  protected getGlobalTreatmentTimelineGroupingSummary(): string {
    const selectedGrouping = this.globalTreatmentTimelineGrouping();
    const appliedLabel = this.getGlobalTreatmentTimelineGroupingLabel();

    if (selectedGrouping === 'auto') {
      return `Automática · ${appliedLabel}`;
    }

    return `Manual · ${appliedLabel}`;
  }

  protected isGlobalTimelineDense(rows: GlobalTreatmentTimelineRow[]): boolean {
    const grouping = this.getResolvedGlobalTreatmentTimelineGrouping();

    if (grouping === 'day') {
      return rows.length > 12;
    }

    if (grouping === 'week') {
      return rows.length > 10;
    }

    return rows.length > 8;
  }

  protected getClientBarChartTicks(rows: Array<{ count: number }>): number[] {
    const max = rows.reduce((highest, row) => Math.max(highest, row.count), 0);

    if (max <= 0) {
      return [0, 0, 0, 0, 0];
    }

    const step = max / 4;

    return [Math.ceil(max), Math.ceil(step * 3), Math.ceil(step * 2), Math.ceil(step), 0];
  }

  protected getClientTreatmentPieData(card: ClientCardItem): ClientTreatmentPieData {
    const rows = this.getClientTreatmentCategoryRows(card);
    return this.buildPieData(rows);
  }

  protected getGlobalTreatmentPieData(): ClientTreatmentPieData {
    return this.buildPieData(this.getGlobalTreatmentCategoryRows());
  }

  private buildPieData(rows: ClientTreatmentCategoryRow[]): ClientTreatmentPieData {
    const total = rows.reduce((sum, row) => sum + row.count, 0);

    if (total === 0) {
      return {
        total: 0,
        gradient: '',
        slices: [],
      };
    }

    const slices = rows.map((row) => ({
      ...row,
    }));

    let currentAngle = 0;
    const gradient = `conic-gradient(${slices
      .map((slice) => {
        const start = currentAngle;
        currentAngle += (slice.count / total) * 360;
        return `${slice.color} ${start}deg ${currentAngle}deg`;
      })
      .join(', ')})`;

    return {
      total,
      gradient,
      slices,
    };
  }

  private getGlobalTimelineRange(
    treatments: ClientCardItem['treatments'],
    grouping: GlobalTreatmentTimelineGrouping,
  ): {
    startPeriod: Date;
    endPeriod: Date;
  } {
    const selectedRange = this.getGlobalTreatmentDateRange();

    if (selectedRange) {
      const startDate = new Date(`${selectedRange.startDateIso}T00:00:00`);
      const endDate = new Date(`${selectedRange.endDateIso}T00:00:00`);
      return {
        startPeriod: this.getTimelinePeriodStart(startDate, grouping),
        endPeriod: this.getTimelinePeriodStart(endDate, grouping),
      };
    }

    const sortedDates = treatments
      .map((treatment) => new Date(treatment.createdAtIso))
      .sort((a, b) => a.getTime() - b.getTime());

    const first = sortedDates[0] ?? new Date();
    const last = sortedDates[sortedDates.length - 1] ?? new Date();

    return {
      startPeriod: this.getTimelinePeriodStart(first, grouping),
      endPeriod: this.getTimelinePeriodStart(last, grouping),
    };
  }

  private getResolvedGlobalTreatmentTimelineGrouping(): GlobalTreatmentTimelineGrouping {
    const selectedGrouping = this.globalTreatmentTimelineGrouping();

    if (selectedGrouping !== 'auto') {
      return selectedGrouping;
    }

    return this.getAutomaticGlobalTreatmentTimelineGrouping();
  }

  private getAutomaticGlobalTreatmentTimelineGrouping(): GlobalTreatmentTimelineGrouping {
    const filteredTreatments = this.getFilteredGlobalTreatments();
    const range = this.getGlobalTimelineReferenceRange(filteredTreatments);

    if (!range) {
      return 'month';
    }

    const millisecondsPerDay = 1000 * 60 * 60 * 24;
    const diffMs = range.endDate.getTime() - range.startDate.getTime();
    const totalDays = Math.floor(diffMs / millisecondsPerDay) + 1;

    if (totalDays <= 45) {
      return 'day';
    }

    if (totalDays <= 210) {
      return 'week';
    }

    return 'month';
  }

  private getGlobalTimelineReferenceRange(
    treatments: ClientCardItem['treatments'],
  ): { startDate: Date; endDate: Date } | null {
    const selectedRange = this.getGlobalTreatmentDateRange();

    if (selectedRange) {
      return {
        startDate: new Date(`${selectedRange.startDateIso}T00:00:00`),
        endDate: new Date(`${selectedRange.endDateIso}T00:00:00`),
      };
    }

    if (treatments.length === 0) {
      return null;
    }

    const sortedDates = treatments
      .map((treatment) => new Date(treatment.createdAtIso))
      .sort((a, b) => a.getTime() - b.getTime());

    return {
      startDate: sortedDates[0] ?? new Date(),
      endDate: sortedDates[sortedDates.length - 1] ?? new Date(),
    };
  }

  private shouldShowTimelineLabel(
    index: number,
    totalPoints: number,
    grouping: GlobalTreatmentTimelineGrouping,
  ): boolean {
    if (totalPoints <= 8) {
      return true;
    }

    const lastIndex = totalPoints - 1;

    if (index === 0 || index === lastIndex) {
      return true;
    }

    if (grouping === 'day') {
      if (totalPoints > 24) {
        return index % 4 === 0;
      }

      if (totalPoints > 14) {
        return index % 2 === 0;
      }

      return true;
    }

    if (grouping === 'week') {
      if (totalPoints > 18) {
        return index % 3 === 0;
      }

      if (totalPoints > 10) {
        return index % 2 === 0;
      }

      return true;
    }

    if (totalPoints > 14) {
      return index % 2 === 0;
    }

    return true;
  }

  private getTimelineShortLabel(
    row: { key: string; label: string },
    grouping: GlobalTreatmentTimelineGrouping,
  ): string {
    if (grouping === 'day') {
      return row.key.slice(8, 10);
    }

    if (grouping === 'week') {
      return row.label.replace('Sem ', 'S ');
    }

    return row.label;
  }

  private getTimelineTooltipLabel(
    row: { key: string; label: string },
    grouping: GlobalTreatmentTimelineGrouping,
  ): string {
    if (grouping === 'day') {
      return this.formatLongDate(new Date(`${row.key}T00:00:00`), row.label);
    }

    if (grouping === 'week') {
      const startDate = this.parseTimelineWeekKey(row.key);

      if (!startDate) {
        return row.label;
      }

      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 6);
      return `Semana del ${this.formatLongDate(startDate, row.label)} al ${this.formatLongDate(endDate, row.label)}`;
    }

    const startDate = new Date(`${row.key}-01T00:00:00`);

    if (!this.isValidDate(startDate)) {
      return row.label;
    }

    const formatted = new Intl.DateTimeFormat('es-ES', {
      month: 'long',
      year: 'numeric',
    }).format(startDate);

    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  private formatLongDate(date: Date, fallbackLabel = 'Fecha no disponible'): string {
    if (!this.isValidDate(date)) {
      return fallbackLabel;
    }

    const formatted = new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(date);

    return formatted.replace('.', '');
  }

  private parseTimelineWeekKey(key: string): Date | null {
    const match = key.match(/^(\d{4})-W-(\d{2})-(\d{2})$/);

    if (!match) {
      return null;
    }

    const [, year, month, day] = match;
    const parsed = new Date(`${year}-${month}-${day}T00:00:00`);
    return this.isValidDate(parsed) ? parsed : null;
  }

  private isValidDate(date: Date): boolean {
    return Number.isFinite(date.getTime());
  }

  private getTimelinePeriodStart(date: Date, grouping: GlobalTreatmentTimelineGrouping): Date {
    const normalized = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (grouping === 'day') {
      return normalized;
    }

    if (grouping === 'week') {
      const weekDay = normalized.getDay();
      const diffToMonday = weekDay === 0 ? -6 : 1 - weekDay;
      normalized.setDate(normalized.getDate() + diffToMonday);
      return normalized;
    }

    return new Date(normalized.getFullYear(), normalized.getMonth(), 1);
  }

  private getTimelinePeriodKey(date: Date, grouping: GlobalTreatmentTimelineGrouping): string {
    if (grouping === 'day') {
      return this.toDateOnlyIso(date);
    }

    if (grouping === 'week') {
      const year = date.getFullYear();
      const month = `${date.getMonth() + 1}`.padStart(2, '0');
      const day = `${date.getDate()}`.padStart(2, '0');
      return `${year}-W-${month}-${day}`;
    }

    return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`;
  }

  private incrementTimelineCursor(date: Date, grouping: GlobalTreatmentTimelineGrouping): void {
    if (grouping === 'day') {
      date.setDate(date.getDate() + 1);
      return;
    }

    if (grouping === 'week') {
      date.setDate(date.getDate() + 7);
      return;
    }

    date.setMonth(date.getMonth() + 1);
  }

  private formatTimelineLabel(date: Date, grouping: GlobalTreatmentTimelineGrouping): string {
    if (grouping === 'day') {
      const formatted = new Intl.DateTimeFormat('es-ES', {
        day: '2-digit',
        month: 'short',
      }).format(date);

      return formatted.replace('.', '');
    }

    if (grouping === 'week') {
      const start = new Intl.DateTimeFormat('es-ES', {
        day: '2-digit',
        month: 'short',
      })
        .format(date)
        .replace('.', '');
      return `Sem ${start}`;
    }

    const formatted = new Intl.DateTimeFormat('es-ES', {
      month: 'short',
      year: '2-digit',
    }).format(date);

    return formatted.replace('.', '');
  }

  protected createClientCard(): void {
    if (!this.requirePermission('clientes_gestionar', 'Gestionar fichas de clientes')) return;
    const fullName = this.clientFullName().trim();
    const email = this.clientEmail().trim();
    const phone = this.clientPhone().trim();
    const birthDateIso = this.clientBirthDateIso().trim();
    const notes = this.clientNotes().trim();

    this.clientCardsError.set('');
    this.clientCardsMessage.set('');

    if (!fullName || !email || !phone || !birthDateIso) {
      this.clientCardsError.set('Nombre, email, teléfono y fecha de nacimiento son obligatorios.');
      return;
    }

    if (this.isBirthDateInFuture(birthDateIso)) {
      this.clientCardsError.set('La fecha de nacimiento no puede ser posterior a hoy.');
      return;
    }

    this.clientFormLoading.set(true);

    this.http
      .post<{ ok: boolean; error?: string }>('/api/admin/clientes', {
        fullName,
        email,
        phone,
        birthDateIso,
        notes,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.clientCardsError.set(response.error ?? 'No se pudo crear la ficha de cliente.');
            return;
          }

          this.clientCardsMessage.set('Ficha de cliente creada correctamente.');
          this.clientFullName.set('');
          this.clientEmail.set('');
          this.clientPhone.set('');
          this.clientBirthDateIso.set('');
          this.clientNotes.set('');
          this.loadClientCards();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.clientCardsError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo crear la ficha de cliente.',
          );
        },
        complete: () => {
          this.clientFormLoading.set(false);
        },
      });
  }

  protected updateClientCard(): void {
    const selected = this.getSelectedClientCard();

    if (!selected) {
      this.clientCardsError.set('Selecciona una ficha de cliente.');
      return;
    }

    const fullName = this.clientEditFullName().trim();
    const email = this.clientEditEmail().trim();
    const phone = this.clientEditPhone().trim();
    const birthDateIso = this.clientEditBirthDateIso().trim();
    const notes = this.clientEditNotes().trim();

    this.clientCardsError.set('');
    this.clientCardsMessage.set('');

    if (!fullName || !email || !phone || !birthDateIso) {
      this.clientCardsError.set('Nombre, email, teléfono y fecha de nacimiento son obligatorios.');
      return;
    }

    if (this.isBirthDateInFuture(birthDateIso)) {
      this.clientCardsError.set('La fecha de nacimiento no puede ser posterior a hoy.');
      return;
    }

    this.clientEditLoading.set(true);

    this.http
      .patch<{ ok: boolean; error?: string }>(
        `/api/admin/clientes/${encodeURIComponent(selected.id)}`,
        {
          fullName,
          email,
          phone,
          birthDateIso,
          notes,
        },
      )
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.clientCardsError.set(response.error ?? 'No se pudo guardar la ficha del cliente.');
            return;
          }

          this.clientCardsMessage.set('Ficha de cliente actualizada correctamente.');
          this.loadClientCards();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.clientCardsError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo guardar la ficha del cliente.',
          );
        },
        complete: () => {
          this.clientEditLoading.set(false);
        },
      });
  }

  private isBirthDateInFuture(birthDateIso: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(birthDateIso) && birthDateIso > this.getTodayIso();
  }

  protected openDeleteClientConfirmModal(): void {
    if (!this.requirePermission('clientes_gestionar', 'Eliminar fichas de clientes')) return;

    const selected = this.getSelectedClientCard();

    if (!selected) {
      this.clientCardsError.set('Selecciona una ficha de cliente.');
      return;
    }

    this.clientCardsError.set('');
    this.clientCardsMessage.set('');
    this.showDeleteClientConfirmModal.set(true);
  }

  protected closeDeleteClientConfirmModal(): void {
    this.showDeleteClientConfirmModal.set(false);
    this.clientDeleteLoading.set(false);
  }

  protected confirmDeleteClientCard(): void {
    if (!this.requirePermission('clientes_gestionar', 'Eliminar fichas de clientes')) return;

    const selected = this.getSelectedClientCard();

    if (!selected) {
      this.clientCardsError.set('Selecciona una ficha de cliente.');
      this.showDeleteClientConfirmModal.set(false);
      return;
    }

    this.clientDeleteLoading.set(true);
    this.clientCardsError.set('');
    this.clientCardsMessage.set('');

    this.http
      .delete<{
        ok: boolean;
        deletedReservations?: number;
        error?: string;
      }>(`/api/admin/clientes/${encodeURIComponent(selected.id)}`)
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.clientCardsError.set(response.error ?? 'No se pudo eliminar la ficha.');
            return;
          }

          const deletedReservations = response.deletedReservations ?? 0;
          this.clientCardsMessage.set(
            `Clienta eliminada correctamente. Reservas eliminadas: ${deletedReservations}.`,
          );
          this.loadClientCards();
          this.loadReservations();
          this.closeDeleteClientConfirmModal();
          this.closeClientDetailModal();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.clientCardsError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo eliminar la ficha de clienta.',
          );
        },
        complete: () => {
          this.clientDeleteLoading.set(false);
        },
      });
  }

  protected addClientTreatment(): void {
    const selected = this.getSelectedClientCard();
    const name = this.clientTreatmentName().trim();
    const note = this.clientTreatmentNote().trim();

    this.clientCardsError.set('');
    this.clientCardsMessage.set('');

    if (!selected) {
      this.clientCardsError.set('Selecciona una ficha de cliente.');
      return;
    }

    if (!name) {
      this.clientCardsError.set('Debes seleccionar el tratamiento realizado.');
      return;
    }

    this.clientTreatmentLoading.set(true);

    this.http
      .post<{
        ok: boolean;
        error?: string;
      }>(`/api/admin/clientes/${encodeURIComponent(selected.id)}/packs`, { name, note })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.clientCardsError.set(response.error ?? 'No se pudo registrar el tratamiento.');
            return;
          }

          this.clientCardsMessage.set('Tratamiento añadido al historial.');
          this.clientTreatmentName.set('');
          this.clientTreatmentNote.set('');
          this.loadClientCards();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.clientCardsError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo registrar el tratamiento.',
          );
        },
        complete: () => {
          this.clientTreatmentLoading.set(false);
        },
      });
  }

  protected openPaymentModal(): void {
    this.paymentSelectTreatmentOpen.set(true);
    this.selectedTreatmentForPayment.set(null);
    this.paymentMethod.set(null);
    this.paymentAmount.set('');
    this.paymentError.set('');
  }

  protected closePaymentModal(): void {
    this.paymentModalOpen.set(false);
    this.paymentSelectTreatmentOpen.set(false);
    this.selectedTreatmentForPayment.set(null);
    this.paymentMethod.set(null);
    this.paymentAmount.set('');
    this.paymentLoading.set(false);
    this.paymentError.set('');
  }

  protected backToPaymentTreatments(): void {
    this.paymentModalOpen.set(false);
    this.paymentSelectTreatmentOpen.set(true);
    this.paymentMethod.set(null);
    this.paymentAmount.set('');
    this.paymentError.set('');
  }

  protected selectTreatmentForPayment(treatment: {
    id: string;
    name: string;
    priceEuro?: number;
  }): void {
    const fallbackPrice = this.getPackPriceByName(treatment.name);
    const resolvedPrice = treatment.priceEuro ?? fallbackPrice;

    this.selectedTreatmentForPayment.set(treatment);
    if (treatment.priceEuro === undefined || treatment.priceEuro === null) {
      this.selectedTreatmentForPayment.set({
        ...treatment,
        priceEuro: fallbackPrice,
      });
    }
    this.paymentAmount.set(Number.isFinite(resolvedPrice) ? `${resolvedPrice}` : '');
    this.paymentSelectTreatmentOpen.set(false);
    this.paymentModalOpen.set(true);
    this.paymentMethod.set(null);
    this.paymentError.set('');
  }

  protected onPaymentAmountInput(value: string): void {
    this.paymentAmount.set(value);
  }

  protected submitPayment(): void {
    const selected = this.getSelectedClientCard();
    const treatment = this.selectedTreatmentForPayment();
    const method = this.paymentMethod();
    const amountRaw = this.paymentAmount().replace(',', '.').trim();

    if (!selected || !treatment || !method) {
      this.paymentError.set('Selecciona un tratamiento y método de pago.');
      return;
    }

    const fallbackPrice = treatment.priceEuro ?? this.getPackPriceByName(treatment.name);
    const price = amountRaw === '' ? fallbackPrice : Number(amountRaw);

    if (!Number.isFinite(price) || price < 0) {
      this.paymentError.set('El precio del tratamiento es inválido.');
      return;
    }

    this.paymentLoading.set(true);
    this.paymentError.set('');

    this.http
      .patch<{
        ok: boolean;
        card?: ClientCardItem;
        error?: string;
      }>(
        `/api/admin/clientes/${encodeURIComponent(selected.id)}/packs/${encodeURIComponent(treatment.id)}/payment`,
        {
          priceEuro: price,
          paymentMethod: method,
        },
      )
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.paymentError.set(response.error ?? 'No se pudo registrar el pago.');
            return;
          }

          this.clientCardsMessage.set(
            `Pago de ${price}€ por ${treatment.name} registrado como ${method}.`,
          );
          this.loadClientCards();
          this.loadCierreAutoDiario();
          this.closePaymentModal();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.paymentError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo registrar el pago.',
          );
        },
        complete: () => {
          this.paymentLoading.set(false);
        },
      });
  }

  protected getPackPriceByName(name: string): number {
    return getPackPriceByName(name);
  }

  protected getRoleLabel(role: AdminUserRole): string {
    return this.employeeAdminService.getRoleLabel(role);
  }

  protected onEmployeeSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.employeeSearch.set(target.value);
  }

  protected onEmployeeCreateUsernameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.employeeCreateUsername.set(target.value);
    this.updateEmployeeCreateFieldError('username', target.value);
  }

  protected onEmployeeCreateEmailInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.employeeCreateEmail.set(target.value);
    this.updateEmployeeCreateFieldError('email', target.value);
  }

  protected onEmployeeCreatePasswordInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.employeeCreatePassword.set(target.value);
    this.updateEmployeeCreateFieldError('password', target.value);
  }

  protected onEmployeeCreateRoleChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.employeeCreateRole.set(target.value === 'client' ? 'client' : 'admin');
  }

  protected onEmployeeRoleFilterChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.employeeRoleFilter.set(target.value as 'all' | 'admin' | 'client' | 'superadmin');
  }

  protected onSelectedEmployeeInput(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.selectedEmployeeEmail.set(target.value);
  }

  protected onEmployeeHistoryStartDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.employeeHistoryStartDateIso.set(target.value);
  }

  protected onEmployeeHistoryEndDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.employeeHistoryEndDateIso.set(target.value);
  }

  protected resetEmployeeHistoryRangeToCurrentMonth(): void {
    const today = new Date();
    const year = today.getFullYear();
    const month = `${today.getMonth() + 1}`.padStart(2, '0');
    const day = `${today.getDate()}`.padStart(2, '0');

    this.employeeHistoryStartDateIso.set(`${year}-${month}-01`);
    this.employeeHistoryEndDateIso.set(`${year}-${month}-${day}`);
  }

  protected setEmployeeHistoryLast30Days(): void {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - 29);

    this.employeeHistoryStartDateIso.set(this.toDateIso(startDate));
    this.employeeHistoryEndDateIso.set(this.toDateIso(endDate));
  }

  protected getEmployeeHistoryRangeLabel(): string {
    const startDateIso = this.employeeHistoryStartDateIso();
    const endDateIso = this.employeeHistoryEndDateIso();

    if (!startDateIso && !endDateIso) {
      return 'Todo el histórico disponible';
    }

    if (startDateIso && endDateIso) {
      return `${this.formatDate(startDateIso)} → ${this.formatDate(endDateIso)}`;
    }

    if (startDateIso) {
      return `Desde ${this.formatDate(startDateIso)}`;
    }

    return `Hasta ${this.formatDate(endDateIso)}`;
  }

  protected getFilteredEmployeeUsers(): AdminEmployeeUser[] {
    return this.employeeAdminService.getFilteredUsers(
      this.employeeUsers(),
      this.employeeSearch(),
      this.employeeRoleFilter(),
    );
  }

  protected getEmployeeSummaryUsers(): AdminEmployeeUser[] {
    return this.employeeAdminService.getSummaryUsers(this.employeeUsers());
  }

  protected getFilteredEmployeeHistory(user: AdminEmployeeUser): EmployeeTrackingHistoryItem[] {
    return this.employeeAdminService.getFilteredHistory(
      user.tracking.history,
      this.employeeHistoryStartDateIso(),
      this.employeeHistoryEndDateIso(),
    );
  }

  protected getEmployeeSelectableUsers(): AdminEmployeeUser[] {
    return this.getFilteredEmployeeUsers().filter((user) => user.role !== 'superadmin');
  }

  protected getSelectedEmployeeForTimesheet(): AdminEmployeeUser | null {
    const selectableUsers = this.getEmployeeSelectableUsers();

    if (selectableUsers.length === 0) {
      return null;
    }

    const selectedEmail = this.selectedEmployeeEmail();
    const selectedUser = selectableUsers.find((user) => user.email === selectedEmail);

    if (selectedUser) {
      return selectedUser;
    }

    return selectableUsers[0] ?? null;
  }

  protected getEmployeeWorkedMinutes(user: AdminEmployeeUser): number {
    const orderedEvents = this.getFilteredEmployeeHistory(user)
      .slice()
      .sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso));

    let totalMinutes = 0;
    let pendingCheckInDate: Date | null = null;

    orderedEvents.forEach((event) => {
      if (event.action === 'check_in') {
        pendingCheckInDate = new Date(event.createdAtIso);
        return;
      }

      if (event.action === 'check_out' && pendingCheckInDate) {
        const checkOutDate = new Date(event.createdAtIso);
        const diffMs = checkOutDate.getTime() - pendingCheckInDate.getTime();

        if (diffMs > 0) {
          totalMinutes += Math.round(diffMs / 60000);
        }

        pendingCheckInDate = null;
      }
    });

    return totalMinutes;
  }

  protected getEmployeeTrackingStats(user: AdminEmployeeUser): EmployeeTrackingStats {
    return this.getFilteredEmployeeHistory(user).reduce<EmployeeTrackingStats>(
      (stats, item) => {
        if (item.action === 'check_in') {
          stats.checkIns += 1;
        } else if (item.action === 'check_out') {
          stats.checkOuts += 1;
        } else if (item.action === 'vacation') {
          stats.vacations += 1;
        } else if (item.action === 'sick_leave') {
          stats.sickLeaves += 1;
        } else if (item.action === 'recovering_hours') {
          stats.recoveryHours += 1;
        } else {
          stats.clearedStates += 1;
        }

        return stats;
      },
      {
        checkIns: 0,
        checkOuts: 0,
        vacations: 0,
        sickLeaves: 0,
        recoveryHours: 0,
        clearedStates: 0,
      },
    );
  }

  protected isEmployeeActionLoading(email: string): boolean {
    return this.employeeActionLoadingEmail() === email;
  }

  protected getEmployeeWorkStatusLabel(status: EmployeeWorkStatus): string {
    return this.employeeAdminService.getWorkStatusLabel(status);
  }

  protected getEmployeeTrackingSummary(user: AdminEmployeeUser): string {
    if (user.tracking.workStatus === 'vacation') {
      return user.tracking.vacationNote || 'Vacaciones activas';
    }

    if (user.tracking.workStatus === 'sick_leave') {
      return user.tracking.sickLeaveNote || 'Baja activa';
    }

    if (user.tracking.workStatus === 'recovering_hours') {
      return user.tracking.recoveryHoursNote || 'Recuperación de horas';
    }

    if (user.tracking.workStatus === 'working' && user.tracking.lastCheckInIso) {
      return `Entrada: ${this.formatDateTime(user.tracking.lastCheckInIso)}`;
    }

    if (user.tracking.lastCheckOutIso) {
      return `Última salida: ${this.formatDateTime(user.tracking.lastCheckOutIso)}`;
    }

    return 'Sin movimientos registrados';
  }

  protected getEmployeeTrackingHistoryLabel(action: EmployeeTrackingAction): string {
    if (action === 'check_in') return 'Entrada';
    if (action === 'check_out') return 'Salida';
    if (action === 'vacation') return 'Vacaciones';
    if (action === 'sick_leave') return 'Baja';
    if (action === 'recovering_hours') return 'Recuperación de horas';
    return 'Estado limpiado';
  }

  protected onEmployeeTrackingNoteInput(email: string, event: Event): void {
    const target = event.target as HTMLInputElement;
    this.employeeTrackingNote.update((current) => ({
      ...current,
      [email]: target.value,
    }));
  }

  protected getEmployeeTrackingNote(email: string): string {
    return this.employeeTrackingNote()[email] ?? '';
  }

  protected promoteToAdmin(email: string): void {
    this.openRoleChangeConfirm(email, 'admin');
  }

  protected setAsEmployee(email: string): void {
    this.openRoleChangeConfirm(email, 'client');
  }

  protected getRoleChangeTargetName(): string {
    const email = this.roleChangeTargetEmail();

    if (!email) {
      return '';
    }

    const user = this.employeeUsers().find((item) => item.email === email);
    return user?.username ?? email;
  }

  protected getRoleChangeSummaryText(): string {
    const targetName = this.getRoleChangeTargetName();
    const currentRoleLabel = this.getRoleChangeCurrentRoleLabel();
    const targetRoleLabel = this.getRoleChangeTargetRoleLabel();

    return `El estado de ${targetName} va a cambiar de ${currentRoleLabel} a ${targetRoleLabel}, así como sus permisos y acciones. ¿Deseas continuar?`;
  }

  protected cancelRoleChangeConfirm(): void {
    this.showRoleChangeConfirmModal.set(false);
    this.roleChangeTargetEmail.set('');
  }

  protected confirmRoleChangeConfirm(): void {
    const email = this.roleChangeTargetEmail();
    const role = this.roleChangeTargetRole();

    this.showRoleChangeConfirmModal.set(false);
    this.roleChangeTargetEmail.set('');

    if (!email) {
      return;
    }

    this.updateEmployeeRole(email, role);
  }

  protected canDeleteEmployee(user: AdminEmployeeUser): boolean {
    return user.role !== 'superadmin';
  }

  protected createEmployee(): void {
    const username = this.employeeCreateUsername().trim();
    const email = this.employeeCreateEmail().trim();
    const password = this.employeeCreatePassword();
    const role = this.employeeCreateRole();
    const permissions = this.employeeCreatePermissions();

    this.employeeError.set('');
    this.employeeMessage.set('');

    const fieldErrors = this.getEmployeeCreateFieldErrors(username, email, password);
    this.employeeCreateFieldErrors.set(fieldErrors);

    if (Object.values(fieldErrors).some(Boolean)) {
      this.employeeError.set('Revisa los campos marcados antes de crear el empleado.');
      return;
    }

    this.employeeCreateLoading.set(true);

    this.http
      .post<{ ok: boolean; error?: string }>('/api/admin/empleados', {
        username,
        email,
        password,
        role,
        permissions,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.employeeError.set(response.error ?? 'No se pudo crear el empleado.');
            this.employeeCreateLoading.set(false);
            return;
          }

          this.employeeMessage.set('Empleado creado correctamente.');
          this.employeeCreateUsername.set('');
          this.employeeCreateEmail.set('');
          this.employeeCreatePassword.set('');
          this.employeeCreateRole.set('admin');
          this.employeeCreatePermissions.set([...ALL_PERMISSIONS]);
          this.resetEmployeeCreateFieldErrors();
          this.loadEmployeeUsers();
          this.employeeCreateLoading.set(false);
        },
        error: (error) => {
          const apiError = error?.error?.error;
          const errorMessage =
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo crear el empleado.';
          this.employeeError.set(errorMessage);
          this.applyEmployeeCreateApiError(errorMessage);
          this.employeeCreateLoading.set(false);
        },
      });
  }

  protected getEmployeeCreateFieldError(field: keyof EmployeeCreateFieldErrors): string {
    return this.employeeCreateFieldErrors()[field];
  }

  protected onSuperadminUsernameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.superadminEditUsername.set(target.value);
  }

  protected onSuperadminEmailInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.superadminEditEmail.set(target.value);
  }

  protected onSuperadminPasswordInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.superadminEditPassword.set(target.value);
  }

  protected toggleSuperadminPasswordVisibility(): void {
    this.showSuperadminEditPassword.update((value) => !value);
  }

  protected saveSuperadminCredentials(): void {
    if (!this.isSuperadmin()) {
      this.employeeError.set('Solo superadmin puede actualizar estas credenciales.');
      return;
    }

    const username = this.superadminEditUsername().trim();
    const email = this.superadminEditEmail().trim().toLowerCase();
    const password = this.superadminEditPassword();

    this.employeeError.set('');
    this.employeeMessage.set('');

    if (!username || !email) {
      this.employeeError.set('Usuario y email son obligatorios para la cuenta superadmin.');
      return;
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      this.employeeError.set('El email superadmin no tiene un formato válido.');
      return;
    }

    if (username.length < 3 || username.length > 40) {
      this.employeeError.set('El usuario superadmin debe tener entre 3 y 40 caracteres.');
      return;
    }

    if (password) {
      if (password.length < 8) {
        this.employeeError.set('La nueva contraseña debe tener al menos 8 caracteres.');
        return;
      }

      if (!/[A-Z]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
        this.employeeError.set('La contraseña debe incluir una mayúscula y un carácter especial.');
        return;
      }
    }

    this.superadminEditLoading.set(true);

    this.http
      .patch<{
        ok: boolean;
        error?: string;
        user?: { email: string; username: string; role: AdminUserRole };
      }>('/api/admin/superadmin/credenciales', {
        username,
        email,
        password,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.employeeError.set(response.error ?? 'No se pudo actualizar la cuenta superadmin.');
            return;
          }

          const updatedUser = response.user;

          if (updatedUser) {
            this.ownerEmail.set(updatedUser.email);
            this.ownerUsername.set(updatedUser.username);
            this.superadminEditEmail.set(updatedUser.email);
            this.superadminEditUsername.set(updatedUser.username);
          }

          this.superadminEditPassword.set('');
          this.showSuperadminEditPassword.set(false);
          this.employeeMessage.set('Credenciales de superadmin actualizadas correctamente.');
          this.loadEmployeeUsers();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.employeeError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo actualizar la cuenta superadmin.',
          );
        },
        complete: () => {
          this.superadminEditLoading.set(false);
        },
      });
  }

  protected deleteEmployee(email: string): void {
    if (typeof window !== 'undefined' && !window.confirm('¿Eliminar este empleado?')) {
      return;
    }

    this.employeeError.set('');
    this.employeeMessage.set('');
    this.employeeActionLoadingEmail.set(email);

    this.http
      .delete<{ ok: boolean; error?: string }>(`/api/admin/empleados/${encodeURIComponent(email)}`)
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.employeeError.set(response.error ?? 'No se pudo eliminar el empleado.');
            return;
          }

          this.employeeMessage.set('Empleado eliminado correctamente.');
          this.loadEmployeeUsers();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.employeeError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo eliminar el empleado.',
          );
        },
        complete: () => {
          this.employeeActionLoadingEmail.set('');
        },
      });
  }

  protected canPromote(user: AdminEmployeeUser): boolean {
    return user.role === 'client';
  }

  protected canDemote(user: AdminEmployeeUser): boolean {
    return user.role === 'admin';
  }

  protected canMarkCheckIn(user: AdminEmployeeUser): boolean {
    return user.tracking.workStatus !== 'working';
  }

  protected canMarkCheckOut(user: AdminEmployeeUser): boolean {
    return user.tracking.workStatus === 'working';
  }

  protected updateEmployeeTracking(
    email: string,
    action: EmployeeTrackingAction,
    customNote?: string,
  ): void {
    const note = (customNote ?? this.getEmployeeTrackingNote(email)).trim().slice(0, 160);

    this.employeeError.set('');
    this.employeeMessage.set('');
    this.employeeActionLoadingEmail.set(email);

    this.http
      .patch<{
        ok: boolean;
        error?: string;
      }>(`/api/admin/empleados/${encodeURIComponent(email)}/tracking`, { action, note })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.employeeError.set(response.error ?? 'No se pudo actualizar el fichaje.');
            return;
          }

          this.employeeMessage.set('Estado de empleado actualizado.');
          this.employeeTrackingNote.update((current) => ({
            ...current,
            [email]: '',
          }));
          this.loadEmployeeUsers();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.employeeError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo actualizar el fichaje.',
          );
        },
        complete: () => {
          this.employeeActionLoadingEmail.set('');
        },
      });
  }

  protected getPendingReservationsCount(): number {
    return this.reservations().filter((reservation) => reservation.adminStatus === 'pending')
      .length;
  }

  protected getTodayIso(): string {
    const today = new Date();
    const year = today.getFullYear();
    const month = `${today.getMonth() + 1}`.padStart(2, '0');
    const day = `${today.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  protected formatDateTime(dateIso: string): string {
    if (!dateIso) {
      return '';
    }

    const date = new Date(dateIso);

    return date.toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  protected onBlockDateInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.blockDateIso.set(target.value);

    if (target.value.length >= 7) {
      this.calendarMonthIso.set(target.value.slice(0, 7));
    }
  }

  protected onCalendarMonthInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.calendarMonthIso.set(target.value);
  }

  protected goToPreviousMonth(): void {
    this.shiftCalendarMonth(-1);
  }

  protected goToNextMonth(): void {
    this.shiftCalendarMonth(1);
  }

  protected onBlockStartTimeInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.blockStartTime.set(target.value);
  }

  protected onBlockEndTimeInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.blockEndTime.set(target.value);
  }

  protected onBlockReasonInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.blockReason.set(target.value);
  }

  protected selectFullDayMode(): void {
    const fullDayRange = this.getFullDayBlockRange(this.blockDateIso() || this.getTodayIso());
    this.isFullDayBlock.set(true);
    this.blockStartTime.set(fullDayRange.startTime);
    this.blockEndTime.set(fullDayRange.endTime);
  }

  protected selectHourlyMode(): void {
    this.isFullDayBlock.set(false);
    const fullDayRange = this.getFullDayBlockRange(this.blockDateIso() || this.getTodayIso());

    if (
      this.blockStartTime() === fullDayRange.startTime &&
      this.blockEndTime() === fullDayRange.endTime
    ) {
      this.blockStartTime.set(fullDayRange.startTime);
      this.blockEndTime.set(
        this.formatMinutesToTime(this.parseTimeToMinutes(fullDayRange.startTime) + 60),
      );
    }
  }

  protected onFullDayBlockChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.isFullDayBlock.set(target.checked);

    if (target.checked) {
      const fullDayRange = this.getFullDayBlockRange(this.blockDateIso() || this.getTodayIso());
      this.blockStartTime.set(fullDayRange.startTime);
      this.blockEndTime.set(fullDayRange.endTime);
    }
  }

  protected formatDuration(minutes: number): string {
    if (minutes < 60) {
      return `${minutes} min`;
    }

    const hours = minutes / 60;

    if (Number.isInteger(hours)) {
      return hours === 1 ? '1 hora' : `${hours} horas`;
    }

    return `${Math.floor(hours)} h ${minutes % 60} min`;
  }

  protected formatDate(dateIso: string): string {
    const date = new Date(`${dateIso}T00:00:00`);

    return date.toLocaleDateString('es-ES', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  protected toDateIso(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  protected isActionLoading(id: string): boolean {
    return this.actionLoadingId() === id;
  }

  protected formatTimeRange(startTime: string, endTime: string): string {
    if (
      (startTime === '10:00' && endTime === '18:30') ||
      (startTime === '09:00' && endTime === '13:30')
    ) {
      return 'Día completo';
    }

    return `${startTime} - ${endTime}`;
  }

  protected getCalendarMonthLabel(): string {
    const monthIso = this.calendarMonthIso();

    if (!monthIso) {
      return '';
    }

    const date = new Date(`${monthIso}-01T00:00:00`);

    return date.toLocaleDateString('es-ES', {
      month: 'long',
      year: 'numeric',
    });
  }

  protected getCalendarDays(): AdminCalendarDay[] {
    const monthIso = this.calendarMonthIso();

    if (!monthIso) {
      return [];
    }

    const [yearRaw, monthRaw] = monthIso.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);

    if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
      return [];
    }

    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    const firstWeekday = (monthStart.getDay() + 6) % 7;
    const gridStart = new Date(year, month - 1, 1 - firstWeekday);

    const blockedPeriodsByDate = new Map<string, AdminBlockedPeriodItem[]>();

    this.blockedPeriods().forEach((blockedPeriod) => {
      const current = blockedPeriodsByDate.get(blockedPeriod.dateIso) ?? [];
      current.push(blockedPeriod);
      blockedPeriodsByDate.set(blockedPeriod.dateIso, current);
    });

    const reservationsByDate = new Map<string, number>();

    this.reservations().forEach((reservation) => {
      const current = reservationsByDate.get(reservation.dateIso) ?? 0;
      reservationsByDate.set(reservation.dateIso, current + 1);
    });

    const todayIso = this.getTodayIso();
    const days: AdminCalendarDay[] = [];

    for (let index = 0; index < 42; index += 1) {
      const dayDate = new Date(gridStart);
      dayDate.setDate(gridStart.getDate() + index);
      const yearValue = dayDate.getFullYear();
      const monthValue = `${dayDate.getMonth() + 1}`.padStart(2, '0');
      const dayValue = `${dayDate.getDate()}`.padStart(2, '0');
      const dateIso = `${yearValue}-${monthValue}-${dayValue}`;
      const periods = blockedPeriodsByDate.get(dateIso) ?? [];
      const fullDayRange = this.getFullDayBlockRange(dateIso);
      const isFullBlocked = periods.some(
        (blockedPeriod) =>
          blockedPeriod.startTime === fullDayRange.startTime &&
          blockedPeriod.endTime === fullDayRange.endTime,
      );

      days.push({
        dateIso,
        dayNumber: dayDate.getDate(),
        isCurrentMonth: dayDate >= monthStart && dayDate <= monthEnd,
        isToday: dateIso === todayIso,
        isPast: dateIso < todayIso,
        isFullBlocked,
        hasPartialBlocked: !isFullBlocked && periods.length > 0,
        reservationCount: reservationsByDate.get(dateIso) ?? 0,
      });
    }

    return days;
  }

  protected selectCalendarDay(day: AdminCalendarDay): void {
    if (!day.isCurrentMonth || day.isPast) {
      return;
    }

    this.blockDateIso.set(day.dateIso);
    this.blockError.set('');
    this.blockMessage.set('');

    const reservationsForDay = this.reservations().filter(
      (reservation) => reservation.dateIso === day.dateIso,
    );

    if (reservationsForDay.length > 0) {
      this.dayReservationsDateIso.set(day.dateIso);
      this.dayReservations.set(reservationsForDay);
      this.showDayReservationsModal.set(true);
      return;
    }

    this.closeDayReservationsModal();
  }

  protected isCalendarDaySelected(day: AdminCalendarDay): boolean {
    return this.blockDateIso() === day.dateIso;
  }

  protected closeDayReservationsModal(): void {
    this.showDayReservationsModal.set(false);
    this.dayReservationsDateIso.set('');
    this.dayReservations.set([]);
  }

  protected isAgendaReservationUpdating(reservationId: string): boolean {
    return this.agendaDayScheduleLoadingReservationId() === reservationId;
  }

  protected markPaymentReceived(reservationId: string): void {
    this.clientTypePickerReservationId.set(reservationId);
    this.showClientTypePickerModal.set(true);
  }

  protected closeClientTypePickerModal(): void {
    this.showClientTypePickerModal.set(false);
    this.clientTypePickerReservationId.set('');
  }

  protected onClientTypePickerNewClient(): void {
    const reservationId = this.clientTypePickerReservationId();
    const reservation = this.reservations().find((r) => r.id === reservationId) ?? null;

    this.showClientTypePickerModal.set(false);
    this.clientTypePickerReservationId.set('');

    // Navigate to clients tab, crear subtab, pre-fill with reservation data
    this.activeTab.set('clientes');
    this.clientManagementTab.set('crear');

    if (reservation) {
      this.clientFullName.set(reservation.customerName ?? '');
      this.clientEmail.set(reservation.customerEmail ?? '');
      this.clientPhone.set(reservation.customerPhone ?? '');
    }
  }

  protected onClientTypePickerExistingClient(): void {
    const reservationId = this.clientTypePickerReservationId();
    const reservation = this.reservations().find((r) => r.id === reservationId) ?? null;

    this.showClientTypePickerModal.set(false);
    this.clientTypePickerReservationId.set('');

    if (!reservation) {
      this.activeTab.set('clientes');
      this.clientManagementTab.set('listado');
      return;
    }

    // Try to find a matching client card by email
    const matchingCard = this.clientCards().find(
      (card) => card.email?.toLowerCase() === reservation.customerEmail?.toLowerCase(),
    );

    this.activeTab.set('clientes');

    if (matchingCard) {
      // Client found — open their ficha directly
      this.clientManagementTab.set('listado');
      this.openClientDetailModal(matchingCard.id);
    } else {
      // Not found — go to client list so admin can pick manually
      this.clientManagementTab.set('listado');
    }
  }

  protected markPaymentReceivedDirect(reservationId: string): void {
    this.paymentMethodReservationId.set(reservationId);
    this.selectedPaymentMethod.set('');
    this.showPaymentMethodModal.set(true);
  }

  protected confirmPaymentMethod(): void {
    const reservationId = this.paymentMethodReservationId();
    const paymentMethod = this.selectedPaymentMethod();
    const priceEuro = Number(this.paymentMethodReservationPriceEuro().toFixed(2));

    if (!reservationId || !paymentMethod) {
      return;
    }

    this.actionError.set('');
    this.actionLoadingId.set(reservationId);
    this.showPaymentMethodModal.set(false);

    this.http
      .patch<{ ok: boolean; error?: string }>(`/api/admin/reservas/${reservationId}/payment`, {
        paymentReceived: true,
        paymentMethod,
        priceEuro,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.actionError.set(response.error ?? 'No se pudo actualizar el pago.');
            return;
          }

          const shouldConfirmReservationAfterPayment =
            this.agendaDetailConfirmAfterPaymentReservationId() === reservationId;

          this.agendaDetailReservation.update((current) =>
            current && current.id === reservationId
              ? {
                  ...current,
                  paymentReceived: true,
                }
              : current,
          );

          this.loadReservations();
          this.loadCierreAutoDiario();

          if (shouldConfirmReservationAfterPayment) {
            this.agendaDetailConfirmAfterPaymentReservationId.set('');
            const assigneeEmail = this.agendaConfirmReservationWorkerEmail().trim().toLowerCase();
            queueMicrotask(() => {
              this.setReservationStatus(reservationId, 'accepted', assigneeEmail);
            });
          }
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.actionError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo actualizar el pago.',
          );

          if (this.agendaDetailConfirmAfterPaymentReservationId() === reservationId) {
            this.agendaDetailConfirmAfterPaymentReservationId.set('');
          }
        },
        complete: () => {
          this.actionLoadingId.set('');
        },
      });
  }

  protected closePaymentMethodModal(): void {
    this.showPaymentMethodModal.set(false);
    this.paymentMethodReservationId.set('');
    this.selectedPaymentMethod.set('');
    this.agendaDetailConfirmAfterPaymentReservationId.set('');
  }

  protected setReservationStatus(
    reservationId: string,
    status: 'accepted' | 'rejected',
    assigneeEmail = '',
  ): void {
    if (!this.requirePermission('reservas_gestionar', 'Aceptar / rechazar reservas')) return;
    this.actionError.set('');
    this.actionLoadingId.set(reservationId);

    const normalizedAssignee = assigneeEmail.trim().toLowerCase();

    this.http
      .patch<{ ok: boolean; error?: string }>(`/api/admin/reservas/${reservationId}/status`, {
        status,
        assigneeEmail: status === 'accepted' ? normalizedAssignee : undefined,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.actionError.set(response.error ?? 'No se pudo actualizar el estado.');
            return;
          }

          this.loadReservations();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.actionError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo actualizar el estado.',
          );
        },
        complete: () => {
          this.actionLoadingId.set('');
        },
      });
  }

  protected confirmReservationBySuperadmin(reservationId: string): void {
    if (!this.isSuperadmin()) {
      this.actionError.set('Solo superadmin puede confirmar directamente una cita.');
      return;
    }

    this.actionError.set('');
    this.actionLoadingId.set(reservationId);

    this.http
      .patch<{
        ok: boolean;
        error?: string;
      }>(`/api/admin/reservas/${reservationId}/client-confirmation`, {})
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.actionError.set(response.error ?? 'No se pudo confirmar la cita.');
            return;
          }

          this.loadReservations();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.actionError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo confirmar la cita.',
          );
        },
        complete: () => {
          this.actionLoadingId.set('');
        },
      });
  }

  protected editReservation(reservation: AdminReservationItem): void {
    if (typeof window === 'undefined') {
      return;
    }

    const nextDateIso = window.prompt('Nueva fecha (YYYY-MM-DD)', reservation.dateIso)?.trim();

    if (!nextDateIso) {
      return;
    }

    const nextStartTime = window.prompt('Nueva hora inicio (HH:mm)', reservation.startTime)?.trim();

    if (!nextStartTime) {
      return;
    }

    const nextDurationRaw = window
      .prompt('Nueva duración en minutos (múltiplos de 30)', `${reservation.durationMinutes}`)
      ?.trim();

    if (!nextDurationRaw) {
      return;
    }

    const nextDurationMinutes = Number(nextDurationRaw);

    if (!Number.isFinite(nextDurationMinutes) || nextDurationMinutes <= 0) {
      this.actionError.set('La duración debe ser un número válido en minutos.');
      return;
    }

    const nextAppointmentType = window
      .prompt('Servicio/pack', reservation.appointmentTypeName)
      ?.trim();

    if (!nextAppointmentType) {
      return;
    }

    this.actionError.set('');
    this.actionLoadingId.set(reservation.id);

    this.http
      .patch<{ ok: boolean; error?: string }>(`/api/admin/reservas/${reservation.id}`, {
        dateIso: nextDateIso,
        startTime: nextStartTime,
        durationMinutes: nextDurationMinutes,
        appointmentTypeName: nextAppointmentType,
        customerName: reservation.customerName,
        customerPhone: reservation.customerPhone,
        customerEmail: reservation.customerEmail,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.actionError.set(response.error ?? 'No se pudo modificar la reserva.');
            return;
          }

          this.loadReservations();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.actionError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo modificar la reserva.',
          );
        },
        complete: () => {
          this.actionLoadingId.set('');
        },
      });
  }

  protected getStatusLabel(status: AdminReservationItem['adminStatus']): string {
    if (status === 'accepted') {
      return 'Aceptada';
    }

    if (status === 'rejected') {
      return 'Rechazada';
    }

    return 'Pendiente';
  }

  protected getReservationAgendaStatusLabel(reservation: AdminReservationItem): string {
    if (reservation.clientConfirmationStatus === 'confirmed') {
      return 'Confirmada';
    }

    return this.getStatusLabel(reservation.adminStatus);
  }

  protected isReservationAgendaStatusAccepted(reservation: AdminReservationItem): boolean {
    return (
      reservation.clientConfirmationStatus === 'confirmed' || reservation.adminStatus === 'accepted'
    );
  }

  protected getClientConfirmationLabel(reservation: AdminReservationItem): string {
    if (reservation.adminStatus === 'rejected') {
      return 'No aplica';
    }

    return reservation.clientConfirmationStatus === 'confirmed' ? 'Confirmada' : 'Pendiente';
  }

  protected createBlockedPeriod(): void {
    if (!this.requirePermission('bloqueos_gestionar', 'Bloquear horas y días')) return;
    this.blockError.set('');
    this.blockMessage.set('');

    const dateIso = this.blockDateIso();
    const fullDayRange = this.getFullDayBlockRange(dateIso || this.getTodayIso());
    const startTime = this.isFullDayBlock() ? fullDayRange.startTime : this.blockStartTime();
    const endTime = this.isFullDayBlock() ? fullDayRange.endTime : this.blockEndTime();
    const reason = this.blockReason();

    if (!dateIso) {
      this.blockError.set('Debes seleccionar una fecha para bloquear.');
      return;
    }

    this.blockActionLoading.set(true);

    this.http
      .post<{ ok: boolean; error?: string }>('/api/admin/bloqueos', {
        dateIso,
        startTime,
        endTime,
        reason,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.blockError.set(response.error ?? 'No se pudo crear el bloqueo.');
            return;
          }

          this.blockMessage.set('Bloqueo guardado correctamente.');
          this.blockReason.set('');
          this.loadBlockedPeriods();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.blockError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo crear el bloqueo.',
          );
        },
        complete: () => {
          this.blockActionLoading.set(false);
        },
      });
  }

  protected deleteBlockedPeriod(blockId: string): void {
    this.blockError.set('');
    this.blockMessage.set('');
    this.blockActionLoading.set(true);

    this.http.delete<{ ok: boolean; error?: string }>(`/api/admin/bloqueos/${blockId}`).subscribe({
      next: (response) => {
        if (!response.ok) {
          this.blockError.set(response.error ?? 'No se pudo eliminar el bloqueo.');
          return;
        }

        this.blockMessage.set('Bloqueo eliminado.');
        this.loadBlockedPeriods();
      },
      error: (error) => {
        const apiError = error?.error?.error;
        this.blockError.set(
          typeof apiError === 'string' && apiError ? apiError : 'No se pudo eliminar el bloqueo.',
        );
      },
      complete: () => {
        this.blockActionLoading.set(false);
      },
    });
  }

  private loadReservations(): void {
    this.isLoadingReservations.set(true);
    this.listError.set('');

    this.http
      .get<{
        ok: boolean;
        reservations?: AdminReservationItem[];
        error?: string;
      }>('/api/admin/reservas')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.listError.set(response.error ?? 'No se pudieron cargar las reservas.');
            return;
          }

          this.reservations.set(
            (response.reservations ?? []).map((reservation) =>
              this.normalizeReservationTimeFields(reservation),
            ),
          );
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.listError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudieron cargar las reservas.',
          );
          this.isLoadingReservations.set(false);
        },
        complete: () => {
          this.isLoadingReservations.set(false);
        },
      });
  }

  private loadAgendaAlerts(): void {
    this.agendaAlertsLoading.set(true);
    this.agendaAlertsError.set('');

    this.http
      .get<{
        ok: boolean;
        alerts?: AgendaAlertItem[];
        error?: string;
      }>('/api/admin/alertas')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.agendaAlertsError.set(response.error ?? 'No se pudieron cargar las alertas.');
            return;
          }

          this.agendaAlerts.set(response.alerts ?? []);
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.agendaAlertsError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudieron cargar las alertas.',
          );
          this.agendaAlertsLoading.set(false);
        },
        complete: () => {
          this.agendaAlertsLoading.set(false);
        },
      });
  }

  private loadBlockedPeriods(): void {
    this.isLoadingBlockedPeriods.set(true);

    this.http
      .get<{
        ok: boolean;
        blockedPeriods?: AdminBlockedPeriodItem[];
        error?: string;
      }>('/api/admin/bloqueos')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.blockError.set(response.error ?? 'No se pudieron cargar los bloqueos.');
            return;
          }

          this.blockedPeriods.set(response.blockedPeriods ?? []);
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.blockError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudieron cargar los bloqueos.',
          );
          this.isLoadingBlockedPeriods.set(false);
        },
        complete: () => {
          this.isLoadingBlockedPeriods.set(false);
        },
      });
  }

  private loadStockProducts(): void {
    this.isLoadingStockProducts.set(true);

    this.http
      .get<{ ok: boolean; products?: StockProductItem[]; error?: string }>('/api/admin/almacen')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.stockError.set(response.error ?? 'No se pudo cargar el stock.');
            return;
          }

          const products = response.products ?? [];
          this.stockProducts.set(products);

          const selectedId = this.stockSaleProductId();
          const hasSelected = selectedId
            ? products.some((product) => product.id === selectedId && product.isSellable)
            : false;

          if (!hasSelected) {
            const firstSellable = products.find(
              (product) => product.isSellable && product.quantity > 0,
            );
            this.stockSaleProductId.set(firstSellable?.id ?? '');
          }
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.stockError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo cargar el stock.',
          );
        },
        complete: () => {
          this.isLoadingStockProducts.set(false);
        },
      });
  }

  // ── Cierre de caja ─────────────────────────────────────────────────────────

  protected onCierreEfectivoInput(event: Event): void {
    this.cierreEfectivo.set((event.target as HTMLInputElement).value);
  }

  protected onCierreTarjetaInput(event: Event): void {
    this.cierreTarjeta.set((event.target as HTMLInputElement).value);
  }

  protected onCierreBizumInput(event: Event): void {
    this.cierreBizum.set((event.target as HTMLInputElement).value);
  }

  protected onCierreNotasInput(event: Event): void {
    this.cierreNotas.set((event.target as HTMLTextAreaElement).value);
  }

  protected onCierreStatsRangeChange(event: Event): void {
    this.cierreStatsRange.set((event.target as HTMLSelectElement).value as CierreStatsRange);
  }

  protected onCierreStatsMetricChange(event: Event): void {
    this.cierreStatsMetric.set((event.target as HTMLSelectElement).value as CierreStatsMetric);
  }

  protected canExportLatestCierrePdf(): boolean {
    return this.cierreHistorial().length > 0;
  }

  protected exportLatestCierrePdf(): void {
    const latestCierre = this.cierreHistorial()[0];

    if (!latestCierre) {
      this.cierreError.set('No hay cierres registrados para exportar.');
      return;
    }

    if (typeof window === 'undefined') {
      this.cierreError.set('La exportación PDF solo está disponible en navegador.');
      return;
    }

    this.cierreError.set('');
    this.cierreMessage.set('Generando PDF...');
    void this.generateCierrePdf(latestCierre);
  }

  private async generateCierrePdf(cierre: CierreCajaItem): Promise<void> {
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
      const marginX = 46;
      let y = 58;
      const contentWidth = pdf.internal.pageSize.getWidth() - marginX * 2;

      const formatCurrency = (amount: number): string =>
        new Intl.NumberFormat('es-ES', {
          style: 'currency',
          currency: 'EUR',
          minimumFractionDigits: 2,
        }).format(amount);

      const fiscalStatus = cierre.enviadoAlServicioFiscal ? 'Enviado' : 'Pendiente';
      const notes = cierre.notas?.trim() || 'Sin observaciones.';
      const details = this.getSortedCierreOperationDetails(cierre);

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(20);
      pdf.text('Cierre de caja', marginX, y);
      y += 24;

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(11);
      pdf.setTextColor(90, 73, 63);
      pdf.text(
        `Fecha: ${cierre.fechaIso}  |  Registrado por: ${this.getWorkerDisplayName(cierre.registradoPorEmail)}`,
        marginX,
        y,
      );
      y += 28;

      pdf.setDrawColor(232, 216, 201);
      pdf.roundedRect(marginX, y, contentWidth, 120, 10, 10);

      const drawRow = (label: string, value: string, topY: number, isTotal = false): void => {
        pdf.setFont('helvetica', isTotal ? 'bold' : 'normal');
        pdf.setFontSize(isTotal ? 13 : 11);
        pdf.setTextColor(isTotal ? 183 : 47, isTotal ? 107 : 36, isTotal ? 84 : 29);
        pdf.text(label, marginX + 14, topY);
        pdf.text(value, marginX + contentWidth - 14, topY, { align: 'right' });
      };

      drawRow('Efectivo', formatCurrency(cierre.efectivo), y + 24);
      drawRow('Tarjeta', formatCurrency(cierre.tarjeta), y + 48);
      drawRow('Bizum', formatCurrency(cierre.bizum), y + 72);
      drawRow('Total', formatCurrency(cierre.total), y + 100, true);
      y += 150;

      pdf.setDrawColor(232, 216, 201);
      pdf.roundedRect(marginX, y, contentWidth, 78, 10, 10);
      pdf.setTextColor(47, 36, 29);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(11);
      pdf.text(`Estado fiscal: ${fiscalStatus}`, marginX + 14, y + 24);
      pdf.text(
        `ID servicio fiscal: ${cierre.idServicioFiscal || 'Pendiente'}`,
        marginX + 14,
        y + 44,
      );
      pdf.text(`Creado: ${this.formatDateTime(cierre.createdAtIso)}`, marginX + 14, y + 64);
      y += 102;

      const wrappedNotes = pdf.splitTextToSize(notes, contentWidth - 28) as string[];
      const notesHeight = Math.max(80, 38 + wrappedNotes.length * 16);
      pdf.setDrawColor(232, 216, 201);
      pdf.roundedRect(marginX, y, contentWidth, notesHeight, 10, 10);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Notas', marginX + 14, y + 24);
      pdf.setFont('helvetica', 'normal');
      pdf.text(wrappedNotes, marginX + 14, y + 46);

      y += notesHeight + 26;
      const pageHeight = pdf.internal.pageSize.getHeight();

      if (y > pageHeight - 110) {
        pdf.addPage();
        y = 58;
      }

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(14);
      pdf.setTextColor(47, 36, 29);
      pdf.text('Detalle de operaciones', marginX, y);
      y += 18;

      if (details.length === 0) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(11);
        pdf.setTextColor(90, 73, 63);
        pdf.text('No hay operaciones detalladas en este cierre.', marginX, y);
      } else {
        details.forEach((detail) => {
          if (y > pageHeight - 78) {
            pdf.addPage();
            y = 58;
          }

          const timestamp = this.formatDateTime(detail.createdAtIso);
          const line1 = `${timestamp} · ${detail.concept}`;
          const line2 = `${this.getPaymentMethodDisplayLabel(detail.paymentMethod)} · ${formatCurrency(detail.amount)} · ${this.getWorkerDisplayName(detail.performedByEmail)}`;

          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(10);
          pdf.setTextColor(47, 36, 29);
          pdf.text(line1, marginX, y);
          y += 13;
          pdf.setTextColor(90, 73, 63);
          pdf.text(line2, marginX, y);
          y += 14;
          pdf.setDrawColor(240, 229, 219);
          pdf.line(marginX, y, marginX + contentWidth, y);
          y += 10;
        });
      }

      const safeDate = (cierre.fechaIso || 'sin-fecha').replace(/[^\w-]/g, '-');
      pdf.save(`cierre-caja-${safeDate}.pdf`);
      this.cierreMessage.set('PDF exportado correctamente.');
    } catch (error) {
      console.error('[cierre-caja] Error generating PDF:', error);
      const openedPrintPreview = this.openCierrePrintPreview(cierre);

      if (openedPrintPreview) {
        this.cierreError.set('');
        this.cierreMessage.set('Se abrió una vista imprimible para guardar en PDF.');
        return;
      }

      this.cierreError.set('No se pudo generar el PDF en este navegador.');
      this.cierreMessage.set('');
    }
  }

  private openCierrePrintPreview(cierre: CierreCajaItem): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    const printWindow = window.open('', '_blank', 'noopener,noreferrer');
    if (!printWindow) {
      return false;
    }

    const html = this.buildCierrePdfHtml(cierre);
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();

    setTimeout(() => {
      try {
        printWindow.print();
      } catch {
        // If print fails, the user can still save manually from the opened tab.
      }
    }, 250);

    return true;
  }

  protected registrarCierre(): void {
    if (!this.requirePermission('cierre_registrar', 'Registrar cierre de caja')) return;

    if (this.cierreAlreadyClosedToday()) {
      this.cierreError.set(
        'Ya existe un cierre registrado para hoy. Revisa el historial para editarlo o anularlo.',
      );
      return;
    }

    this.cierreError.set('');
    this.cierreMessage.set('');

    const efectivo = parseFloat(this.cierreEfectivo()) || 0;
    const tarjeta = parseFloat(this.cierreTarjeta()) || 0;
    const bizum = parseFloat(this.cierreBizum()) || 0;

    if (efectivo < 0 || tarjeta < 0 || bizum < 0) {
      this.cierreError.set('Los importes no pueden ser negativos.');
      return;
    }

    this.cierreLoading.set(true);

    this.http
      .post<{ ok: boolean; cierre?: CierreCajaItem; error?: string }>('/api/admin/cierre-caja', {
        efectivo,
        tarjeta,
        bizum,
        notas: this.cierreNotas().trim(),
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.cierreError.set(response.error ?? 'No se pudo registrar el cierre.');
            return;
          }

          this.cierreMessage.set('Cierre registrado correctamente.');
          this.cierreAlreadyClosedToday.set(true);
          this.cierreAutoDiario.set(null);
          this.cierreEfectivo.set('');
          this.cierreTarjeta.set('');
          this.cierreBizum.set('');
          this.cierreNotas.set('');
          this.loadCierres();
          this.loadCierreAutoDiario();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.cierreError.set(
            typeof apiError === 'string' && apiError ? apiError : 'Error al registrar el cierre.',
          );
        },
        complete: () => {
          this.cierreLoading.set(false);
        },
      });
  }

  protected hasCierreAutoDiario(): boolean {
    return !!this.cierreAutoDiario();
  }

  protected applyCierreAutoDiarioToForm(): void {
    if (this.cierreAlreadyClosedToday()) {
      return;
    }

    const auto = this.cierreAutoDiario();

    if (!auto) {
      return;
    }

    this.cierreEfectivo.set(`${auto.efectivo}`);
    this.cierreTarjeta.set(`${auto.tarjeta}`);
    this.cierreBizum.set(`${auto.bizum}`);
    this.cierreMessage.set('Importes automáticos del día cargados en el formulario.');
  }

  protected getCierreStatsRangeLabel(): string {
    const range = this.cierreStatsRange();

    if (range === 'semana') {
      return 'Semana actual';
    }

    if (range === 'anio') {
      return 'Año actual';
    }

    return 'Mes actual';
  }

  protected getCierreStatsMetricLabel(): string {
    const metric = this.cierreStatsMetric();

    if (metric === 'efectivo') {
      return 'Solo efectivo';
    }

    if (metric === 'tarjeta') {
      return 'Solo tarjeta';
    }

    if (metric === 'bizum') {
      return 'Solo Bizum';
    }

    if (metric === 'digital') {
      return 'Tarjeta + Bizum';
    }

    return 'Total generado';
  }

  protected getCierreStatsEntries(): CierreCajaItem[] {
    return this.getFilteredCierreStatsItems();
  }

  protected getTodayCierre(): CierreCajaItem | null {
    const todayIso = this.getTodayIso();

    return this.cierreHistorial().find((cierre) => cierre.fechaIso === todayIso) ?? null;
  }

  protected getCierreStatsTotalAmount(): number {
    return this.getFilteredCierreStatsItems().reduce(
      (sum, cierre) => sum + this.getCierreMetricAmount(cierre, this.cierreStatsMetric()),
      0,
    );
  }

  protected getCierreStatsBreakdownRows(): RevenueCategoryRow[] {
    const cierres = this.getFilteredCierreStatsItems();
    const totalEfectivo = cierres.reduce((sum, cierre) => sum + cierre.efectivo, 0);
    const totalTarjeta = cierres.reduce((sum, cierre) => sum + cierre.tarjeta, 0);
    const totalBizum = cierres.reduce((sum, cierre) => sum + cierre.bizum, 0);
    const totals = [
      { name: 'Efectivo', amount: totalEfectivo },
      { name: 'Tarjeta', amount: totalTarjeta },
      { name: 'Bizum', amount: totalBizum },
    ].filter((row) => row.amount > 0);
    const total = totals.reduce((sum, row) => sum + row.amount, 0);
    const max = totals.reduce((highest, row) => Math.max(highest, row.amount), 0) || 1;

    return totals.map((row, index) => ({
      ...row,
      percentage: total === 0 ? 0 : Math.round((row.amount / total) * 100),
      color: this.clientTreatmentPalette[index % this.clientTreatmentPalette.length],
      heightPercent: row.amount === 0 ? 4 : Math.max(12, Math.round((row.amount / max) * 100)),
    }));
  }

  protected getCierreStatsPieData(): RevenuePieData {
    return this.buildRevenuePieData(this.getCierreStatsBreakdownRows());
  }

  protected getCierreStatsTimelineRows(): RevenueTimelineRow[] {
    const cierres = this.getFilteredCierreStatsItems();
    const grouping = this.getCierreStatsTimelineGrouping();

    if (cierres.length === 0) {
      return [];
    }

    const totalsByPeriod = new Map<string, number>();

    cierres.forEach((cierre) => {
      const date = new Date(`${cierre.fechaIso}T00:00:00`);
      const periodStart = this.getTimelinePeriodStart(date, grouping);
      const periodKey = this.getTimelinePeriodKey(periodStart, grouping);
      const amount = this.getCierreMetricAmount(cierre, this.cierreStatsMetric());
      totalsByPeriod.set(periodKey, (totalsByPeriod.get(periodKey) ?? 0) + amount);
    });

    const { startDate, endDate } = this.getCierreStatsDateRange();
    const startPeriod = this.getTimelinePeriodStart(startDate, grouping);
    const endPeriod = this.getTimelinePeriodStart(endDate, grouping);
    const cursor = new Date(startPeriod);
    const rows: Array<{ key: string; label: string; amount: number }> = [];

    while (cursor <= endPeriod) {
      const periodKey = this.getTimelinePeriodKey(cursor, grouping);
      rows.push({
        key: periodKey,
        label: this.formatTimelineLabel(cursor, grouping),
        amount: totalsByPeriod.get(periodKey) ?? 0,
      });
      this.incrementTimelineCursor(cursor, grouping);
    }

    const max = rows.reduce((highest, row) => Math.max(highest, row.amount), 0) || 1;
    const totalPoints = rows.length;

    return rows.map((row, index) => ({
      ...row,
      shortLabel: this.getTimelineShortLabel(row, grouping),
      tooltipLabel: this.getTimelineTooltipLabel(row, grouping),
      color: this.clientTreatmentPalette[index % this.clientTreatmentPalette.length],
      heightPercent: row.amount === 0 ? 4 : Math.max(12, Math.round((row.amount / max) * 100)),
      showLabel: this.shouldShowTimelineLabel(index, totalPoints, grouping),
    }));
  }

  protected getCierreStatsBarTicks(rows: Array<{ amount: number }>): number[] {
    const max = rows.reduce((highest, row) => Math.max(highest, row.amount), 0);

    if (max <= 0) {
      return [0, 0, 0, 0, 0];
    }

    const step = max / 4;
    return [max, step * 3, step * 2, step, 0];
  }

  protected getCierreStatsChartMinWidthRem(pointsCount: number): number {
    const grouping = this.getCierreStatsTimelineGrouping();

    if (grouping === 'day') {
      return Math.max(18, pointsCount * 2.9);
    }

    if (grouping === 'week') {
      return Math.max(18, pointsCount * 3.5);
    }

    return Math.max(18, pointsCount * 4.1);
  }

  protected getCierreStatsGroupingLabel(): string {
    const grouping = this.getCierreStatsTimelineGrouping();

    if (grouping === 'day') {
      return 'Días';
    }

    if (grouping === 'week') {
      return 'Semanas';
    }

    return 'Meses';
  }

  protected openCierreDetailsModal(cierre: CierreCajaItem): void {
    this.selectedCierreForDetails.set(cierre);
    this.cierreDetailsMethodFilters.set({
      efectivo: true,
      tarjeta: true,
      bizum: true,
    });
    this.cierreDetailsEmployeeFilter.set('all');
    this.showCierreDetailsModal.set(true);
  }

  protected closeCierreDetailsModal(): void {
    this.showCierreDetailsModal.set(false);
    this.selectedCierreForDetails.set(null);
    this.cierreDetailsEmployeeFilter.set('all');
  }

  protected onCierreDetailsMethodFilterChange(
    method: 'efectivo' | 'tarjeta' | 'bizum',
    event: Event,
  ): void {
    const target = event.target as HTMLInputElement;
    this.cierreDetailsMethodFilters.update((current) => ({
      ...current,
      [method]: target.checked,
    }));
  }

  protected onCierreDetailsEmployeeFilterInput(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.cierreDetailsEmployeeFilter.set(target.value || 'all');
  }

  protected clearCierreDetailsFilters(): void {
    this.cierreDetailsMethodFilters.set({
      efectivo: true,
      tarjeta: true,
      bizum: true,
    });
    this.cierreDetailsEmployeeFilter.set('all');
  }

  protected getCierreDetailsEmployeeOptions(): string[] {
    const cierre = this.selectedCierreForDetails();
    const options = new Set<string>();

    (cierre?.operationDetails ?? []).forEach((detail) => {
      const email = (detail.performedByEmail || '').trim().toLowerCase();
      if (email) {
        options.add(email);
      }
    });

    return Array.from(options).sort((a, b) => a.localeCompare(b, 'es'));
  }

  protected getSelectedCierreDetailItems(): CierreOperationDetailItem[] {
    const cierre = this.selectedCierreForDetails();
    const filters = this.cierreDetailsMethodFilters();
    const employeeFilter = this.cierreDetailsEmployeeFilter();

    if (!cierre) {
      return [];
    }

    return this.getSortedCierreOperationDetails(cierre).filter((detail) => {
      if (!filters[detail.paymentMethod]) {
        return false;
      }

      if (employeeFilter !== 'all' && detail.performedByEmail !== employeeFilter) {
        return false;
      }

      return true;
    });
  }

  protected getSelectedCierreDetailsFilteredTotal(): number {
    return this.getSelectedCierreDetailItems().reduce((sum, detail) => sum + detail.amount, 0);
  }

  protected getPaymentMethodDisplayLabel(method: 'efectivo' | 'tarjeta' | 'bizum'): string {
    if (method === 'tarjeta') {
      return 'Tarjeta';
    }

    if (method === 'bizum') {
      return 'Bizum';
    }

    return 'Efectivo';
  }

  private getSortedCierreOperationDetails(cierre: CierreCajaItem): CierreOperationDetailItem[] {
    return (cierre.operationDetails ?? [])
      .filter((detail) => Number.isFinite(detail.amount) && detail.amount > 0)
      .slice()
      .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
  }

  // ── Editar / borrar cierre ─────────────────────────────────────────────────

  protected openEditCierre(cierre: CierreCajaItem): void {
    this.editingCierre.set(cierre);
    this.editCierreEfectivo.set(`${cierre.efectivo}`);
    this.editCierreTarjeta.set(`${cierre.tarjeta}`);
    this.editCierreBizum.set(`${cierre.bizum}`);
    this.editCierreNotas.set(cierre.notas ?? '');
    this.editCierreError.set('');
  }

  protected closeEditCierre(): void {
    this.editingCierre.set(null);
    this.editCierreError.set('');
  }

  protected saveEditCierre(): void {
    const cierre = this.editingCierre();
    if (!cierre) return;

    const ef = parseFloat(this.editCierreEfectivo().replace(',', '.'));
    const ta = parseFloat(this.editCierreTarjeta().replace(',', '.'));
    const bi = parseFloat(this.editCierreBizum().replace(',', '.'));

    if (!Number.isFinite(ef) || !Number.isFinite(ta) || !Number.isFinite(bi)) {
      this.editCierreError.set('Los importes deben ser números válidos.');
      return;
    }
    if (ef < 0 || ta < 0 || bi < 0) {
      this.editCierreError.set('Los importes no pueden ser negativos.');
      return;
    }

    this.editCierreLoading.set(true);
    this.editCierreError.set('');

    this.http
      .patch<{ ok: boolean; cierre?: CierreCajaItem; error?: string }>(
        `/api/admin/cierre-caja/${encodeURIComponent(cierre.id)}`,
        {
          efectivo: ef,
          tarjeta: ta,
          bizum: bi,
          notas: this.editCierreNotas().trim(),
        },
      )
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.editCierreError.set(response.error ?? 'No se pudo guardar el cierre.');
            return;
          }
          this.cierreMessage.set('Cierre actualizado correctamente.');
          this.closeEditCierre();
          this.loadCierres();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.editCierreError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo guardar el cierre.',
          );
        },
        complete: () => {
          this.editCierreLoading.set(false);
        },
      });
  }

  protected confirmDeleteCierre(cierreId: string): void {
    this.deletingCierreId.set(cierreId);
  }

  protected cancelDeleteCierre(): void {
    this.deletingCierreId.set('');
  }

  protected executeDeleteCierre(): void {
    const id = this.deletingCierreId();
    if (!id) return;

    this.deleteCierreLoading.set(true);

    this.http
      .delete<{ ok: boolean; error?: string }>(`/api/admin/cierre-caja/${encodeURIComponent(id)}`)
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.cierreError.set(response.error ?? 'No se pudo eliminar el cierre.');
            return;
          }
          this.cierreMessage.set('Cierre eliminado correctamente.');
          this.deletingCierreId.set('');
          this.loadCierres();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.cierreError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo eliminar el cierre.',
          );
          this.deletingCierreId.set('');
        },
        complete: () => {
          this.deleteCierreLoading.set(false);
        },
      });
  }

  private loadCierres(): void {
    this.isLoadingCierres.set(true);

    this.http
      .get<{ ok: boolean; cierres?: CierreCajaItem[]; error?: string }>('/api/admin/cierre-caja')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.cierreError.set(response.error ?? 'No se pudo cargar el historial.');
            return;
          }

          this.cierreHistorial.set(response.cierres ?? []);
        },
        error: () => {
          this.cierreError.set('No se pudo cargar el historial de cierres.');
        },
        complete: () => {
          this.isLoadingCierres.set(false);
        },
      });
  }

  private loadCierreAutoDiario(): void {
    this.isLoadingCierreAutoDiario.set(true);
    this.cierreAlreadyClosedToday.set(false);

    this.http
      .get<{
        ok: boolean;
        today?: CierreAutoDiario;
        alreadyClosed?: boolean;
        error?: string;
      }>('/api/admin/cierre-caja/auto-diario')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            return;
          }

          this.cierreAlreadyClosedToday.set(response.alreadyClosed === true);
          this.cierreAutoDiario.set(response.alreadyClosed ? null : (response.today ?? null));
          if (response.alreadyClosed) {
            this.cierreMessage.set(
              'Hoy ya existe un cierre registrado. Puedes verlo o editarlo desde Historial.',
            );
          }
        },
        error: () => {
          // silencioso para no molestar el flujo principal de cierre
        },
        complete: () => {
          this.isLoadingCierreAutoDiario.set(false);
        },
      });
  }

  private getFilteredCierreStatsItems(): CierreCajaItem[] {
    const { startDate, endDate } = this.getCierreStatsDateRange();
    const startTime = startDate.getTime();
    const endTime = endDate.getTime();

    return this.cierreHistorial().filter((cierre) => {
      const cierreDate = new Date(`${cierre.fechaIso}T00:00:00`);
      const time = cierreDate.getTime();
      return Number.isFinite(time) && time >= startTime && time <= endTime;
    });
  }

  private getCierreStatsDateRange(): { startDate: Date; endDate: Date } {
    const today = new Date();
    const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const range = this.cierreStatsRange();

    if (range === 'semana') {
      const weekDay = startDate.getDay();
      const diffToMonday = weekDay === 0 ? -6 : 1 - weekDay;
      startDate.setDate(startDate.getDate() + diffToMonday);
      endDate.setTime(startDate.getTime());
      endDate.setDate(startDate.getDate() + 6);
      return { startDate, endDate };
    }

    if (range === 'anio') {
      startDate.setMonth(0, 1);
      endDate.setMonth(11, 31);
      return { startDate, endDate };
    }

    startDate.setDate(1);
    endDate.setMonth(endDate.getMonth() + 1, 0);
    return { startDate, endDate };
  }

  private getCierreStatsTimelineGrouping(): GlobalTreatmentTimelineGrouping {
    const range = this.cierreStatsRange();

    if (range === 'semana') {
      return 'day';
    }

    if (range === 'anio') {
      return 'month';
    }

    return 'week';
  }

  private getCierreMetricAmount(cierre: CierreCajaItem, metric: CierreStatsMetric): number {
    if (metric === 'efectivo') {
      return cierre.efectivo;
    }

    if (metric === 'tarjeta') {
      return cierre.tarjeta;
    }

    if (metric === 'bizum') {
      return cierre.bizum;
    }

    if (metric === 'digital') {
      return cierre.tarjeta + cierre.bizum;
    }

    return cierre.total;
  }

  private buildRevenuePieData(rows: RevenueCategoryRow[]): RevenuePieData {
    const total = rows.reduce((sum, row) => sum + row.amount, 0);

    if (total === 0) {
      return {
        total: 0,
        gradient: '',
        slices: [],
      };
    }

    let currentAngle = 0;
    const gradient = `conic-gradient(${rows
      .map((slice) => {
        const start = currentAngle;
        currentAngle += (slice.amount / total) * 360;
        return `${slice.color} ${start}deg ${currentAngle}deg`;
      })
      .join(', ')})`;

    return {
      total,
      gradient,
      slices: rows,
    };
  }

  private buildCierrePdfHtml(cierre: CierreCajaItem): string {
    const escapeHtml = (value: string): string =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

    const formatCurrency = (amount: number): string =>
      new Intl.NumberFormat('es-ES', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 2,
      }).format(amount);

    const fiscalStatus = cierre.enviadoAlServicioFiscal ? 'Enviado' : 'Pendiente';
    const details = this.getSortedCierreOperationDetails(cierre);
    const detailRows =
      details.length === 0
        ? '<p class="note">No hay operaciones detalladas en este cierre.</p>'
        : `<table class="detail-table"><thead><tr><th>Fecha y hora</th><th>Operación</th><th>Método</th><th>Importe</th><th>Realizada por</th></tr></thead><tbody>${details
            .map(
              (detail) =>
                `<tr><td>${escapeHtml(this.formatDateTime(detail.createdAtIso))}</td><td>${escapeHtml(detail.concept)}</td><td>${escapeHtml(this.getPaymentMethodDisplayLabel(detail.paymentMethod))}</td><td><strong>${escapeHtml(formatCurrency(detail.amount))}</strong></td><td>${escapeHtml(this.getWorkerDisplayName(detail.performedByEmail))}</td></tr>`,
            )
            .join('')}</tbody></table>`;

    return `<!doctype html>
      <html lang="es">
        <head>
          <meta charset="utf-8" />
          <title>Cierre de caja ${escapeHtml(cierre.fechaIso)}</title>
          <style>
            body { font-family: Arial, Helvetica, sans-serif; margin: 32px; color: #2f241d; }
            h1 { margin: 0 0 8px; color: #b76b54; }
            p { margin: 0 0 8px; }
            .meta { margin-bottom: 24px; color: #6e5b4f; }
            .card { border: 1px solid #e8d8c9; border-radius: 16px; padding: 18px; margin-bottom: 16px; }
            .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0e5db; }
            .row:last-child { border-bottom: 0; }
            .total { font-size: 18px; font-weight: 700; color: #b76b54; }
            .note { white-space: pre-wrap; }
            .detail-table { width: 100%; border-collapse: collapse; margin-top: 6px; }
            .detail-table th, .detail-table td { text-align: left; font-size: 12px; padding: 8px 6px; border-bottom: 1px solid #f0e5db; vertical-align: top; }
            .detail-table th { color: #6e5b4f; font-weight: 700; }
          </style>
        </head>
        <body>
          <h1>Cierre de caja</h1>
          <p class="meta">Fecha: ${escapeHtml(cierre.fechaIso)} · Registrado por: ${escapeHtml(this.getWorkerDisplayName(cierre.registradoPorEmail))}</p>
          <div class="card">
            <div class="row"><span>Efectivo</span><strong>${formatCurrency(cierre.efectivo)}</strong></div>
            <div class="row"><span>Tarjeta</span><strong>${formatCurrency(cierre.tarjeta)}</strong></div>
            <div class="row"><span>Bizum</span><strong>${formatCurrency(cierre.bizum)}</strong></div>
            <div class="row total"><span>Total</span><strong>${formatCurrency(cierre.total)}</strong></div>
          </div>
          <div class="card">
            <p><strong>Estado fiscal:</strong> ${escapeHtml(fiscalStatus)}</p>
            <p><strong>ID servicio fiscal:</strong> ${escapeHtml(cierre.idServicioFiscal || 'Pendiente')}</p>
            <p><strong>Creado:</strong> ${escapeHtml(this.formatDateTime(cierre.createdAtIso))}</p>
          </div>
          <div class="card">
            <p><strong>Notas</strong></p>
            <p class="note">${escapeHtml(cierre.notas || 'Sin observaciones.')}</p>
          </div>
          <div class="card">
            <p><strong>Detalle de operaciones</strong></p>
            ${detailRows}
          </div>
        </body>
      </html>`;
  }

  private loadClientCards(): void {
    this.isLoadingClientCards.set(true);
    this.clientCardsError.set('');

    this.http
      .get<{ ok: boolean; cards?: ClientCardItem[]; error?: string }>('/api/admin/clientes')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.clientCardsError.set(response.error ?? 'No se pudieron cargar las fichas.');
            return;
          }

          const cards = response.cards ?? [];
          this.clientCards.set(cards);

          if (this.selectedClientId()) {
            const stillExists = cards.some((card) => card.id === this.selectedClientId());

            if (!stillExists) {
              this.closeClientDetailModal();
            } else {
              const selectedCard =
                cards.find((card) => card.id === this.selectedClientId()) ?? null;

              if (selectedCard) {
                this.clientEditFullName.set(selectedCard.fullName);
                this.clientEditEmail.set(selectedCard.email);
                this.clientEditPhone.set(selectedCard.phone);
                this.clientEditBirthDateIso.set(selectedCard.birthDateIso ?? '');
                this.clientEditNotes.set(selectedCard.notes ?? '');
              }
            }
          }
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.clientCardsError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudieron cargar las fichas.',
          );
        },
        complete: () => {
          this.isLoadingClientCards.set(false);
        },
      });
  }

  ngOnDestroy(): void {
    if (this.inactivityTimer) {
      clearInterval(this.inactivityTimer);
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('arena-admin-return-home', this.onReturnHomeFromHeader);
    }
  }

  private startInactivityWatcher(): void {
    this.lastActivityMs = Date.now();
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    const reset = () => {
      this.lastActivityMs = Date.now();
      this.showInactivityWarning.set(false);
    };
    events.forEach((e) => document.addEventListener(e, reset, { passive: true }));
    this.inactivityTimer = setInterval(() => {
      const idle = Date.now() - this.lastActivityMs;
      if (idle >= this.INACTIVITY_MS) {
        this.logout();
      } else if (idle >= this.WARNING_MS) {
        this.showInactivityWarning.set(true);
      }
    }, 15_000);
  }

  private checkForcedCheckIn(): void {
    this.http
      .get<{ ok: boolean; tracking?: { lastCheckInIso?: string } }>('/api/empleado/fichaje')
      .subscribe({
        next: (res) => {
          if (!res.ok) return;
          const todayIso = this.getTodayIso();
          const lastCheckIn = res.tracking?.lastCheckInIso ?? '';
          const checkedInToday = lastCheckIn.startsWith(todayIso);
          if (!checkedInToday) {
            this.showForcedCheckInModal.set(true);
          }
        },
      });
  }

  protected performForcedCheckIn(): void {
    this.forcedCheckInLoading.set(true);
    this.forcedCheckInError.set('');
    this.http
      .post<{ ok: boolean; error?: string }>('/api/empleado/fichaje', { action: 'check_in' })
      .subscribe({
        next: (res) => {
          if (res.ok) {
            this.showForcedCheckInModal.set(false);
          } else {
            this.forcedCheckInError.set(res.error ?? 'Error al fichar entrada.');
          }
        },
        error: () => {
          this.forcedCheckInError.set('No se pudo conectar con el servidor.');
        },
        complete: () => {
          this.forcedCheckInLoading.set(false);
        },
      });
  }

  protected dismissInactivityWarning(): void {
    this.lastActivityMs = Date.now();
    this.showInactivityWarning.set(false);
  }

  protected logout(): void {
    this.http.post<{ ok: boolean }>('/api/auth/logout', {}).subscribe({
      complete: () => {
        void this.router.navigate(['/acceso']);
      },
    });
  }

  // ── Permisos ───────────────────────────────────────────────────────────────

  protected canAccessAdminCard(target: AdminCardTarget): boolean {
    if (this.isSuperadmin()) {
      return true;
    }

    switch (target) {
      case 'packs':
      case 'reservas':
        return this.hasPermission('reservas_ver');
      case 'agenda':
        return this.hasPermission('agenda_ver');
      case 'clientes':
        return this.hasPermission('clientes_gestionar');
      case 'almacen':
        return this.hasPermission('almacen_gestionar');
      case 'cierre':
        return this.hasPermission('cierre_registrar');
      default:
        return false;
    }
  }

  protected canAccessAdminTab(tab: AdminTab): boolean {
    if (this.isSuperadmin()) {
      return true;
    }

    switch (tab) {
      case 'home':
      case 'ayuda':
        return true;
      case 'agenda':
        return this.hasPermission('agenda_ver');
      case 'clientes':
        return this.hasPermission('clientes_gestionar');
      case 'estadisticas':
        return this.hasPermission('estadisticas_ver');
      case 'almacen':
        return this.hasPermission('almacen_gestionar');
      case 'cierre':
        return this.hasPermission('cierre_registrar');
      case 'empleados':
        return false;
      default:
        return false;
    }
  }

  protected getAdminCardActionLabel(target: AdminCardTarget): string {
    switch (target) {
      case 'packs':
        return 'Acceder a packs y tratamientos';
      case 'reservas':
        return 'Acceder a reservas';
      case 'agenda':
        return 'Acceder a la agenda';
      case 'clientes':
        return 'Acceder a ficha de cliente';
      case 'almacen':
        return 'Acceder al almacen';
      case 'cierre':
        return 'Acceder al cierre de caja';
      default:
        return 'Acceder a esta seccion';
    }
  }

  protected getAdminTabActionLabel(tab: AdminTab): string {
    switch (tab) {
      case 'agenda':
        return 'Acceder a la agenda';
      case 'clientes':
        return 'Acceder a ficha de cliente';
      case 'estadisticas':
        return 'Acceder a estadisticas';
      case 'almacen':
        return 'Acceder al almacen';
      case 'cierre':
        return 'Acceder al cierre de caja';
      case 'empleados':
        return 'Gestionar empleados';
      default:
        return 'Acceder a esta seccion';
    }
  }

  protected hasPermission(perm: EmployeePermission): boolean {
    if (this.isSuperadmin()) return true;
    return this.myPermissions().includes(perm);
  }

  protected requirePermission(perm: EmployeePermission, label: string): boolean {
    if (this.hasPermission(perm)) return true;
    this.openNoPermissionModal(label);
    return false;
  }

  protected openNoPermissionModal(label: string): void {
    this.noPermissionActionLabel.set(label);
    this.showNoPermissionModal.set(true);
  }

  protected closeNoPermissionModal(): void {
    this.showNoPermissionModal.set(false);
    this.noPermissionActionLabel.set('');
  }

  protected onEmployeeCreatePermissionsChange(perms: EmployeePermission[]): void {
    this.employeeCreatePermissions.set(perms);
  }

  private getEmployeeCreateFieldErrors(
    username: string,
    email: string,
    password: string,
  ): EmployeeCreateFieldErrors {
    const usernameError = !username
      ? 'El usuario es obligatorio.'
      : username.length < 3 || username.length > 40
        ? 'El usuario debe tener entre 3 y 40 caracteres.'
        : '';

    const emailError = !email
      ? 'El email es obligatorio.'
      : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
        ? 'Introduce un email con formato válido.'
        : '';

    const passwordError = !password
      ? 'La contraseña es obligatoria.'
      : password.length < 8
        ? 'La contraseña debe tener al menos 8 caracteres.'
        : !/[A-Z]/.test(password) || !/[^A-Za-z0-9]/.test(password)
          ? 'Debe incluir una mayúscula y un carácter especial.'
          : '';

    return {
      username: usernameError,
      email: emailError,
      password: passwordError,
    };
  }

  private updateEmployeeCreateFieldError(
    field: keyof EmployeeCreateFieldErrors,
    rawValue: string,
  ): void {
    const nextValue = rawValue.trim();
    const errors = this.employeeCreateFieldErrors();

    if (!errors[field] && !this.employeeError()) {
      return;
    }

    const nextErrors = this.getEmployeeCreateFieldErrors(
      field === 'username' ? nextValue : this.employeeCreateUsername().trim(),
      field === 'email' ? nextValue : this.employeeCreateEmail().trim(),
      field === 'password' ? rawValue : this.employeeCreatePassword(),
    );

    this.employeeCreateFieldErrors.set(nextErrors);

    if (!Object.values(nextErrors).some(Boolean) && this.employeeError()) {
      this.employeeError.set('');
    }
  }

  private resetEmployeeCreateFieldErrors(): void {
    this.employeeCreateFieldErrors.set({
      username: '',
      email: '',
      password: '',
    });
  }

  private applyEmployeeCreateApiError(errorMessage: string): void {
    const normalized = errorMessage.toLocaleLowerCase('es');
    const current = this.employeeCreateFieldErrors();

    if (normalized.includes('email')) {
      this.employeeCreateFieldErrors.set({
        ...current,
        email: errorMessage,
      });
      return;
    }

    if (normalized.includes('usuario')) {
      this.employeeCreateFieldErrors.set({
        ...current,
        username: errorMessage,
      });
      return;
    }

    if (normalized.includes('contraseña')) {
      this.employeeCreateFieldErrors.set({
        ...current,
        password: errorMessage,
      });
    }
  }

  protected openEditPermissions(user: AdminEmployeeUser): void {
    this.editingPermissionsEmail.set(user.email);
    this.editingPermissions.set([...(user.permissions ?? [])]);
  }

  protected closeEditPermissions(): void {
    this.editingPermissionsEmail.set('');
    this.editingPermissions.set([]);
  }

  protected toggleEditPermission(perm: EmployeePermission): void {
    const current = this.editingPermissions();
    const next = current.includes(perm) ? current.filter((p) => p !== perm) : [...current, perm];
    this.editingPermissions.set(next);
  }

  protected selectAllEditPermissions(): void {
    this.editingPermissions.set([...ALL_PERMISSIONS]);
  }

  protected clearAllEditPermissions(): void {
    this.editingPermissions.set([]);
  }

  protected saveEmployeePermissions(): void {
    const email = this.editingPermissionsEmail();
    const permissions = this.editingPermissions();

    if (!email) return;

    this.savingPermissions.set(true);
    this.employeeError.set('');

    this.http
      .patch<{
        ok: boolean;
        error?: string;
      }>(`/api/admin/empleados/${encodeURIComponent(email)}/permissions`, { permissions })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.employeeError.set(response.error ?? 'No se pudieron guardar los permisos.');
            return;
          }
          this.employeeMessage.set('Permisos actualizados correctamente.');
          this.closeEditPermissions();
          this.loadEmployeeUsers();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.employeeError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudieron guardar los permisos.',
          );
        },
        complete: () => {
          this.savingPermissions.set(false);
        },
      });
  }

  protected readonly allPermissionsList = ALL_PERMISSIONS;
  protected readonly permissionLabels = PERMISSION_LABELS;

  private loadEmployeeUsers(): void {
    if (!this.ownerEmail()) {
      return;
    }

    this.isLoadingEmployees.set(true);
    this.employeeError.set('');

    this.http
      .get<{ ok: boolean; users?: AdminEmployeeUser[]; error?: string }>('/api/admin/empleados')
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.employeeError.set(response.error ?? 'No se pudo cargar la gestión de empleados.');
            return;
          }

          const users = response.users ?? [];
          this.employeeUsers.set(users);
          this.syncSuperadminCredentialsDraft(users);

          const selectableUsers = users.filter((user) => user.role !== 'superadmin');
          const selectedEmail = this.selectedEmployeeEmail();
          const hasCurrentSelection = selectableUsers.some((user) => user.email === selectedEmail);

          if (!hasCurrentSelection) {
            this.selectedEmployeeEmail.set(selectableUsers[0]?.email ?? '');

            if (this.showEmployeeDetailModal()) {
              this.closeEmployeeDetailModal();
            }
          }
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.employeeError.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo cargar la gestión de empleados.',
          );
        },
        complete: () => {
          this.isLoadingEmployees.set(false);
        },
      });
  }

  private syncSuperadminCredentialsDraft(users: AdminEmployeeUser[]): void {
    const superadmin = users.find((user) => user.role === 'superadmin');

    if (!superadmin) {
      return;
    }

    this.superadminEditUsername.set(superadmin.username);
    this.superadminEditEmail.set(superadmin.email);

    if (!this.ownerEmail()) {
      this.ownerEmail.set(superadmin.email);
    }

    if (!this.ownerUsername()) {
      this.ownerUsername.set(superadmin.username);
    }
  }

  private updateEmployeeRole(email: string, role: 'admin' | 'client'): void {
    this.employeeError.set('');
    this.employeeMessage.set('');
    this.employeeActionLoadingEmail.set(email);

    this.http
      .patch<{
        ok: boolean;
        error?: string;
      }>(`/api/admin/empleados/${encodeURIComponent(email)}/rol`, { role })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.employeeError.set(response.error ?? 'No se pudo actualizar el rol.');
            return;
          }

          this.employeeMessage.set('Rol actualizado correctamente.');
          this.loadEmployeeUsers();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.employeeError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo actualizar el rol.',
          );
        },
        complete: () => {
          this.employeeActionLoadingEmail.set('');
        },
      });
  }

  private openRoleChangeConfirm(email: string, role: 'admin' | 'client'): void {
    this.roleChangeTargetEmail.set(email);
    this.roleChangeTargetRole.set(role);
    this.showRoleChangeConfirmModal.set(true);
  }

  private buildEmployeeTrackingCalendarNote(
    action: EmployeeTrackingCalendarAction,
    startDateIso: string,
    endDateIso: string,
  ): string {
    const fromLabel = this.formatDate(startDateIso);
    const toLabel = endDateIso ? this.formatDate(endDateIso) : '';
    let baseNote = '';

    if (action === 'vacation') {
      baseNote = `Vacaciones del ${fromLabel} al ${toLabel}`;
    } else if (action === 'sick_leave') {
      baseNote = endDateIso
        ? `Baja desde ${fromLabel} hasta ${toLabel}`
        : `Baja desde ${fromLabel}`;
    } else {
      baseNote =
        !endDateIso || startDateIso === endDateIso
          ? `Recuperación de horas el ${fromLabel}`
          : `Recuperación de horas del ${fromLabel} al ${toLabel}`;
    }

    const quickNote = this.getEmployeeTrackingNote(this.employeeTrackingCalendarEmail()).trim();

    if (!quickNote) {
      return baseNote.slice(0, 160);
    }

    return `${baseNote} · ${quickNote}`.slice(0, 160);
  }

  private getRoleChangeCurrentRoleLabel(): 'admin' | 'empleado' {
    const email = this.roleChangeTargetEmail();
    const user = this.employeeUsers().find((item) => item.email === email);

    return user?.role === 'admin' ? 'admin' : 'empleado';
  }

  private getRoleChangeTargetRoleLabel(): 'admin' | 'empleado' {
    return this.roleChangeTargetRole() === 'admin' ? 'admin' : 'empleado';
  }

  private getWeekStartIso(baseDateIso: string): string {
    const baseDate = new Date(`${baseDateIso}T00:00:00`);

    if (Number.isNaN(baseDate.getTime())) {
      return this.getTodayIso();
    }

    const weekDay = baseDate.getDay();
    const diffToMonday = weekDay === 0 ? -6 : 1 - weekDay;
    const monday = new Date(baseDate);
    monday.setDate(baseDate.getDate() + diffToMonday);

    return this.toDateIso(monday);
  }

  private shiftAgendaWeek(offsetDays: number): void {
    const weekStartIso = this.agendaWeekStartIso();

    if (!weekStartIso) {
      this.agendaWeekStartIso.set(this.getWeekStartIso(this.getTodayIso()));
      return;
    }

    const current = new Date(`${weekStartIso}T00:00:00`);

    if (Number.isNaN(current.getTime())) {
      this.agendaWeekStartIso.set(this.getWeekStartIso(this.getTodayIso()));
      return;
    }

    current.setDate(current.getDate() + offsetDays);
    this.agendaWeekStartIso.set(this.toDateIso(current));
  }

  private persistAgendaPreferredView(view: AgendaPreferredView): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(this.agendaPreferredViewStorageKey, view);
  }

  private getAgendaPreferredView(): AgendaPreferredView {
    if (typeof window === 'undefined') {
      return 'week';
    }

    const rawValue = window.localStorage.getItem(this.agendaPreferredViewStorageKey);
    return rawValue === 'month' ? 'month' : 'week';
  }

  private persistCierreManagementTab(tab: CierreManagementTab): void {
    if (!this.canUseLocalStorage()) {
      return;
    }

    window.localStorage.setItem(this.cierreManagementTabStorageKey, tab);
  }

  private getPreferredCierreManagementTab(): CierreManagementTab {
    if (!this.canUseLocalStorage()) {
      return 'registro';
    }

    const rawValue = window.localStorage.getItem(this.cierreManagementTabStorageKey);

    if (rawValue === 'historial' || rawValue === 'estadisticas') {
      return rawValue;
    }

    return 'registro';
  }

  private shiftAgendaCalendarMonth(offset: number): void {
    const monthIso = this.agendaCalendarMonthIso();

    if (!monthIso) {
      return;
    }

    const [yearRaw, monthRaw] = monthIso.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);

    if (Number.isNaN(year) || Number.isNaN(month)) {
      return;
    }

    const targetDate = new Date(year, month - 1 + offset, 1);
    const targetYear = targetDate.getFullYear();
    const targetMonth = `${targetDate.getMonth() + 1}`.padStart(2, '0');
    this.agendaCalendarMonthIso.set(`${targetYear}-${targetMonth}`);
  }

  private hasReservationConflict(
    dateIso: string,
    startTime: string,
    durationMinutes: number,
    excludeReservationId: string,
    workerEmail?: string | null,
  ): boolean {
    const candidateStartMinutes = this.parseTimeToMinutes(startTime);
    const candidateEndMinutes = candidateStartMinutes + durationMinutes;
    const workerKey = this.getReservationWorkerKey(workerEmail);

    const overlappingReservations = this.reservations().filter((reservation) => {
      if (
        reservation.id === excludeReservationId ||
        reservation.dateIso !== dateIso ||
        reservation.adminStatus === 'rejected'
      ) {
        return false;
      }

      const existingStartMinutes = this.parseTimeToMinutes(reservation.startTime);
      const existingEndMinutes = this.parseTimeToMinutes(reservation.endTime);

      return (
        candidateStartMinutes < existingEndMinutes && candidateEndMinutes > existingStartMinutes
      );
    });

    if (overlappingReservations.length >= this.getAgendaMaxConcurrentReservations()) {
      return true;
    }

    if (workerKey === '__sin_asignar__') {
      return false;
    }

    return overlappingReservations.some(
      (reservation) => this.getReservationWorkerKey(reservation.createdByEmail) === workerKey,
    );
  }

  private parseTimeToMinutes(time: string): number {
    const [hoursRaw, minutesRaw] = time.split(':');
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);

    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return 0;
    }

    return hours * 60 + minutes;
  }

  private formatMinutesToTime(totalMinutes: number): string {
    const safeMinutes = Math.max(0, totalMinutes);
    const hours = Math.floor(safeMinutes / 60)
      .toString()
      .padStart(2, '0');
    const minutes = (safeMinutes % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  private updateReservationSchedule(
    reservation: AdminReservationItem,
    nextDateIso: string,
    nextStartTime: string,
    nextDurationMinutes: number,
  ): void {
    this.agendaDayScheduleError.set('');
    this.actionError.set('');
    this.agendaDayScheduleLoadingReservationId.set(reservation.id);

    this.http
      .patch<{ ok: boolean; error?: string }>(`/api/admin/reservas/${reservation.id}`, {
        dateIso: nextDateIso,
        startTime: nextStartTime,
        durationMinutes: nextDurationMinutes,
        appointmentTypeName: reservation.appointmentTypeName,
        customerName: reservation.customerName,
        customerPhone: reservation.customerPhone,
        customerEmail: reservation.customerEmail,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.showAgendaDropToast(`⚠️ ${response.error ?? 'No se pudo actualizar la cita.'}`);
            return;
          }

          this.reservations.update((items) =>
            items.map((item) => {
              if (item.id !== reservation.id) {
                return item;
              }

              const nextEndTime = this.formatMinutesToTime(
                this.parseTimeToMinutes(nextStartTime) + nextDurationMinutes,
              );

              return {
                ...item,
                dateIso: nextDateIso,
                startTime: nextStartTime,
                durationMinutes: nextDurationMinutes,
                endTime: nextEndTime,
              };
            }),
          );

          this.loadReservations();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.showAgendaDropToast(
            `⚠️ ${typeof apiError === 'string' && apiError ? apiError : 'No se pudo actualizar la cita.'}`,
          );
        },
        complete: () => {
          this.agendaDayScheduleLoadingReservationId.set('');
          this.agendaDraggedReservationId.set('');
        },
      });
  }

  private shiftCalendarMonth(offset: number): void {
    const monthIso = this.calendarMonthIso();

    if (!monthIso) {
      return;
    }

    const [yearRaw, monthRaw] = monthIso.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);

    if (Number.isNaN(year) || Number.isNaN(month)) {
      return;
    }

    const targetDate = new Date(year, month - 1 + offset, 1);
    const targetYear = targetDate.getFullYear();
    const targetMonth = `${targetDate.getMonth() + 1}`.padStart(2, '0');
    this.calendarMonthIso.set(`${targetYear}-${targetMonth}`);
  }

  protected showAgendaDropToast(message: string): void {
    this.agendaDropToast.set(message);

    if (typeof window !== 'undefined') {
      window.clearTimeout(
        (this as unknown as Record<string, unknown>)['_agendaDropToastTimer'] as number,
      );
      (this as unknown as Record<string, unknown>)['_agendaDropToastTimer'] = window.setTimeout(
        () => {
          this.agendaDropToast.set('');
        },
        4000,
      );
    }
  }

  protected openAgendaReservationDetail(reservation: AdminReservationItem): void {
    this.agendaDetailReservation.set(reservation);
    this.agendaDetailMode.set('view');
    this.agendaDetailError.set('');
  }

  protected startAgendaReservationConfirmation(reservation: AdminReservationItem): void {
    this.openAgendaReservationDetail(reservation);
    this.openAgendaConfirmReservationModal();
  }

  protected startAgendaUnassignedReservationAssign(reservation: AdminReservationItem): void {
    const availableWorkers = this.getAgendaAvailableWorkerOptionsForReservation(reservation);
    this.agendaUnassignedAssignReservationId.set(reservation.id);
    this.agendaUnassignedAssignWorkerEmail.set(availableWorkers[0]?.email ?? '');
    this.agendaUnassignedAssignError.set('');
  }

  protected cancelAgendaUnassignedReservationAssign(): void {
    this.agendaUnassignedAssignReservationId.set('');
    this.agendaUnassignedAssignWorkerEmail.set('');
    this.agendaUnassignedAssignError.set('');
  }

  protected isAgendaUnassignedAssignExpanded(reservationId: string): boolean {
    return this.agendaUnassignedAssignReservationId() === reservationId;
  }

  protected getAgendaUnassignedReservationAvailableWorkers(
    reservation: AdminReservationItem,
  ): Array<{ email: string; label: string }> {
    return this.getAgendaAvailableWorkerOptionsForReservation(reservation);
  }

  protected canSubmitAgendaUnassignedReservationAssign(reservation: AdminReservationItem): boolean {
    return (
      this.isAgendaUnassignedAssignExpanded(reservation.id) &&
      this.getAgendaUnassignedReservationAvailableWorkers(reservation).length > 0 &&
      !!this.agendaUnassignedAssignWorkerEmail().trim()
    );
  }

  protected assignAgendaUnassignedReservation(reservation: AdminReservationItem): void {
    const assigneeEmail = this.agendaUnassignedAssignWorkerEmail().trim().toLowerCase();

    if (!assigneeEmail) {
      this.agendaUnassignedAssignError.set('Selecciona una trabajadora disponible.');
      return;
    }

    this.agendaUnassignedAssignError.set('');
    this.agendaUnassignedAssignLoadingId.set(reservation.id);

    this.http
      .patch<{ ok: boolean; error?: string }>(`/api/admin/reservas/${reservation.id}/assign`, {
        assigneeEmail,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.agendaUnassignedAssignError.set(response.error ?? 'No se pudo asignar la cita.');
            return;
          }

          this.cancelAgendaUnassignedReservationAssign();
          this.loadReservations();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.agendaUnassignedAssignError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo asignar la cita.',
          );
        },
        complete: () => {
          this.agendaUnassignedAssignLoadingId.set('');
        },
      });
  }

  protected openAgendaConfirmReservationModal(): void {
    const reservation = this.agendaDetailReservation();

    if (!reservation) {
      return;
    }

    if (!this.requirePermission('reservas_gestionar', 'Confirmar cita')) {
      return;
    }

    if (reservation.adminStatus === 'accepted') {
      return;
    }

    const currentAssignee = `${reservation.createdByEmail ?? ''}`.trim().toLowerCase();
    const availableWorkers = this.getAgendaAvailableWorkerOptionsForReservation(reservation);
    const fallbackWorker =
      availableWorkers.find((worker) => worker.email === currentAssignee)?.email ||
      availableWorkers[0]?.email ||
      this.ownerEmail().trim().toLowerCase();

    this.agendaConfirmReservationWorkerEmail.set(currentAssignee || fallbackWorker);
    this.agendaDetailError.set('');

    this.showAgendaConfirmReservationModal.set(true);
  }

  protected closeAgendaConfirmReservationModal(): void {
    this.showAgendaConfirmReservationModal.set(false);
    this.agendaConfirmReservationWorkerEmail.set('');
  }

  protected confirmAgendaReservationFromModal(): void {
    if (!this.canConfirmAgendaReservationFromModal()) {
      this.agendaDetailError.set('Selecciona una trabajadora disponible para poder confirmar.');
      return;
    }

    this.showAgendaConfirmReservationModal.set(false);
    this.confirmAgendaDetailSignal();
  }

  protected confirmAgendaDetailSignal(): void {
    const reservation = this.agendaDetailReservation();

    if (!reservation) {
      return;
    }

    if (!this.requirePermission('reservas_gestionar', 'Confirmar cita')) {
      return;
    }

    if (reservation.adminStatus === 'accepted') {
      return;
    }

    const assigneeEmail = this.agendaConfirmReservationWorkerEmail().trim().toLowerCase();

    if (!assigneeEmail) {
      this.agendaDetailError.set('Selecciona una trabajadora para confirmar la cita.');
      return;
    }

    if (reservation.paymentReceived) {
      this.setReservationStatus(reservation.id, 'accepted', assigneeEmail);
      return;
    }

    this.agendaDetailConfirmAfterPaymentReservationId.set(reservation.id);
    this.markPaymentReceivedDirect(reservation.id);
  }

  protected getAgendaDetailClientCardId(): string {
    const reservation = this.agendaDetailReservation();

    if (!reservation) {
      return '';
    }

    const reservationEmail = `${reservation.customerEmail ?? ''}`.trim().toLowerCase();
    const reservationPhone = this.normalizePhoneForMatch(reservation.customerPhone ?? '');

    const match = this.clientCards().find((card) => {
      const cardEmail = `${card.email ?? ''}`.trim().toLowerCase();
      const cardPhone = this.normalizePhoneForMatch(card.phone ?? '');

      if (reservationEmail && cardEmail && cardEmail === reservationEmail) {
        return true;
      }

      if (reservationPhone && cardPhone && cardPhone === reservationPhone) {
        return true;
      }

      return false;
    });

    return match?.id ?? '';
  }

  protected openAgendaDetailClientCard(): void {
    const cardId = this.getAgendaDetailClientCardId();

    if (!cardId) {
      this.agendaDetailError.set('No se encontró ficha para esta clienta.');
      return;
    }

    this.closeAgendaReservationDetail();
    this.setActiveTab('clientes');
    this.clientManagementTab.set('listado');
    this.openClientDetailModal(cardId);
  }

  private normalizePhoneForMatch(value: string): string {
    return `${value}`.replace(/\D/g, '');
  }

  protected closeAgendaReservationDetail(): void {
    this.agendaDetailReservation.set(null);
    this.agendaDetailMode.set('view');
    this.agendaDetailError.set('');
    this.agendaDetailSaving.set(false);
    this.agendaDetailCancelling.set(false);
    this.showAgendaConfirmReservationModal.set(false);
    this.agendaConfirmReservationWorkerEmail.set('');
  }

  protected startAgendaReservationEdit(): void {
    const r = this.agendaDetailReservation();
    if (!r) {
      return;
    }
    this.agendaEditDraftName.set(r.appointmentTypeName);
    this.agendaEditDraftDuration.set(r.durationMinutes);
    this.agendaDetailError.set('');
    this.agendaDetailMode.set('edit');
  }

  protected onAgendaEditDraftNameChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.agendaEditDraftName.set(target.value);
  }

  protected onAgendaEditDraftDurationChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.agendaEditDraftDuration.set(Number(target.value));
  }

  protected saveAgendaReservationEdit(): void {
    const r = this.agendaDetailReservation();
    if (!r) {
      return;
    }

    const nextName = this.agendaEditDraftName().trim();
    const nextDuration = this.agendaEditDraftDuration();

    if (!nextName) {
      this.agendaDetailError.set('Selecciona un tratamiento.');
      return;
    }

    if (!Number.isFinite(nextDuration) || nextDuration < 30) {
      this.agendaDetailError.set('Duración no válida.');
      return;
    }

    if (
      !this.isSuperadmin() &&
      nextDuration !== r.durationMinutes &&
      this.hasReservationConflict(r.dateIso, r.startTime, nextDuration, r.id, r.createdByEmail)
    ) {
      this.agendaDetailError.set('La nueva duración solapa con otra cita existente.');
      return;
    }

    this.agendaDetailSaving.set(true);
    this.agendaDetailError.set('');

    this.http
      .patch<{ ok: boolean; error?: string }>(`/api/admin/reservas/${r.id}`, {
        dateIso: r.dateIso,
        startTime: r.startTime,
        durationMinutes: nextDuration,
        appointmentTypeName: nextName,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        customerEmail: r.customerEmail,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.agendaDetailError.set(response.error ?? 'No se pudo guardar los cambios.');
            return;
          }

          const nextEndTime = this.formatMinutesToTime(
            this.parseTimeToMinutes(r.startTime) + nextDuration,
          );

          const updated: AdminReservationItem = {
            ...r,
            appointmentTypeName: nextName,
            durationMinutes: nextDuration,
            endTime: nextEndTime,
          };

          this.reservations.update((items) =>
            items.map((item) => (item.id === r.id ? updated : item)),
          );
          this.agendaDetailReservation.set(updated);
          this.agendaDetailMode.set('view');
          this.loadReservations();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.agendaDetailError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo guardar los cambios.',
          );
        },
        complete: () => {
          this.agendaDetailSaving.set(false);
        },
      });
  }

  protected cancelAgendaReservationFromDetail(): void {
    const r = this.agendaDetailReservation();
    if (!r) {
      return;
    }

    if (
      typeof window !== 'undefined' &&
      !window.confirm(`¿Cancelar la cita de ${r.customerName}? Esta acción no se puede deshacer.`)
    ) {
      return;
    }

    this.agendaDetailCancelling.set(true);
    this.agendaDetailError.set('');

    this.http
      .patch<{ ok: boolean; error?: string }>(`/api/admin/reservas/${r.id}/status`, {
        status: 'rejected',
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.agendaDetailError.set(response.error ?? 'No se pudo cancelar la cita.');
            return;
          }

          this.reservations.update((items) =>
            items.map((item) =>
              item.id === r.id ? { ...item, adminStatus: 'rejected' as const } : item,
            ),
          );
          this.closeAgendaReservationDetail();
          this.loadReservations();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.agendaDetailError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo cancelar la cita.',
          );
        },
        complete: () => {
          this.agendaDetailCancelling.set(false);
        },
      });
  }

  protected openQuickReserveModal(): void {
    this.showQuickReserveModal.set(true);
  }

  protected openAgendaManualReserveModal(dateIso?: string, time = '', workerEmail = ''): void {
    if (!this.canCreateAgendaManualReservation()) {
      this.actionError.set('No tienes permisos para crear reservas manuales desde agenda.');
      return;
    }

    const resolvedDateIso = dateIso || this.agendaSelectedDateIso() || this.getTodayIso();
    const defaultPack = this.agendaPackOptions[0];
    const currentUserEmail = this.ownerEmail().trim().toLowerCase();
    const canAssignReservation = this.canAssignReservationToWorker();
    const targetWorkerEmail =
      this.normalizeAgendaWorkerEmail(workerEmail) ||
      this.normalizeAgendaWorkerEmail(currentUserEmail) ||
      currentUserEmail;

    this.agendaManualReserveError.set('');
    this.agendaManualReserveDateIso.set(resolvedDateIso);
    this.agendaManualReserveTime.set(
      this.normalizeAgendaTimeValue(time) ||
        this.getDefaultAgendaManualReserveTime(resolvedDateIso),
    );
    this.agendaManualReserveAssignToMe.set(!canAssignReservation);
    this.agendaManualReserveWorkerEmail.set(targetWorkerEmail);
    this.agendaManualReserveCustomerName.set('');
    this.agendaManualReserveCustomerPhone.set('');
    this.agendaManualReserveCustomerEmail.set('');
    this.agendaManualReserveServiceType.set('pack');
    this.agendaManualReserveServiceId.set(defaultPack?.id ?? 1);
    this.agendaManualReserveDuration.set(defaultPack?.duracionMinutos ?? 60);
    this.showAgendaManualReserveModal.set(true);
  }

  protected closeAgendaManualReserveModal(): void {
    this.showAgendaManualReserveModal.set(false);
    this.agendaManualReserveLoading.set(false);
    this.agendaManualReserveError.set('');
  }

  protected onAgendaManualReserveServiceTypeChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const nextType = target.value === 'treatment' ? 'treatment' : 'pack';
    const nextDefault =
      nextType === 'pack' ? this.agendaPackOptions[0] : this.agendaTreatmentCatalog[0];

    this.agendaManualReserveServiceType.set(nextType);
    this.agendaManualReserveServiceId.set(nextDefault?.id ?? 1);
    this.syncAgendaManualReserveDurationFromSelectedService();
  }

  protected onAgendaManualReserveServiceIdChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const nextId = Number(target.value);

    if (!Number.isFinite(nextId) || nextId <= 0) {
      return;
    }

    this.agendaManualReserveServiceId.set(nextId);
    this.syncAgendaManualReserveDurationFromSelectedService();
  }

  protected onAgendaManualReserveDurationChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const nextDuration = Number(target.value);

    if (!Number.isFinite(nextDuration) || nextDuration <= 0) {
      return;
    }

    this.agendaManualReserveDuration.set(nextDuration);
  }

  protected submitAgendaManualReserve(): void {
    if (!this.canCreateAgendaManualReservation()) {
      this.agendaManualReserveError.set('No tienes permisos para crear reservas manuales.');
      return;
    }

    const selectedService = this.getAgendaManualReserveSelectedService();
    const dateIso = this.agendaManualReserveDateIso().trim();
    const time = this.normalizeAgendaTimeValue(this.agendaManualReserveTime().trim());
    const customerName = this.agendaManualReserveCustomerName().trim();
    const customerPhone = this.agendaManualReserveCustomerPhone().trim();
    const customerEmail = this.agendaManualReserveCustomerEmail().trim().toLowerCase();
    const durationMinutes = this.agendaManualReserveDuration();
    const canAssignReservation = this.canAssignReservationToWorker();
    const currentUserEmail = this.ownerEmail().trim().toLowerCase();
    const selectedWorkerEmail = this.normalizeAgendaWorkerEmail(
      this.agendaManualReserveWorkerEmail(),
    );
    const createdByEmail =
      this.agendaManualReserveAssignToMe() || !canAssignReservation
        ? currentUserEmail
        : selectedWorkerEmail || currentUserEmail;

    if (!selectedService) {
      this.agendaManualReserveError.set('Selecciona un servicio válido.');
      return;
    }

    if (!dateIso || !time || !customerName || !customerPhone || !customerEmail) {
      this.agendaManualReserveError.set('Completa todos los datos de la reserva.');
      return;
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) {
      this.agendaManualReserveError.set('Introduce un email válido.');
      return;
    }

    this.agendaManualReserveLoading.set(true);
    this.agendaManualReserveError.set('');

    this.http
      .post<{ ok: boolean; reservationId?: string; error?: string }>('/api/admin/reservas', {
        dateIso,
        time,
        durationMinutes,
        customerName,
        customerPhone,
        customerEmail,
        createdByEmail,
        appointmentTypeName: selectedService.nombre,
        requiresReservationSignal:
          this.agendaManualReserveServiceType() === 'pack' &&
          Boolean((selectedService as AppointmentType).requiresReservationSignal),
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            this.agendaManualReserveError.set(response.error ?? 'No se pudo crear la reserva.');
            return;
          }

          this.closeAgendaManualReserveModal();
          this.loadReservations();
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.agendaManualReserveError.set(
            typeof apiError === 'string' && apiError ? apiError : 'No se pudo crear la reserva.',
          );
        },
        complete: () => {
          this.agendaManualReserveLoading.set(false);
        },
      });
  }

  protected handleAgendaEmptySlotClick(dateIso: string, slot: string, workerEmail = ''): void {
    if (this.canCreateAgendaManualReservation()) {
      this.openAgendaManualReserveModal(dateIso, slot, workerEmail);
      return;
    }

    if (this.isAgendaRecurringClosedSlot(dateIso, slot)) {
      return;
    }

    this.openQuickReserveModal();
  }

  protected isAgendaRecurringClosedDay(dateIso: string): boolean {
    const date = new Date(`${dateIso}T00:00:00`);

    if (Number.isNaN(date.getTime())) {
      return false;
    }

    const weekDay = date.getDay();
    return weekDay === 0 || weekDay === 1;
  }

  protected isAgendaRecurringClosedSlot(dateIso: string, time: string): boolean {
    if (this.isAgendaRecurringClosedDay(dateIso)) {
      return true;
    }

    const date = new Date(`${dateIso}T00:00:00`);

    if (!Number.isNaN(date.getTime()) && date.getDay() === 6) {
      return false;
    }

    const [hoursRaw, minutesRaw] = time.split(':');
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);

    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return false;
    }

    const totalMinutes = hours * 60 + minutes;
    return totalMinutes >= 14 * 60 && totalMinutes < 15 * 60;
  }

  protected getAgendaClosedSlotLabel(dateIso: string, time: string): string {
    if (this.isAgendaRecurringClosedDay(dateIso)) {
      return 'Cerrado';
    }

    if (this.isAgendaRecurringClosedSlot(dateIso, time)) {
      return 'Cerrado · 14:00 a 15:00';
    }

    return 'Sin citas';
  }

  protected confirmQuickReserve(): void {
    this.showQuickReserveModal.set(false);
    void this.router.navigate(['/reservas']);
  }

  protected cancelQuickReserve(): void {
    this.showQuickReserveModal.set(false);
  }

  private buildHalfHourOptions(startTime: string, endTime: string): string[] {
    const parseTime = (time: string): number => {
      const [hoursRaw, minutesRaw] = time.split(':');
      const hours = Number(hoursRaw);
      const minutes = Number(minutesRaw);

      if (Number.isNaN(hours) || Number.isNaN(minutes)) {
        return 0;
      }

      return hours * 60 + minutes;
    };

    const toTime = (minutesTotal: number): string => {
      const hours = Math.floor(minutesTotal / 60)
        .toString()
        .padStart(2, '0');
      const minutes = (minutesTotal % 60).toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    };

    const start = parseTime(startTime);
    const end = parseTime(endTime);
    const options: string[] = [];

    for (let current = start; current <= end; current += 30) {
      options.push(toTime(current));
    }

    return options;
  }

  protected getAgendaDayWorkerSections(): AgendaDayWorkerSection[] {
    const workerOptions = this.getAgendaAssignableWorkerOptions();

    if (workerOptions.length === 0) {
      return [
        {
          workerKey: this.getReservationWorkerKey(this.ownerEmail()),
          workerLabel: this.getWorkerDisplayName(this.ownerEmail()),
        },
      ];
    }

    const sections = workerOptions.map((worker) => ({
      workerKey: this.getReservationWorkerKey(worker.email),
      workerLabel: worker.label,
    }));

    return sections;
  }

  protected getAgendaReservationsByWorkerAndStartTime(
    workerKey: string,
    startTime: string,
  ): AdminReservationItem[] {
    return this.getAgendaDayReservations().filter(
      (reservation) =>
        this.getReservationWorkerKey(reservation.createdByEmail) === workerKey &&
        reservation.startTime === startTime,
    );
  }

  private getAgendaMaxConcurrentReservations(): number {
    return Math.max(1, this.getAgendaAssignableWorkerOptions().length);
  }

  protected getAgendaAssignableWorkerOptions(): Array<{ email: string; label: string }> {
    const options = new Map<string, { email: string; label: string }>();
    const currentOwnerEmail = this.ownerEmail().trim().toLowerCase();

    this.employeeUsers().forEach((user) => {
      if (user.role !== 'admin') {
        return;
      }

      const email = user.email.trim().toLowerCase();

      if (!email) {
        return;
      }

      options.set(email, {
        email,
        label: this.getWorkerDisplayName(email),
      });
    });

    if (currentOwnerEmail && !options.has(currentOwnerEmail)) {
      options.set(currentOwnerEmail, {
        email: currentOwnerEmail,
        label: this.getWorkerDisplayName(currentOwnerEmail),
      });
    }

    return Array.from(options.values()).sort((a, b) => {
      if (a.email === currentOwnerEmail) {
        return -1;
      }

      if (b.email === currentOwnerEmail) {
        return 1;
      }

      return a.label.localeCompare(b.label);
    });
  }

  protected getAgendaAvailableWorkerOptionsForReservation(
    reservation: AdminReservationItem,
  ): Array<{ email: string; label: string }> {
    const assignedEmail = `${reservation.createdByEmail ?? ''}`.trim().toLowerCase();
    const currentUserEmail = this.ownerEmail().trim().toLowerCase();
    const canAssignOthers = this.canAssignReservationToWorker();

    return this.getAgendaAssignableWorkerOptions().filter((worker) => {
      if (!canAssignOthers && worker.email !== currentUserEmail && worker.email !== assignedEmail) {
        return false;
      }

      if (worker.email === assignedEmail) {
        return true;
      }

      return this.isWorkerAvailableForReservation(worker.email, reservation);
    });
  }

  protected canConfirmAgendaReservationFromModal(): boolean {
    const reservation = this.agendaDetailReservation();

    if (!reservation) {
      return false;
    }

    const assigneeEmail = this.agendaConfirmReservationWorkerEmail().trim().toLowerCase();

    if (!assigneeEmail) {
      return false;
    }

    const assignedEmail = `${reservation.createdByEmail ?? ''}`.trim().toLowerCase();

    if (assignedEmail === assigneeEmail) {
      return true;
    }

    return this.isWorkerAvailableForReservation(assigneeEmail, reservation);
  }

  protected canAssignReservationToWorker(): boolean {
    if (this.isSuperadmin()) {
      return true;
    }

    return this.hasPermission('citas_asignar');
  }

  protected onAgendaManualReserveAssignToMeChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const shouldAssignToMe = target.checked;
    this.agendaManualReserveAssignToMe.set(shouldAssignToMe);

    if (shouldAssignToMe) {
      this.agendaManualReserveWorkerEmail.set(this.ownerEmail().trim().toLowerCase());
    }
  }

  protected isAgendaDaySlotContinuationForWorker(workerKey: string, startTime: string): boolean {
    const dateIso = this.agendaDayScheduleDateIso();

    if (!dateIso) {
      return false;
    }

    return this.isAgendaSlotContinuation(dateIso, startTime, workerKey);
  }

  protected isAgendaWeekSlotContinuation(dateIso: string, startTime: string): boolean {
    return this.isAgendaSlotContinuation(dateIso, startTime);
  }

  protected getAgendaReservationVisualHeightPx(
    durationMinutes: number,
    mode: 'day' | 'week',
  ): number {
    const slotHeight = mode === 'day' ? 48 : 35;
    const slots = Math.max(1, Math.ceil(durationMinutes / 30));
    return Math.max(slotHeight - 6, slotHeight * slots - 6);
  }

  private getAgendaManualReserveSelectedService(): AppointmentType | TratamientoItem | null {
    if (this.agendaManualReserveServiceType() === 'pack') {
      return (
        this.agendaPackOptions.find((item) => item.id === this.agendaManualReserveServiceId()) ??
        null
      );
    }

    return (
      this.agendaTreatmentCatalog.find((item) => item.id === this.agendaManualReserveServiceId()) ??
      null
    );
  }

  private syncAgendaManualReserveDurationFromSelectedService(): void {
    const selectedService = this.getAgendaManualReserveSelectedService();

    if (!selectedService) {
      return;
    }

    this.agendaManualReserveDuration.set(selectedService.duracionMinutos);
  }

  private getDefaultAgendaManualReserveTime(_dateIso: string): string {
    return '10:00';
  }

  private canCreateAgendaManualReservation(): boolean {
    if (this.isSuperadmin()) {
      return true;
    }

    return this.hasPermission('agenda_gestionar');
  }

  private normalizeAgendaTimeValue(value: string): string {
    const normalized = `${value ?? ''}`.trim();
    const match = normalized.match(/^(\d{1,2}):(\d{2})/);

    if (!match) {
      return normalized;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      return normalized;
    }

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return normalized;
    }

    return `${`${hours}`.padStart(2, '0')}:${`${minutes}`.padStart(2, '0')}`;
  }

  private normalizeAgendaWorkerEmail(value: string | null | undefined): string {
    return `${value ?? ''}`.trim().toLowerCase();
  }

  private normalizeReservationTimeFields(reservation: AdminReservationItem): AdminReservationItem {
    return {
      ...reservation,
      startTime: this.normalizeAgendaTimeValue(reservation.startTime),
      endTime: this.normalizeAgendaTimeValue(reservation.endTime),
      createdByEmail: reservation.createdByEmail?.trim().toLowerCase() || null,
    };
  }

  private getReservationWorkerKey(workerEmail: string | null | undefined): string {
    const normalized = `${workerEmail ?? ''}`.trim().toLowerCase();
    return normalized || '__sin_asignar__';
  }

  private isWorkerAvailableForReservation(
    workerEmail: string,
    reservation: AdminReservationItem,
  ): boolean {
    const workerKey = this.getReservationWorkerKey(workerEmail);
    const candidateStart = this.parseTimeToMinutes(reservation.startTime);
    const candidateEnd = this.parseTimeToMinutes(reservation.endTime);

    return this.reservations().every((item) => {
      if (item.id === reservation.id || item.adminStatus === 'rejected') {
        return true;
      }

      if (item.dateIso !== reservation.dateIso) {
        return true;
      }

      if (this.getReservationWorkerKey(item.createdByEmail) !== workerKey) {
        return true;
      }

      const existingStart = this.parseTimeToMinutes(item.startTime);
      const existingEnd = this.parseTimeToMinutes(item.endTime);
      return candidateEnd <= existingStart || candidateStart >= existingEnd;
    });
  }

  private isAgendaSlotContinuation(
    dateIso: string,
    startTime: string,
    workerKey?: string,
  ): boolean {
    const slotMinutes = this.parseTimeToMinutes(startTime);

    if (slotMinutes <= 0) {
      return false;
    }

    return this.getAgendaCalendarReservations().some((reservation) => {
      if (reservation.dateIso !== dateIso || reservation.adminStatus === 'rejected') {
        return false;
      }

      if (workerKey && this.getReservationWorkerKey(reservation.createdByEmail) !== workerKey) {
        return false;
      }

      const reservationStart = this.parseTimeToMinutes(reservation.startTime);
      const reservationEnd = this.parseTimeToMinutes(reservation.endTime);

      return slotMinutes > reservationStart && slotMinutes < reservationEnd;
    });
  }

  private getFullDayBlockRange(dateIso: string): { startTime: string; endTime: string } {
    const date = new Date(`${dateIso}T00:00:00`);
    const weekDay = date.getDay();

    if (weekDay === 6) {
      return {
        startTime: '09:00',
        endTime: '13:30',
      };
    }

    return {
      startTime: '10:00',
      endTime: '18:30',
    };
  }
}
