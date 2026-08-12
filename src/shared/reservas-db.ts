import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { getProvisionalReservationHoursByName } from './pack-prices';

export interface ReservaPersistRequest {
  dateIso: string;
  time: string;
  durationMinutes: number;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  appointmentTypeName: string;
  additionalComments?: string;
  requiresReservationSignal?: boolean;
  createdByEmail?: string;
}

export type AdminReservationStatus = 'pending' | 'accepted' | 'rejected';
export type ClientConfirmationStatus = 'pending' | 'confirmed';
export type ReservationSignalPaymentMethod = 'efectivo' | 'tarjeta' | 'bizum';

export interface AdminReservationItem {
  id: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  appointmentTypeName: string;
  additionalComments: string;
  signalAmountEuro: number;
  signalPaymentMethod: ReservationSignalPaymentMethod | null;
  signalReceivedAtIso?: string | null;
  signalRegisteredByEmail?: string | null;
  paymentReceived: boolean;
  paymentMethod: ReservationSignalPaymentMethod | null;
  paymentAmountEuro: number;
  adminStatus: AdminReservationStatus;
  clientConfirmationStatus: ClientConfirmationStatus;
  clientConfirmationReminderSentAtIso?: string | null;
  createdByEmail?: string | null;
  createdAtIso: string;
  expiresAtIso?: string | null;
}

export interface AdminBlockedPeriodItem {
  id: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  reason: string;
  createdAtIso: string;
}

export const OPEN_MINUTES = 9 * 60;
export const CLOSE_MINUTES = 20 * 60;
export const STEP_MINUTES = 30;

const MONDAY_WEEKDAY = 1;
const SUNDAY_WEEKDAY = 0;
const SATURDAY_WEEKDAY = 6;
const WEEKDAY_FIRST_START_MINUTES = 10 * 60;
const WEEKDAY_LAST_START_MINUTES = 18 * 60;
const SATURDAY_FIRST_START_MINUTES = 9 * 60;
const SATURDAY_LAST_START_MINUTES = 13 * 60;
const MIDDAY_CLOSED_START_MINUTES = 14 * 60;
const MIDDAY_CLOSED_END_MINUTES = 15 * 60;

const getServiceWindowByDate = (
  dateIso: string,
): { firstStartMinutes: number; lastStartMinutes: number } | null => {
  const date = new Date(`${dateIso}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const weekDay = date.getDay();

  if (weekDay === SUNDAY_WEEKDAY) {
    // Domingo cerrado.
    return null;
  }

  if (weekDay === SATURDAY_WEEKDAY) {
    return {
      firstStartMinutes: SATURDAY_FIRST_START_MINUTES,
      lastStartMinutes: SATURDAY_LAST_START_MINUTES,
    };
  }

  return {
    firstStartMinutes: WEEKDAY_FIRST_START_MINUTES,
    lastStartMinutes: WEEKDAY_LAST_START_MINUTES,
  };
};

let pool: Pool | null = null;
let schemaReady = false;
let schemaInitPromise: Promise<void> | null = null;
let fallbackWarningShown = false;
let runtimeMemoryMode = false;

interface MemoryReservation {
  id: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  appointmentTypeName: string;
  additionalComments: string;
  signalAmountEuro: number;
  signalPaymentMethod: ReservationSignalPaymentMethod | null;
  signalReceivedAtIso?: string | null;
  signalRegisteredByEmail?: string | null;
  paymentReceived: boolean;
  paymentMethod: ReservationSignalPaymentMethod | null;
  paymentAmountEuro: number;
  adminStatus: AdminReservationStatus;
  clientConfirmationStatus: ClientConfirmationStatus;
  clientConfirmationReminderSentAtIso?: string | null;
  createdByEmail?: string | null;
  createdAtIso: string;
  expiresAtIso?: string | null;
  slots: string[];
}

interface MemoryBlockedPeriod {
  id: string;
  dateIso: string;
  startTime: string;
  endTime: string;
  reason: string;
  createdAtIso: string;
  slots: string[];
}

const memoryReservations = new Map<string, MemoryReservation>();
const memorySlotsByDate = new Map<string, Set<string>>();
const memoryBlockedPeriods = new Map<string, MemoryBlockedPeriod>();
const memoryBlockedSlotsByDate = new Map<string, Set<string>>();

const getReservationExpiresAtIso = (payload: {
  appointmentTypeName: string;
  createdAtIso: string;
  requiresReservationSignal?: boolean;
}): string | null => {
  const provisionalHours = payload.requiresReservationSignal
    ? 48
    : getProvisionalReservationHoursByName(payload.appointmentTypeName);

  if (provisionalHours <= 0) {
    return null;
  }

  const createdAtMs = new Date(payload.createdAtIso).getTime();

  if (Number.isNaN(createdAtMs)) {
    return null;
  }

  return new Date(createdAtMs + provisionalHours * 60 * 60 * 1000).toISOString();
};

const isExpiredProvisionalReservation = (reservation: {
  adminStatus: AdminReservationStatus;
  expiresAtIso?: string | null;
}): boolean => {
  if (reservation.adminStatus !== 'pending' || !reservation.expiresAtIso) {
    return false;
  }

  return new Date(reservation.expiresAtIso).getTime() <= Date.now();
};

const removeReservationFromMemory = (reservationId: string): void => {
  const reservation = memoryReservations.get(reservationId);

  if (!reservation) {
    return;
  }

  memoryReservations.delete(reservationId);
  rebuildMemoryReservationSlotIndex();
};

const purgeExpiredProvisionalReservationsInMemory = (): boolean => {
  const expiredIds = Array.from(memoryReservations.values())
    .filter((reservation) => isExpiredProvisionalReservation(reservation))
    .map((reservation) => reservation.id);

  if (expiredIds.length === 0) {
    return false;
  }

  expiredIds.forEach((reservationId) => removeReservationFromMemory(reservationId));
  saveMemoryToFile();
  return true;
};

const cleanupExpiredProvisionalReservations = async (): Promise<void> => {
  if (!shouldUseDatabase()) {
    purgeExpiredProvisionalReservationsInMemory();
    return;
  }

  await ensureSchema();
  const db = getPool();

  await db.query(`
    DELETE FROM reservations
    WHERE admin_status = 'pending'
      AND expires_at IS NOT NULL
      AND expires_at <= NOW()
  `);
};

const DEV_CACHE_FILE = path.join(process.cwd(), '.dev-reservas-cache.json');
let memoryFileLoaded = false;

const saveMemoryToFile = (): void => {
  if (process.env['NODE_ENV'] === 'production') {
    return;
  }

  try {
    const data = JSON.stringify(Array.from(memoryReservations.values()), null, 2);
    fs.writeFileSync(DEV_CACHE_FILE, data, 'utf8');
  } catch {
    // ignore file errors in dev
  }
};

const loadMemoryFromFile = (): void => {
  if (memoryFileLoaded) {
    return;
  }

  memoryFileLoaded = true;

  if (process.env['NODE_ENV'] === 'production') {
    return;
  }

  try {
    if (!fs.existsSync(DEV_CACHE_FILE)) {
      return;
    }

    const raw = fs.readFileSync(DEV_CACHE_FILE, 'utf8');
    const items: MemoryReservation[] = JSON.parse(raw);

    if (!Array.isArray(items) || items.length === 0) {
      return;
    }

    // Discard entries older than 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

    let filteredExpired = false;

    items.forEach((item) => {
      if (isExpiredProvisionalReservation(item)) {
        filteredExpired = true;
        return;
      }

      if (new Date(item.createdAtIso).getTime() < cutoff) {
        return;
      }

      const normalizedItem: MemoryReservation = {
        ...item,
        additionalComments: `${item.additionalComments ?? ''}`,
        signalAmountEuro: Number(item.signalAmountEuro) > 0 ? Number(item.signalAmountEuro) : 0,
        signalPaymentMethod:
          item.signalPaymentMethod === 'efectivo' ||
          item.signalPaymentMethod === 'tarjeta' ||
          item.signalPaymentMethod === 'bizum'
            ? item.signalPaymentMethod
            : null,
        signalReceivedAtIso: item.signalReceivedAtIso ?? null,
        signalRegisteredByEmail: item.signalRegisteredByEmail ?? null,
        paymentMethod:
          item.paymentMethod === 'efectivo' ||
          item.paymentMethod === 'tarjeta' ||
          item.paymentMethod === 'bizum'
            ? item.paymentMethod
            : null,
        paymentAmountEuro: Number(item.paymentAmountEuro) > 0 ? Number(item.paymentAmountEuro) : 0,
      };

      memoryReservations.set(normalizedItem.id, normalizedItem);
      const dateSlots = memorySlotsByDate.get(normalizedItem.dateIso) ?? new Set<string>();

      if (normalizedItem.adminStatus !== 'rejected') {
        normalizedItem.slots.forEach((slot) => dateSlots.add(slot));
      }

      memorySlotsByDate.set(normalizedItem.dateIso, dateSlots);
    });

    // If we loaded real data, skip mock seeding
    if (memoryReservations.size > 0) {
      mockReservationsSeeded = true;
    }

    if (filteredExpired) {
      saveMemoryToFile();
    }

    console.log(`[dev-cache] Cargadas ${memoryReservations.size} reservas desde ${DEV_CACHE_FILE}`);
  } catch {
    // ignore file errors
  }
};

const isMemoryFallbackAllowed = (): boolean => {
  return process.env['ALLOW_MEMORY_RESERVAS_FALLBACK'] === 'true';
};

const enableRuntimeMemoryMode = (reason: unknown): boolean => {
  if (!isMemoryFallbackAllowed()) {
    return false;
  }

  runtimeMemoryMode = true;
  schemaReady = false;

  if (!fallbackWarningShown) {
    const reasonText = reason instanceof Error ? reason.message : 'Error desconocido de conexión.';
    console.warn(
      `No se pudo usar PostgreSQL. Se activa modo memoria temporal para reservas. Motivo: ${reasonText}`,
    );
    fallbackWarningShown = true;
  }

  return true;
};

const isPlaceholderConnectionString = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('user:password@host') ||
    normalized.includes('dbname') ||
    normalized.includes('localhost:5432/dbname')
  );
};

const shouldUseDatabase = (): boolean => {
  if (runtimeMemoryMode) {
    return false;
  }

  const connectionString = process.env['DATABASE_URL'];
  const isProduction = process.env['NODE_ENV'] === 'production';

  if (!connectionString || isPlaceholderConnectionString(connectionString)) {
    if (isProduction) {
      throw new Error(
        'DATABASE_URL no configurada correctamente en producción. Se desactiva el modo memoria para evitar pérdida de datos.',
      );
    }

    if (!fallbackWarningShown) {
      console.warn(
        'DATABASE_URL no configurada correctamente. Usando almacenamiento temporal en memoria para reservas.',
      );
      fallbackWarningShown = true;
    }

    return false;
  }

  return true;
};

const getPool = (): Pool => {
  const connectionString = process.env['DATABASE_URL'];

  if (!connectionString || isPlaceholderConnectionString(connectionString)) {
    throw new Error('DATABASE_URL no configurada.');
  }

  if (!pool) {
    const requiresSsl =
      process.env['NODE_ENV'] === 'production' ||
      /sslmode=require/i.test(connectionString) ||
      process.env['PGSSLMODE']?.toLowerCase() === 'require';

    pool = new Pool({
      connectionString,
      ssl: requiresSsl ? { rejectUnauthorized: false } : false,
    });
  }

  return pool;
};

const ensureSchema = async (): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  if (schemaReady) {
    return;
  }

  if (schemaInitPromise) {
    await schemaInitPromise;
    return;
  }

  schemaInitPromise = (async () => {
    const db = getPool();

    await db.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        date_iso TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        customer_email TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        appointment_type_name TEXT NOT NULL,
        additional_comments TEXT NOT NULL DEFAULT '',
        signal_amount_euro NUMERIC(10,2) NOT NULL DEFAULT 0,
        signal_payment_method TEXT NULL,
        signal_received_at TIMESTAMPTZ NULL,
        signal_registered_by_email TEXT NULL,
        payment_received BOOLEAN NOT NULL DEFAULT FALSE,
        payment_method TEXT NULL,
        payment_amount_euro NUMERIC(10,2) NOT NULL DEFAULT 0,
        admin_status TEXT NOT NULL DEFAULT 'pending',
        client_confirmation_status TEXT NOT NULL DEFAULT 'pending',
        client_confirmation_reminder_sent_at TIMESTAMPTZ NULL,
        expires_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS payment_received BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS payment_method TEXT NULL;
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS payment_amount_euro NUMERIC(10,2) NOT NULL DEFAULT 0;
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS admin_status TEXT NOT NULL DEFAULT 'pending';
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS client_confirmation_status TEXT NOT NULL DEFAULT 'pending';
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS client_confirmation_reminder_sent_at TIMESTAMPTZ NULL;
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS created_by_email TEXT NULL;
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS additional_comments TEXT NOT NULL DEFAULT '';
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS signal_amount_euro NUMERIC(10,2) NOT NULL DEFAULT 0;
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS signal_payment_method TEXT NULL;
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS signal_received_at TIMESTAMPTZ NULL;
    `);

    await db.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS signal_registered_by_email TEXT NULL;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS reservation_slots (
        date_iso TEXT NOT NULL,
        slot_time TEXT NOT NULL,
        reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
        PRIMARY KEY (date_iso, slot_time, reservation_id)
      );
    `);

    await db.query(`
      DO $$
      DECLARE
        current_primary_key_definition TEXT;
      BEGIN
        SELECT pg_get_constraintdef(oid)
        INTO current_primary_key_definition
        FROM pg_constraint
        WHERE conrelid = 'reservation_slots'::regclass
          AND contype = 'p'
        LIMIT 1;

        IF current_primary_key_definition IS NOT NULL
          AND current_primary_key_definition <> 'PRIMARY KEY (date_iso, slot_time, reservation_id)' THEN
          EXECUTE 'ALTER TABLE reservation_slots DROP CONSTRAINT ' || quote_ident((
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = 'reservation_slots'::regclass
              AND contype = 'p'
            LIMIT 1
          ));
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'reservation_slots'::regclass
            AND contype = 'p'
            AND pg_get_constraintdef(oid) = 'PRIMARY KEY (date_iso, slot_time, reservation_id)'
        ) THEN
          ALTER TABLE reservation_slots
          ADD CONSTRAINT reservation_slots_pkey PRIMARY KEY (date_iso, slot_time, reservation_id);
        END IF;
      EXCEPTION
        WHEN duplicate_object OR invalid_table_definition THEN
          NULL;
      END $$;
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_reservation_slots_date_time
      ON reservation_slots (date_iso, slot_time);
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_block_periods (
        id TEXT PRIMARY KEY,
        date_iso TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_blocked_slots (
        date_iso TEXT NOT NULL,
        slot_time TEXT NOT NULL,
        block_id TEXT NOT NULL REFERENCES admin_block_periods(id) ON DELETE CASCADE,
        PRIMARY KEY (date_iso, slot_time)
      );
    `);

    schemaReady = true;
  })();

  try {
    await schemaInitPromise;
  } finally {
    schemaInitPromise = null;
  }
};

export const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return -1;
  }

  return hours * 60 + minutes;
};

export const toTime = (minutes: number): string => {
  const hours = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const mins = (minutes % 60).toString().padStart(2, '0');

  return `${hours}:${mins}`;
};

const getRecurringClosedSlotsForDate = (dateIso: string): Set<string> => {
  const serviceWindow = getServiceWindowByDate(dateIso);

  if (!serviceWindow) {
    return new Set<string>();
  }

  const date = new Date(`${dateIso}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return new Set<string>();
  }

  const blockedSlots = new Set<string>();
  const weekDay = date.getDay();

  if (weekDay === MONDAY_WEEKDAY) {
    for (
      let current = serviceWindow.firstStartMinutes;
      current <= serviceWindow.lastStartMinutes;
      current += STEP_MINUTES
    ) {
      blockedSlots.add(toTime(current));
    }

    return blockedSlots;
  }

  if (weekDay === SATURDAY_WEEKDAY) {
    return blockedSlots;
  }

  for (
    let current = MIDDAY_CLOSED_START_MINUTES;
    current < MIDDAY_CLOSED_END_MINUTES;
    current += STEP_MINUTES
  ) {
    if (current >= serviceWindow.firstStartMinutes && current <= serviceWindow.lastStartMinutes) {
      blockedSlots.add(toTime(current));
    }
  }

  return blockedSlots;
};

const buildSlotTimes = (startMinutes: number, durationMinutes: number): string[] => {
  const slots: string[] = [];

  for (
    let current = startMinutes;
    current < startMinutes + durationMinutes;
    current += STEP_MINUTES
  ) {
    slots.push(toTime(current));
  }

  return slots;
};

const buildSlotTimesFromRange = (startMinutes: number, endMinutes: number): string[] => {
  const durationMinutes = endMinutes - startMinutes;

  if (durationMinutes <= 0) {
    return [];
  }

  return buildSlotTimes(startMinutes, durationMinutes);
};

const getBookedSlotsFromMemory = (dateIso: string): Set<string> =>
  new Set(
    Array.from(memoryReservations.values())
      .filter(
        (reservation) => reservation.dateIso === dateIso && reservation.adminStatus !== 'rejected',
      )
      .flatMap((reservation) => reservation.slots),
  );

const normalizeWorkerEmail = (value: string | null | undefined): string =>
  `${value ?? ''}`.trim().toLowerCase();

const getSlotUsageCountsFromMemory = (dateIso: string): Map<string, number> => {
  const counts = new Map<string, number>();

  Array.from(memoryReservations.values()).forEach((reservation) => {
    if (reservation.dateIso !== dateIso || reservation.adminStatus === 'rejected') {
      return;
    }

    reservation.slots.forEach((slot) => {
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    });
  });

  return counts;
};

const hasWorkerConflictInMemory = (
  reservationId: string,
  dateIso: string,
  slotTimes: string[],
  workerEmail: string,
): boolean => {
  const normalizedWorker = normalizeWorkerEmail(workerEmail);

  if (!normalizedWorker) {
    return false;
  }

  return Array.from(memoryReservations.values()).some((reservation) => {
    if (reservation.id === reservationId) {
      return false;
    }

    if (reservation.adminStatus === 'rejected' || reservation.dateIso !== dateIso) {
      return false;
    }

    if (normalizeWorkerEmail(reservation.createdByEmail) !== normalizedWorker) {
      return false;
    }

    return reservation.slots.some((slot) => slotTimes.includes(slot));
  });
};

const hasCapacityConflictInMemory = (
  reservationId: string,
  dateIso: string,
  slotTimes: string[],
  maxConcurrentReservations: number,
): boolean => {
  const maxConcurrent = Math.max(1, Math.floor(maxConcurrentReservations));
  const counts = getSlotUsageCountsFromMemory(dateIso);

  const reservation = memoryReservations.get(reservationId);
  const currentSlots =
    reservation && reservation.adminStatus !== 'rejected' && reservation.dateIso === dateIso
      ? new Set(reservation.slots)
      : new Set<string>();

  return slotTimes.some((slot) => {
    const currentUsage = counts.get(slot) ?? 0;
    const adjustedUsage = currentSlots.has(slot) ? currentUsage - 1 : currentUsage;
    return adjustedUsage >= maxConcurrent;
  });
};

const getBlockedSlotsFromMemory = (dateIso: string): Set<string> =>
  new Set(memoryBlockedSlotsByDate.get(dateIso) ?? new Set<string>());

const getEffectiveBlockedSlotsFromMemory = (dateIso: string): Set<string> => {
  const blockedSlots = getBlockedSlotsFromMemory(dateIso);

  getRecurringClosedSlotsForDate(dateIso).forEach((slot) => blockedSlots.add(slot));
  return blockedSlots;
};

const normalizeBlockReason = (value: string): string => {
  const trimmed = value.trim();

  if (!trimmed) {
    return 'Bloqueo manual';
  }

  return trimmed.slice(0, 120);
};

const createReservationWithSlotsInMemory = (
  payload: ReservaPersistRequest,
  startMinutes: number,
  options?: {
    allowClosedSchedule?: boolean;
    maxConcurrentReservations?: number;
  },
): { ok: true; reservationId: string } | { ok: false; conflict: true } => {
  purgeExpiredProvisionalReservationsInMemory();

  const reservationId = `${payload.dateIso}-${startMinutes}-${Date.now()}`;
  const slotTimes = buildSlotTimes(startMinutes, payload.durationMinutes);
  const maxConcurrent = Math.max(1, Math.floor(options?.maxConcurrentReservations ?? 1));
  const slotUsage = getSlotUsageCountsFromMemory(payload.dateIso);
  const blockedSlots = options?.allowClosedSchedule
    ? getBlockedSlotsFromMemory(payload.dateIso)
    : getEffectiveBlockedSlotsFromMemory(payload.dateIso);

  const hasCapacityConflict = slotTimes.some((slot) => (slotUsage.get(slot) ?? 0) >= maxConcurrent);
  const assigneeWorker = normalizeWorkerEmail(payload.createdByEmail);
  const hasWorkerConflict = hasWorkerConflictInMemory(
    '',
    payload.dateIso,
    slotTimes,
    assigneeWorker,
  );
  const hasConflict =
    hasCapacityConflict || hasWorkerConflict || slotTimes.some((slot) => blockedSlots.has(slot));

  if (hasConflict) {
    return { ok: false, conflict: true };
  }

  const createdAtIso = new Date().toISOString();

  memoryReservations.set(reservationId, {
    id: reservationId,
    dateIso: payload.dateIso,
    startTime: payload.time,
    endTime: toTime(startMinutes + payload.durationMinutes),
    durationMinutes: payload.durationMinutes,
    customerEmail: payload.customerEmail,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    appointmentTypeName: payload.appointmentTypeName,
    additionalComments: `${payload.additionalComments ?? ''}`.trim().slice(0, 500),
    signalAmountEuro: 0,
    signalPaymentMethod: null,
    signalReceivedAtIso: null,
    signalRegisteredByEmail: null,
    paymentReceived: false,
    paymentMethod: null,
    paymentAmountEuro: 0,
    adminStatus: 'pending',
    clientConfirmationStatus: 'pending',
    clientConfirmationReminderSentAtIso: null,
    createdByEmail: payload.createdByEmail?.trim().toLowerCase() || null,
    createdAtIso,
    expiresAtIso: getReservationExpiresAtIso({
      appointmentTypeName: payload.appointmentTypeName,
      createdAtIso,
      requiresReservationSignal: payload.requiresReservationSignal,
    }),
    slots: slotTimes,
  });

  rebuildMemoryReservationSlotIndex();
  saveMemoryToFile();
  return { ok: true, reservationId };
};

let mockReservationsSeeded = false;

const shouldSeedMockReservations = (): boolean => {
  if (process.env['SEED_MOCK_RESERVAS'] === 'false') {
    return false;
  }

  return process.env['NODE_ENV'] !== 'production';
};

const getUpcomingDayDateIso = (dayOfMonth: number): string => {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const candidate = new Date(year, month, dayOfMonth);

  if (candidate < today) {
    candidate.setMonth(candidate.getMonth() + 1);
  }

  const candidateYear = candidate.getFullYear();
  const candidateMonth = `${candidate.getMonth() + 1}`.padStart(2, '0');
  const candidateDay = `${candidate.getDate()}`.padStart(2, '0');

  return `${candidateYear}-${candidateMonth}-${candidateDay}`;
};

const seedMockReservationsInMemory = (): void => {
  loadMemoryFromFile();

  if (mockReservationsSeeded || !shouldSeedMockReservations()) {
    return;
  }

  const day24 = getUpcomingDayDateIso(24);
  const day25 = getUpcomingDayDateIso(25);

  const mockReservations: ReservaPersistRequest[] = [
    {
      dateIso: day24,
      time: '09:00',
      durationMinutes: CLOSE_MINUTES - OPEN_MINUTES,
      customerEmail: 'mock-admin-24@arena.local',
      customerName: 'Mock Día Completo',
      customerPhone: '600000024',
      appointmentTypeName: 'Bloque completo agenda (mock)',
    },
    {
      dateIso: day25,
      time: '10:00',
      durationMinutes: 60,
      customerEmail: 'mock-25-1@arena.local',
      customerName: 'Mock Cliente 25-1',
      customerPhone: '600000251',
      appointmentTypeName: 'Corte (mock)',
    },
    {
      dateIso: day25,
      time: '12:30',
      durationMinutes: 120,
      customerEmail: 'mock-25-2@arena.local',
      customerName: 'Mock Cliente 25-2',
      customerPhone: '600000252',
      appointmentTypeName: 'Mechas (mock)',
    },
    {
      dateIso: day25,
      time: '17:00',
      durationMinutes: 90,
      customerEmail: 'mock-25-3@arena.local',
      customerName: 'Mock Cliente 25-3',
      customerPhone: '600000253',
      appointmentTypeName: 'Tinte (mock)',
    },
  ];

  mockReservations.forEach((mockReservation) => {
    const startMinutes = toMinutes(mockReservation.time);
    createReservationWithSlotsInMemory(mockReservation, startMinutes);
  });

  mockReservationsSeeded = true;
};

const deleteReservationByIdInMemory = (reservationId: string): void => {
  seedMockReservationsInMemory();

  const reservation = memoryReservations.get(reservationId);

  if (!reservation) {
    return;
  }

  memoryReservations.delete(reservationId);
  rebuildMemoryReservationSlotIndex();
  saveMemoryToFile();
};

const releaseReservationSlotsInMemory = (reservationId: string): void => {
  const reservation = memoryReservations.get(reservationId);

  if (!reservation) {
    return;
  }

  rebuildMemoryReservationSlotIndex();
};

const rebuildMemoryReservationSlotIndex = (): void => {
  memorySlotsByDate.clear();

  Array.from(memoryReservations.values()).forEach((reservation) => {
    if (reservation.adminStatus === 'rejected') {
      return;
    }

    const dateSlots = memorySlotsByDate.get(reservation.dateIso) ?? new Set<string>();
    reservation.slots.forEach((slot) => dateSlots.add(slot));
    memorySlotsByDate.set(reservation.dateIso, dateSlots);
  });
};

const reserveReservationSlotsInMemory = (
  reservationId: string,
  maxConcurrentReservations = 1,
): boolean => {
  const reservation = memoryReservations.get(reservationId);

  if (!reservation) {
    return false;
  }

  if (
    hasCapacityConflictInMemory(
      reservationId,
      reservation.dateIso,
      reservation.slots,
      maxConcurrentReservations,
    )
  ) {
    return false;
  }

  rebuildMemoryReservationSlotIndex();
  return true;
};

export const getAvailableSlotsForDate = async (
  dateIso: string,
  durationMinutes: number,
  maxConcurrentReservations = 1,
): Promise<string[]> => {
  seedMockReservationsInMemory();
  await cleanupExpiredProvisionalReservations();

  if (durationMinutes <= 0) {
    return [];
  }

  const serviceWindow = getServiceWindowByDate(dateIso);

  if (!serviceWindow) {
    return [];
  }

  const maxConcurrent = Math.max(1, Math.floor(maxConcurrentReservations));
  let bookedCountBySlot = new Map<string, number>();
  let blockedSet: Set<string>;

  if (shouldUseDatabase()) {
    try {
      await ensureSchema();
      const db = getPool();
      const booked = await db.query<{ slot_time: string; usage_count: string }>(
        `
        SELECT rs.slot_time, COUNT(*)::text AS usage_count
        FROM reservation_slots rs
        INNER JOIN reservations r ON r.id = rs.reservation_id
        WHERE rs.date_iso = $1 AND r.admin_status <> 'rejected'
        GROUP BY rs.slot_time
        `,
        [dateIso],
      );

      bookedCountBySlot = booked.rows.reduce((acc, row) => {
        acc.set(row.slot_time, Number(row.usage_count) || 0);
        return acc;
      }, new Map<string, number>());
      const blocked = await db.query<{ slot_time: string }>(
        'SELECT slot_time FROM admin_blocked_slots WHERE date_iso = $1',
        [dateIso],
      );

      blockedSet = new Set(blocked.rows.map((row) => row.slot_time));
    } catch (error) {
      if (!enableRuntimeMemoryMode(error)) {
        throw error;
      }

      bookedCountBySlot = getSlotUsageCountsFromMemory(dateIso);
      blockedSet = getEffectiveBlockedSlotsFromMemory(dateIso);
    }
  } else {
    bookedCountBySlot = getSlotUsageCountsFromMemory(dateIso);
    blockedSet = getEffectiveBlockedSlotsFromMemory(dateIso);
  }

  getRecurringClosedSlotsForDate(dateIso).forEach((slot) => blockedSet.add(slot));

  const { firstStartMinutes, lastStartMinutes } = serviceWindow;
  const availableSlots: string[] = [];

  for (let start = firstStartMinutes; start <= lastStartMinutes; start += STEP_MINUTES) {
    const neededSlots = buildSlotTimes(start, durationMinutes);
    const hasConflict = neededSlots.some(
      (slot) => (bookedCountBySlot.get(slot) ?? 0) >= maxConcurrent || blockedSet.has(slot),
    );

    if (!hasConflict) {
      availableSlots.push(toTime(start));
    }
  }

  return availableSlots;
};

export const createReservationWithSlots = async (
  payload: ReservaPersistRequest,
  options?: {
    allowClosedSchedule?: boolean;
    maxConcurrentReservations?: number;
  },
): Promise<{ ok: true; reservationId: string } | { ok: false; conflict: true }> => {
  seedMockReservationsInMemory();
  await cleanupExpiredProvisionalReservations();

  const startMinutes = toMinutes(payload.time);
  const endMinutes = startMinutes + payload.durationMinutes;
  const serviceWindow = getServiceWindowByDate(payload.dateIso);

  if (
    !serviceWindow ||
    Number.isNaN(startMinutes) ||
    startMinutes < serviceWindow.firstStartMinutes ||
    startMinutes > serviceWindow.lastStartMinutes ||
    payload.durationMinutes <= 0
  ) {
    throw new Error('La hora seleccionada no es válida.');
  }

  const effectiveAllowClosedSchedule = options?.allowClosedSchedule === true;
  const maxConcurrent = Math.max(1, Math.floor(options?.maxConcurrentReservations ?? 1));
  const normalizedWorkerEmail = normalizeWorkerEmail(payload.createdByEmail);

  if (!shouldUseDatabase()) {
    return createReservationWithSlotsInMemory(payload, startMinutes, options);
  }

  let client: PoolClient | null = null;
  const reservationId = `${payload.dateIso}-${startMinutes}-${Date.now()}`;
  const slotTimes = buildSlotTimes(startMinutes, payload.durationMinutes);
  const recurringClosedSlots = getRecurringClosedSlotsForDate(payload.dateIso);

  if (!effectiveAllowClosedSchedule && slotTimes.some((slot) => recurringClosedSlots.has(slot))) {
    return { ok: false, conflict: true };
  }

  try {
    await ensureSchema();

    const db = getPool();
    client = await db.connect();

    if (!client) {
      throw new Error('No se pudo obtener conexión de base de datos.');
    }

    await client.query('BEGIN');

    const expiresAtIso = getReservationExpiresAtIso({
      appointmentTypeName: payload.appointmentTypeName,
      createdAtIso: new Date().toISOString(),
      requiresReservationSignal: payload.requiresReservationSignal,
    });

    const blockedConflict = await client.query<{ slot_time: string }>(
      `
      SELECT slot_time
      FROM admin_blocked_slots
      WHERE date_iso = $1 AND slot_time = ANY($2::text[])
      LIMIT 1
      `,
      [payload.dateIso, slotTimes],
    );

    if (blockedConflict.rowCount && blockedConflict.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, conflict: true };
    }

    const activeReservationConflict = await client.query<{
      slot_time: string;
      usage_count: string;
    }>(
      `
      SELECT rs.slot_time, COUNT(*)::text AS usage_count
      FROM reservation_slots rs
      INNER JOIN reservations r ON r.id = rs.reservation_id
      WHERE rs.date_iso = $1
        AND rs.slot_time = ANY($2::text[])
        AND r.admin_status <> 'rejected'
      GROUP BY rs.slot_time
      `,
      [payload.dateIso, slotTimes],
    );

    const hasCapacityConflict = activeReservationConflict.rows.some(
      (row) => (Number(row.usage_count) || 0) >= maxConcurrent,
    );

    if (hasCapacityConflict) {
      await client.query('ROLLBACK');
      return { ok: false, conflict: true };
    }

    if (normalizedWorkerEmail) {
      const workerConflict = await client.query<{ slot_time: string }>(
        `
        SELECT rs.slot_time
        FROM reservation_slots rs
        INNER JOIN reservations r ON r.id = rs.reservation_id
        WHERE rs.date_iso = $1
          AND rs.slot_time = ANY($2::text[])
          AND r.admin_status <> 'rejected'
          AND LOWER(COALESCE(r.created_by_email, '')) = $3
        LIMIT 1
        `,
        [payload.dateIso, slotTimes, normalizedWorkerEmail],
      );

      if (workerConflict.rowCount && workerConflict.rowCount > 0) {
        await client.query('ROLLBACK');
        return { ok: false, conflict: true };
      }
    }

    await client.query(
      `
      INSERT INTO reservations (
        id,
        date_iso,
        start_time,
        end_time,
        duration_minutes,
        customer_email,
        customer_name,
        customer_phone,
        appointment_type_name,
        additional_comments,
        signal_amount_euro,
        signal_payment_method,
        signal_received_at,
        signal_registered_by_email,
        client_confirmation_status,
        created_by_email,
        expires_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      `,
      [
        reservationId,
        payload.dateIso,
        payload.time,
        toTime(endMinutes),
        payload.durationMinutes,
        payload.customerEmail,
        payload.customerName,
        payload.customerPhone,
        payload.appointmentTypeName,
        `${payload.additionalComments ?? ''}`.trim().slice(0, 500),
        0,
        null,
        null,
        null,
        'pending',
        payload.createdByEmail?.trim().toLowerCase() || null,
        expiresAtIso,
      ],
    );

    const inserted = await client.query(
      `
      INSERT INTO reservation_slots (date_iso, slot_time, reservation_id)
      SELECT $1, unnest($2::text[]), $3
      ON CONFLICT DO NOTHING
      `,
      [payload.dateIso, slotTimes, reservationId],
    );

    if (inserted.rowCount !== slotTimes.length) {
      await client.query('ROLLBACK');
      return { ok: false, conflict: true };
    }

    await client.query('COMMIT');
    return { ok: true, reservationId };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }

    if (enableRuntimeMemoryMode(error)) {
      return createReservationWithSlotsInMemory(payload, startMinutes, options);
    }

    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
};

export const deleteReservationById = async (reservationId: string): Promise<void> => {
  seedMockReservationsInMemory();

  if (!shouldUseDatabase()) {
    deleteReservationByIdInMemory(reservationId);
    return;
  }

  try {
    await ensureSchema();
    const db = getPool();
    await db.query('DELETE FROM reservations WHERE id = $1', [reservationId]);
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      deleteReservationByIdInMemory(reservationId);
      return;
    }

    throw error;
  }
};

const sortAdminReservations = (items: AdminReservationItem[]): AdminReservationItem[] =>
  items.sort((a, b) => {
    if (a.dateIso !== b.dateIso) {
      return a.dateIso.localeCompare(b.dateIso);
    }

    if (a.startTime !== b.startTime) {
      return a.startTime.localeCompare(b.startTime);
    }

    return b.createdAtIso.localeCompare(a.createdAtIso);
  });

const mapMemoryReservationToAdminItem = (reservation: MemoryReservation): AdminReservationItem => ({
  id: reservation.id,
  dateIso: reservation.dateIso,
  startTime: reservation.startTime,
  endTime: reservation.endTime,
  durationMinutes: reservation.durationMinutes,
  customerEmail: reservation.customerEmail,
  customerName: reservation.customerName,
  customerPhone: reservation.customerPhone,
  appointmentTypeName: reservation.appointmentTypeName,
  additionalComments: reservation.additionalComments,
  signalAmountEuro: reservation.signalAmountEuro,
  signalPaymentMethod: reservation.signalPaymentMethod,
  signalReceivedAtIso: reservation.signalReceivedAtIso ?? null,
  signalRegisteredByEmail: reservation.signalRegisteredByEmail ?? null,
  paymentReceived: reservation.paymentReceived,
  paymentMethod: reservation.paymentMethod ?? null,
  paymentAmountEuro: Number(reservation.paymentAmountEuro) || 0,
  adminStatus: reservation.adminStatus,
  clientConfirmationStatus: reservation.clientConfirmationStatus ?? 'pending',
  clientConfirmationReminderSentAtIso: reservation.clientConfirmationReminderSentAtIso ?? null,
  createdByEmail: reservation.createdByEmail ?? null,
  createdAtIso: reservation.createdAtIso,
});

export const listReservationsForAdmin = async (): Promise<AdminReservationItem[]> => {
  seedMockReservationsInMemory();
  await cleanupExpiredProvisionalReservations();

  if (!shouldUseDatabase()) {
    return sortAdminReservations(
      Array.from(memoryReservations.values()).map((reservation) =>
        mapMemoryReservationToAdminItem(reservation),
      ),
    );
  }

  try {
    await ensureSchema();
    const db = getPool();
    const result = await db.query<{
      id: string;
      date_iso: string;
      start_time: string;
      end_time: string;
      duration_minutes: number;
      customer_email: string;
      customer_name: string;
      customer_phone: string;
      appointment_type_name: string;
      additional_comments: string;
      signal_amount_euro: number | string;
      signal_payment_method: string | null;
      signal_received_at: string | null;
      signal_registered_by_email: string | null;
      payment_received: boolean;
      payment_method: string | null;
      payment_amount_euro: number | string;
      admin_status: string;
      client_confirmation_status: string;
      client_confirmation_reminder_sent_at: string | null;
      created_by_email: string | null;
      expires_at: string | null;
      created_at: string;
    }>(`
      SELECT
        id,
        date_iso,
        start_time,
        end_time,
        duration_minutes,
        customer_email,
        customer_name,
        customer_phone,
        appointment_type_name,
        additional_comments,
        signal_amount_euro,
        signal_payment_method,
        signal_received_at,
        signal_registered_by_email,
        payment_received,
        payment_method,
        payment_amount_euro,
        admin_status,
        client_confirmation_status,
        client_confirmation_reminder_sent_at,
        created_by_email,
        expires_at,
        created_at
      FROM reservations
      ORDER BY date_iso ASC, start_time ASC, created_at DESC
    `);

    return result.rows.map((row) => ({
      id: row.id,
      dateIso: row.date_iso,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMinutes: row.duration_minutes,
      customerEmail: row.customer_email,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      appointmentTypeName: row.appointment_type_name,
      additionalComments: row.additional_comments,
      signalAmountEuro: Number(row.signal_amount_euro) || 0,
      signalPaymentMethod:
        row.signal_payment_method === 'efectivo' ||
        row.signal_payment_method === 'tarjeta' ||
        row.signal_payment_method === 'bizum'
          ? row.signal_payment_method
          : null,
      signalReceivedAtIso: row.signal_received_at,
      signalRegisteredByEmail: row.signal_registered_by_email,
      paymentReceived: row.payment_received,
      paymentMethod:
        row.payment_method === 'efectivo' ||
        row.payment_method === 'tarjeta' ||
        row.payment_method === 'bizum'
          ? row.payment_method
          : null,
      paymentAmountEuro: Number(row.payment_amount_euro) || 0,
      adminStatus: row.admin_status as AdminReservationStatus,
      clientConfirmationStatus: row.client_confirmation_status as ClientConfirmationStatus,
      clientConfirmationReminderSentAtIso: row.client_confirmation_reminder_sent_at,
      createdByEmail: row.created_by_email,
      expiresAtIso: row.expires_at,
      createdAtIso: new Date(row.created_at).toISOString(),
    }));
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return sortAdminReservations(
        Array.from(memoryReservations.values()).map((reservation) =>
          mapMemoryReservationToAdminItem(reservation),
        ),
      );
    }

    throw error;
  }
};

export const getReservationByIdForAdmin = async (
  reservationId: string,
): Promise<AdminReservationItem | null> => {
  const reservations = await listReservationsForAdmin();
  return reservations.find((item) => item.id === reservationId) ?? null;
};

export const markReservationClientReminderSentAt = async (
  reservationId: string,
  sentAtIso: string,
): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> => {
  if (!shouldUseDatabase()) {
    const reservation = memoryReservations.get(reservationId);

    if (!reservation) {
      return { ok: false, reason: 'not-found' };
    }

    reservation.clientConfirmationReminderSentAtIso = sentAtIso;
    memoryReservations.set(reservationId, reservation);
    saveMemoryToFile();
    return { ok: true };
  }

  try {
    await ensureSchema();
    const db = getPool();
    const updated = await db.query(
      `
      UPDATE reservations
      SET client_confirmation_reminder_sent_at = $2
      WHERE id = $1
      `,
      [reservationId, sentAtIso],
    );

    if (updated.rowCount === 0) {
      return { ok: false, reason: 'not-found' };
    }

    return { ok: true };
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      const reservation = memoryReservations.get(reservationId);

      if (!reservation) {
        return { ok: false, reason: 'not-found' };
      }

      reservation.clientConfirmationReminderSentAtIso = sentAtIso;
      memoryReservations.set(reservationId, reservation);
      saveMemoryToFile();
      return { ok: true };
    }

    throw error;
  }
};

export const updateReservationClientConfirmationStatus = async (
  reservationId: string,
  status: ClientConfirmationStatus,
): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> => {
  if (!shouldUseDatabase()) {
    const reservation = memoryReservations.get(reservationId);

    if (!reservation) {
      return { ok: false, reason: 'not-found' };
    }

    reservation.clientConfirmationStatus = status;
    memoryReservations.set(reservationId, reservation);
    saveMemoryToFile();
    return { ok: true };
  }

  try {
    await ensureSchema();
    const db = getPool();
    const updated = await db.query(
      `
      UPDATE reservations
      SET client_confirmation_status = $2
      WHERE id = $1
      `,
      [reservationId, status],
    );

    if (updated.rowCount === 0) {
      return { ok: false, reason: 'not-found' };
    }

    return { ok: true };
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      const reservation = memoryReservations.get(reservationId);

      if (!reservation) {
        return { ok: false, reason: 'not-found' };
      }

      reservation.clientConfirmationStatus = status;
      memoryReservations.set(reservationId, reservation);
      saveMemoryToFile();
      return { ok: true };
    }

    throw error;
  }
};

export const updateReservationPaymentReceived = async (
  reservationId: string,
  paymentReceived: boolean,
  options?: {
    paymentMethod?: ReservationSignalPaymentMethod;
    paymentAmountEuro?: number;
  },
): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> => {
  const nextPaymentMethod =
    options?.paymentMethod === 'efectivo' ||
    options?.paymentMethod === 'tarjeta' ||
    options?.paymentMethod === 'bizum'
      ? options.paymentMethod
      : null;
  const nextPaymentAmountEuro = Number(options?.paymentAmountEuro ?? 0);
  const safePaymentAmountEuro =
    Number.isFinite(nextPaymentAmountEuro) && nextPaymentAmountEuro > 0
      ? Number(nextPaymentAmountEuro.toFixed(2))
      : 0;

  if (!shouldUseDatabase()) {
    const reservation = memoryReservations.get(reservationId);

    if (!reservation) {
      return { ok: false, reason: 'not-found' };
    }

    reservation.paymentReceived = paymentReceived;

    if (!paymentReceived) {
      reservation.paymentMethod = null;
      reservation.paymentAmountEuro = 0;
    } else if (nextPaymentMethod) {
      reservation.paymentMethod = nextPaymentMethod;
      reservation.paymentAmountEuro = safePaymentAmountEuro;
    }

    if (!paymentReceived) {
      reservation.adminStatus = 'pending';
    }

    memoryReservations.set(reservationId, reservation);
    saveMemoryToFile();
    return { ok: true };
  }

  try {
    await ensureSchema();
    const db = getPool();
    const updated = await db.query(
      `
      UPDATE reservations
      SET payment_received = $2,
          payment_method = CASE
            WHEN $2 = false THEN NULL
            WHEN $3::text IN ('efectivo', 'tarjeta', 'bizum') THEN $3::text
            ELSE payment_method
          END,
          payment_amount_euro = CASE
            WHEN $2 = false THEN 0
            WHEN $3::text IN ('efectivo', 'tarjeta', 'bizum') THEN $4
            ELSE payment_amount_euro
          END,
          admin_status = CASE WHEN $2 = false THEN 'pending' ELSE admin_status END
      WHERE id = $1
      `,
      [reservationId, paymentReceived, nextPaymentMethod, safePaymentAmountEuro],
    );

    if (updated.rowCount === 0) {
      return { ok: false, reason: 'not-found' };
    }

    return { ok: true };
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      const reservation = memoryReservations.get(reservationId);

      if (!reservation) {
        return { ok: false, reason: 'not-found' };
      }

      reservation.paymentReceived = paymentReceived;

      if (!paymentReceived) {
        reservation.paymentMethod = null;
        reservation.paymentAmountEuro = 0;
      } else if (nextPaymentMethod) {
        reservation.paymentMethod = nextPaymentMethod;
        reservation.paymentAmountEuro = safePaymentAmountEuro;
      }

      if (!paymentReceived) {
        reservation.adminStatus = 'pending';
      }

      memoryReservations.set(reservationId, reservation);
      saveMemoryToFile();
      return { ok: true };
    }

    throw error;
  }
};

export const registerReservationSignalPayment = async (
  reservationId: string,
  payload: {
    amountEuro: number;
    paymentMethod: ReservationSignalPaymentMethod;
    receivedAtIso: string;
    registeredByEmail?: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'already-recorded' }> => {
  const safeAmount = Number(payload.amountEuro.toFixed(2));
  const safeRegisteredByEmail = payload.registeredByEmail?.trim().toLowerCase() || null;

  if (!shouldUseDatabase()) {
    const reservation = memoryReservations.get(reservationId);

    if (!reservation) {
      return { ok: false, reason: 'not-found' };
    }

    if ((reservation.signalAmountEuro ?? 0) > 0) {
      return { ok: false, reason: 'already-recorded' };
    }

    reservation.signalAmountEuro = safeAmount;
    reservation.signalPaymentMethod = payload.paymentMethod;
    reservation.signalReceivedAtIso = payload.receivedAtIso;
    reservation.signalRegisteredByEmail = safeRegisteredByEmail;
    memoryReservations.set(reservationId, reservation);
    saveMemoryToFile();
    return { ok: true };
  }

  try {
    await ensureSchema();
    const db = getPool();
    const current = await db.query<{ id: string; signal_amount_euro: number | string }>(
      'SELECT id, signal_amount_euro FROM reservations WHERE id = $1',
      [reservationId],
    );

    if (current.rowCount === 0) {
      return { ok: false, reason: 'not-found' };
    }

    if ((Number(current.rows[0]?.signal_amount_euro) || 0) > 0) {
      return { ok: false, reason: 'already-recorded' };
    }

    const updated = await db.query(
      `
      UPDATE reservations
      SET signal_amount_euro = $2,
          signal_payment_method = $3,
          signal_received_at = $4,
          signal_registered_by_email = $5
      WHERE id = $1
        AND COALESCE(signal_amount_euro, 0) <= 0
      `,
      [
        reservationId,
        safeAmount,
        payload.paymentMethod,
        payload.receivedAtIso,
        safeRegisteredByEmail,
      ],
    );

    if ((updated.rowCount ?? 0) === 0) {
      return { ok: false, reason: 'already-recorded' };
    }

    return { ok: true };
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      const reservation = memoryReservations.get(reservationId);

      if (!reservation) {
        return { ok: false, reason: 'not-found' };
      }

      if ((reservation.signalAmountEuro ?? 0) > 0) {
        return { ok: false, reason: 'already-recorded' };
      }

      reservation.signalAmountEuro = safeAmount;
      reservation.signalPaymentMethod = payload.paymentMethod;
      reservation.signalReceivedAtIso = payload.receivedAtIso;
      reservation.signalRegisteredByEmail = safeRegisteredByEmail;
      memoryReservations.set(reservationId, reservation);
      saveMemoryToFile();
      return { ok: true };
    }

    throw error;
  }
};

export const updateReservationAdminStatus = async (
  reservationId: string,
  status: AdminReservationStatus,
  options?: {
    maxConcurrentReservations?: number;
    assigneeEmail?: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'slot-conflict' }> => {
  await cleanupExpiredProvisionalReservations();
  const maxConcurrent = Math.max(1, Math.floor(options?.maxConcurrentReservations ?? 1));
  const normalizedAssignee = normalizeWorkerEmail(options?.assigneeEmail);

  if (!shouldUseDatabase()) {
    const reservation = memoryReservations.get(reservationId);

    if (!reservation) {
      return { ok: false, reason: 'not-found' };
    }

    const targetWorkerEmail =
      normalizedAssignee || normalizeWorkerEmail(reservation.createdByEmail);

    if (
      status === 'accepted' &&
      hasCapacityConflictInMemory(
        reservationId,
        reservation.dateIso,
        reservation.slots,
        maxConcurrent,
      )
    ) {
      return { ok: false, reason: 'slot-conflict' };
    }

    if (
      status === 'accepted' &&
      targetWorkerEmail &&
      hasWorkerConflictInMemory(
        reservationId,
        reservation.dateIso,
        reservation.slots,
        targetWorkerEmail,
      )
    ) {
      return { ok: false, reason: 'slot-conflict' };
    }

    if (status === 'accepted' && reservation.adminStatus === 'rejected') {
      const reserved = reserveReservationSlotsInMemory(reservationId, maxConcurrent);

      if (!reserved) {
        return { ok: false, reason: 'slot-conflict' };
      }
    }

    if (status === 'rejected') {
      releaseReservationSlotsInMemory(reservationId);
    }

    if (normalizedAssignee) {
      reservation.createdByEmail = normalizedAssignee;
    }

    reservation.adminStatus = status;
    memoryReservations.set(reservationId, reservation);
    saveMemoryToFile();
    return { ok: true };
  }

  try {
    await ensureSchema();
    const db = getPool();
    const current = await db.query<{
      payment_received: boolean;
      admin_status: string;
      date_iso: string;
      start_time: string;
      duration_minutes: number;
      created_by_email: string | null;
    }>(
      'SELECT payment_received, admin_status, date_iso, start_time, duration_minutes, created_by_email FROM reservations WHERE id = $1',
      [reservationId],
    );

    if (current.rowCount === 0) {
      return { ok: false, reason: 'not-found' };
    }

    const currentReservation = current.rows[0];
    const slotTimes = buildSlotTimes(
      toMinutes(currentReservation.start_time),
      currentReservation.duration_minutes,
    );
    const targetWorkerEmail =
      normalizedAssignee || normalizeWorkerEmail(currentReservation.created_by_email);

    if (status === 'accepted') {
      const slotUsage = await db.query<{ slot_time: string; usage_count: string }>(
        `
        SELECT rs.slot_time, COUNT(*)::text AS usage_count
        FROM reservation_slots rs
        INNER JOIN reservations r ON r.id = rs.reservation_id
        WHERE rs.date_iso = $1
          AND rs.slot_time = ANY($2::text[])
          AND rs.reservation_id <> $3
          AND r.admin_status <> 'rejected'
        GROUP BY rs.slot_time
        `,
        [currentReservation.date_iso, slotTimes, reservationId],
      );

      if (slotUsage.rows.some((row) => (Number(row.usage_count) || 0) >= maxConcurrent)) {
        return { ok: false, reason: 'slot-conflict' };
      }

      if (targetWorkerEmail) {
        const workerConflict = await db.query<{ slot_time: string }>(
          `
          SELECT rs.slot_time
          FROM reservation_slots rs
          INNER JOIN reservations r ON r.id = rs.reservation_id
          WHERE rs.date_iso = $1
            AND rs.slot_time = ANY($2::text[])
            AND rs.reservation_id <> $3
            AND r.admin_status <> 'rejected'
            AND LOWER(COALESCE(r.created_by_email, '')) = $4
          LIMIT 1
          `,
          [currentReservation.date_iso, slotTimes, reservationId, targetWorkerEmail],
        );

        if (workerConflict.rowCount && workerConflict.rowCount > 0) {
          return { ok: false, reason: 'slot-conflict' };
        }
      }
    }

    if (status === 'accepted' && currentReservation?.admin_status === 'rejected') {
      await db.query(
        `
        INSERT INTO reservation_slots (date_iso, slot_time, reservation_id)
        SELECT $1, unnest($2::text[]), $3
        ON CONFLICT DO NOTHING
        `,
        [currentReservation.date_iso, slotTimes, reservationId],
      );
    }

    if (status === 'rejected') {
      await db.query('DELETE FROM reservation_slots WHERE reservation_id = $1', [reservationId]);
    }

    if (normalizedAssignee) {
      await db.query('UPDATE reservations SET created_by_email = $2 WHERE id = $1', [
        reservationId,
        normalizedAssignee,
      ]);
    }

    await db.query('UPDATE reservations SET admin_status = $2 WHERE id = $1', [
      reservationId,
      status,
    ]);
    return { ok: true };
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      const reservation = memoryReservations.get(reservationId);

      if (!reservation) {
        return { ok: false, reason: 'not-found' };
      }

      const targetWorkerEmail =
        normalizedAssignee || normalizeWorkerEmail(reservation.createdByEmail);

      if (
        status === 'accepted' &&
        hasCapacityConflictInMemory(
          reservationId,
          reservation.dateIso,
          reservation.slots,
          maxConcurrent,
        )
      ) {
        return { ok: false, reason: 'slot-conflict' };
      }

      if (
        status === 'accepted' &&
        targetWorkerEmail &&
        hasWorkerConflictInMemory(
          reservationId,
          reservation.dateIso,
          reservation.slots,
          targetWorkerEmail,
        )
      ) {
        return { ok: false, reason: 'slot-conflict' };
      }

      if (status === 'accepted' && reservation.adminStatus === 'rejected') {
        const reserved = reserveReservationSlotsInMemory(reservationId, maxConcurrent);

        if (!reserved) {
          return { ok: false, reason: 'slot-conflict' };
        }
      }

      if (status === 'rejected') {
        releaseReservationSlotsInMemory(reservationId);
      }

      if (normalizedAssignee) {
        reservation.createdByEmail = normalizedAssignee;
      }

      reservation.adminStatus = status;
      memoryReservations.set(reservationId, reservation);
      saveMemoryToFile();
      return { ok: true };
    }

    throw error;
  }
};

export const assignReservationToWorker = async (
  reservationId: string,
  workerEmail: string,
): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'slot-conflict' }> => {
  await cleanupExpiredProvisionalReservations();
  const normalizedWorkerEmail = normalizeWorkerEmail(workerEmail);

  if (!normalizedWorkerEmail) {
    return { ok: false, reason: 'slot-conflict' };
  }

  if (!shouldUseDatabase()) {
    const reservation = memoryReservations.get(reservationId);

    if (!reservation) {
      return { ok: false, reason: 'not-found' };
    }

    if (
      reservation.adminStatus !== 'rejected' &&
      hasWorkerConflictInMemory(
        reservationId,
        reservation.dateIso,
        reservation.slots,
        normalizedWorkerEmail,
      )
    ) {
      return { ok: false, reason: 'slot-conflict' };
    }

    reservation.createdByEmail = normalizedWorkerEmail;
    memoryReservations.set(reservationId, reservation);
    saveMemoryToFile();
    return { ok: true };
  }

  let client: PoolClient | null = null;

  try {
    await ensureSchema();
    const db = getPool();
    client = await db.connect();

    if (!client) {
      throw new Error('No se pudo obtener conexión de base de datos.');
    }

    await client.query('BEGIN');

    const current = await client.query<{
      date_iso: string;
      start_time: string;
      duration_minutes: number;
      admin_status: string;
    }>(
      `
      SELECT date_iso, start_time, duration_minutes, admin_status
      FROM reservations
      WHERE id = $1
      FOR UPDATE
      `,
      [reservationId],
    );

    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not-found' };
    }

    const reservation = current.rows[0];

    if (reservation.admin_status !== 'rejected') {
      const slotTimes = buildSlotTimes(
        toMinutes(reservation.start_time),
        reservation.duration_minutes,
      );

      const workerConflict = await client.query<{ slot_time: string }>(
        `
        SELECT rs.slot_time
        FROM reservation_slots rs
        INNER JOIN reservations r ON r.id = rs.reservation_id
        WHERE rs.date_iso = $1
          AND rs.slot_time = ANY($2::text[])
          AND rs.reservation_id <> $3
          AND r.admin_status <> 'rejected'
          AND LOWER(COALESCE(r.created_by_email, '')) = $4
        LIMIT 1
        `,
        [reservation.date_iso, slotTimes, reservationId, normalizedWorkerEmail],
      );

      if (workerConflict.rowCount && workerConflict.rowCount > 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'slot-conflict' };
      }
    }

    await client.query('UPDATE reservations SET created_by_email = $2 WHERE id = $1', [
      reservationId,
      normalizedWorkerEmail,
    ]);

    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => undefined);
    }

    if (enableRuntimeMemoryMode(error)) {
      const reservation = memoryReservations.get(reservationId);

      if (!reservation) {
        return { ok: false, reason: 'not-found' };
      }

      if (
        reservation.adminStatus !== 'rejected' &&
        hasWorkerConflictInMemory(
          reservationId,
          reservation.dateIso,
          reservation.slots,
          normalizedWorkerEmail,
        )
      ) {
        return { ok: false, reason: 'slot-conflict' };
      }

      reservation.createdByEmail = normalizedWorkerEmail;
      memoryReservations.set(reservationId, reservation);
      saveMemoryToFile();
      return { ok: true };
    }

    throw error;
  } finally {
    client?.release();
  }
};

export const updateReservationByAdmin = async (
  reservationId: string,
  payload: {
    dateIso: string;
    startTime: string;
    durationMinutes: number;
    appointmentTypeName: string;
    customerName: string;
    customerPhone: string;
    customerEmail: string;
    additionalComments?: string;
  },
  options?: {
    allowClosedSchedule?: boolean;
    maxConcurrentReservations?: number;
  },
): Promise<
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'invalid-time' | 'slot-conflict' | 'blocked-conflict' }
> => {
  await cleanupExpiredProvisionalReservations();

  const startMinutes = toMinutes(payload.startTime);
  const endMinutes = startMinutes + payload.durationMinutes;
  const serviceWindow = getServiceWindowByDate(payload.dateIso);

  if (
    !serviceWindow ||
    Number.isNaN(startMinutes) ||
    payload.durationMinutes <= 0 ||
    startMinutes < serviceWindow.firstStartMinutes ||
    startMinutes > serviceWindow.lastStartMinutes ||
    startMinutes % STEP_MINUTES !== 0 ||
    payload.durationMinutes % STEP_MINUTES !== 0
  ) {
    return { ok: false, reason: 'invalid-time' };
  }

  const endTime = toTime(endMinutes);
  const nextSlots = buildSlotTimes(startMinutes, payload.durationMinutes);
  const effectiveAllowClosedSchedule = options?.allowClosedSchedule === true;
  const maxConcurrent = Math.max(1, Math.floor(options?.maxConcurrentReservations ?? 1));

  if (!shouldUseDatabase()) {
    const reservation = memoryReservations.get(reservationId);

    if (!reservation) {
      return { ok: false, reason: 'not-found' };
    }

    const blockedSlots = effectiveAllowClosedSchedule
      ? getBlockedSlotsFromMemory(payload.dateIso)
      : getEffectiveBlockedSlotsFromMemory(payload.dateIso);

    if (nextSlots.some((slot) => blockedSlots.has(slot))) {
      return { ok: false, reason: 'blocked-conflict' };
    }

    const hasSlotConflict = hasCapacityConflictInMemory(
      reservationId,
      payload.dateIso,
      nextSlots,
      maxConcurrent,
    );

    const assignedWorker = normalizeWorkerEmail(reservation.createdByEmail);
    const hasWorkerConflict = hasWorkerConflictInMemory(
      reservationId,
      payload.dateIso,
      nextSlots,
      assignedWorker,
    );

    if (reservation.adminStatus !== 'rejected' && (hasSlotConflict || hasWorkerConflict)) {
      return { ok: false, reason: 'slot-conflict' };
    }

    reservation.dateIso = payload.dateIso;
    reservation.startTime = payload.startTime;
    reservation.endTime = endTime;
    reservation.durationMinutes = payload.durationMinutes;
    reservation.appointmentTypeName = payload.appointmentTypeName;
    reservation.customerName = payload.customerName;
    reservation.customerPhone = payload.customerPhone;
    reservation.customerEmail = payload.customerEmail;
    reservation.slots = nextSlots;

    memoryReservations.set(reservationId, reservation);
    rebuildMemoryReservationSlotIndex();
    saveMemoryToFile();
    return { ok: true };
  }

  let client: PoolClient | null = null;

  try {
    await ensureSchema();
    const db = getPool();
    client = await db.connect();

    if (!client) {
      throw new Error('No se pudo obtener conexión de base de datos.');
    }

    await client.query('BEGIN');

    const current = await client.query<{
      id: string;
      admin_status: string;
    }>('SELECT id, admin_status FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);

    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not-found' };
    }

    const blockedConflict = await client.query<{ slot_time: string }>(
      `
      SELECT slot_time
      FROM admin_blocked_slots
      WHERE date_iso = $1 AND slot_time = ANY($2::text[])
      LIMIT 1
      `,
      [payload.dateIso, nextSlots],
    );

    if (blockedConflict.rowCount && blockedConflict.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'blocked-conflict' };
    }

    if (!effectiveAllowClosedSchedule) {
      const recurringClosedSlots = getRecurringClosedSlotsForDate(payload.dateIso);

      if (nextSlots.some((slot) => recurringClosedSlots.has(slot))) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'blocked-conflict' };
      }
    }

    const adminStatus = (current.rows[0]?.admin_status ?? 'pending') as AdminReservationStatus;

    if (adminStatus !== 'rejected') {
      const slotConflict = await client.query<{ slot_time: string; usage_count: string }>(
        `
        SELECT rs.slot_time, COUNT(*)::text AS usage_count
        FROM reservation_slots rs
        INNER JOIN reservations r ON r.id = rs.reservation_id
        WHERE rs.date_iso = $1
          AND rs.slot_time = ANY($2::text[])
          AND rs.reservation_id <> $3
          AND r.admin_status <> 'rejected'
        GROUP BY rs.slot_time
        `,
        [payload.dateIso, nextSlots, reservationId],
      );

      if (slotConflict.rows.some((row) => (Number(row.usage_count) || 0) >= maxConcurrent)) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'slot-conflict' };
      }

      const workerConflict = await client.query<{ slot_time: string }>(
        `
        SELECT rs.slot_time
        FROM reservation_slots rs
        INNER JOIN reservations r ON r.id = rs.reservation_id
        INNER JOIN reservations current_reservation ON current_reservation.id = $3
        WHERE rs.date_iso = $1
          AND rs.slot_time = ANY($2::text[])
          AND rs.reservation_id <> $3
          AND r.admin_status <> 'rejected'
          AND LOWER(COALESCE(r.created_by_email, '')) = LOWER(COALESCE(current_reservation.created_by_email, ''))
          AND COALESCE(current_reservation.created_by_email, '') <> ''
        LIMIT 1
        `,
        [payload.dateIso, nextSlots, reservationId],
      );

      if (workerConflict.rowCount && workerConflict.rowCount > 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'slot-conflict' };
      }
    }

    await client.query(
      `
      UPDATE reservations
      SET date_iso = $2,
          start_time = $3,
          end_time = $4,
          duration_minutes = $5,
          appointment_type_name = $6,
          customer_name = $7,
          customer_phone = $8,
          customer_email = $9,
          additional_comments = COALESCE($10, additional_comments)
      WHERE id = $1
      `,
      [
        reservationId,
        payload.dateIso,
        payload.startTime,
        endTime,
        payload.durationMinutes,
        payload.appointmentTypeName,
        payload.customerName,
        payload.customerPhone,
        payload.customerEmail,
        payload.additionalComments?.trim().slice(0, 500) ?? null,
      ],
    );

    await client.query('DELETE FROM reservation_slots WHERE reservation_id = $1', [reservationId]);

    if (adminStatus !== 'rejected') {
      const inserted = await client.query(
        `
        INSERT INTO reservation_slots (date_iso, slot_time, reservation_id)
        SELECT $1, unnest($2::text[]), $3
        ON CONFLICT DO NOTHING
        `,
        [payload.dateIso, nextSlots, reservationId],
      );

      if (inserted.rowCount !== nextSlots.length) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'slot-conflict' };
      }
    }

    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }

    if (enableRuntimeMemoryMode(error)) {
      const reservation = memoryReservations.get(reservationId);

      if (!reservation) {
        return { ok: false, reason: 'not-found' };
      }

      const blockedSlots = effectiveAllowClosedSchedule
        ? getBlockedSlotsFromMemory(payload.dateIso)
        : getEffectiveBlockedSlotsFromMemory(payload.dateIso);

      if (nextSlots.some((slot) => blockedSlots.has(slot))) {
        return { ok: false, reason: 'blocked-conflict' };
      }

      const hasSlotConflict = hasCapacityConflictInMemory(
        reservationId,
        payload.dateIso,
        nextSlots,
        maxConcurrent,
      );

      const assignedWorker = normalizeWorkerEmail(reservation.createdByEmail);
      const hasWorkerConflict = hasWorkerConflictInMemory(
        reservationId,
        payload.dateIso,
        nextSlots,
        assignedWorker,
      );

      if (reservation.adminStatus !== 'rejected' && (hasSlotConflict || hasWorkerConflict)) {
        return { ok: false, reason: 'slot-conflict' };
      }

      reservation.dateIso = payload.dateIso;
      reservation.startTime = payload.startTime;
      reservation.endTime = endTime;
      reservation.durationMinutes = payload.durationMinutes;
      reservation.appointmentTypeName = payload.appointmentTypeName;
      reservation.customerName = payload.customerName;
      reservation.customerPhone = payload.customerPhone;
      reservation.customerEmail = payload.customerEmail;
      reservation.additionalComments =
        payload.additionalComments !== undefined
          ? payload.additionalComments.trim().slice(0, 500)
          : reservation.additionalComments;
      reservation.slots = nextSlots;

      memoryReservations.set(reservationId, reservation);
      rebuildMemoryReservationSlotIndex();
      return { ok: true };
    }

    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
};

const sortBlockedPeriods = (items: AdminBlockedPeriodItem[]): AdminBlockedPeriodItem[] =>
  items.sort((a, b) => {
    if (a.dateIso !== b.dateIso) {
      return a.dateIso.localeCompare(b.dateIso);
    }

    if (a.startTime !== b.startTime) {
      return a.startTime.localeCompare(b.startTime);
    }

    return b.createdAtIso.localeCompare(a.createdAtIso);
  });

const mapMemoryBlockedPeriodToAdminItem = (
  blockedPeriod: MemoryBlockedPeriod,
): AdminBlockedPeriodItem => ({
  id: blockedPeriod.id,
  dateIso: blockedPeriod.dateIso,
  startTime: blockedPeriod.startTime,
  endTime: blockedPeriod.endTime,
  reason: blockedPeriod.reason,
  createdAtIso: blockedPeriod.createdAtIso,
});

const createBlockedPeriodInMemory = (payload: {
  dateIso: string;
  startTime: string;
  endTime: string;
  reason: string;
}):
  | { ok: true; blockId: string }
  | { ok: false; reason: 'invalid-time' | 'reservation-conflict' | 'block-conflict' } => {
  const startMinutes = toMinutes(payload.startTime);
  const endMinutes = toMinutes(payload.endTime);
  const serviceWindow = getServiceWindowByDate(payload.dateIso);
  const latestEndMinutes = serviceWindow ? serviceWindow.lastStartMinutes + STEP_MINUTES : 0;

  if (
    !serviceWindow ||
    Number.isNaN(startMinutes) ||
    Number.isNaN(endMinutes) ||
    startMinutes < serviceWindow.firstStartMinutes ||
    endMinutes > latestEndMinutes ||
    endMinutes <= startMinutes ||
    startMinutes % STEP_MINUTES !== 0 ||
    endMinutes % STEP_MINUTES !== 0
  ) {
    return { ok: false, reason: 'invalid-time' };
  }

  const slotTimes = buildSlotTimesFromRange(startMinutes, endMinutes);

  if (slotTimes.length === 0) {
    return { ok: false, reason: 'invalid-time' };
  }

  const reservationSlots = memorySlotsByDate.get(payload.dateIso) ?? new Set<string>();

  if (slotTimes.some((slot) => reservationSlots.has(slot))) {
    return { ok: false, reason: 'reservation-conflict' };
  }

  const blockedSlots = memoryBlockedSlotsByDate.get(payload.dateIso) ?? new Set<string>();

  if (slotTimes.some((slot) => blockedSlots.has(slot))) {
    return { ok: false, reason: 'block-conflict' };
  }

  const blockId = `${payload.dateIso}-${startMinutes}-${Date.now()}-blk`;
  slotTimes.forEach((slot) => blockedSlots.add(slot));
  memoryBlockedSlotsByDate.set(payload.dateIso, blockedSlots);

  memoryBlockedPeriods.set(blockId, {
    id: blockId,
    dateIso: payload.dateIso,
    startTime: payload.startTime,
    endTime: payload.endTime,
    reason: normalizeBlockReason(payload.reason),
    createdAtIso: new Date().toISOString(),
    slots: slotTimes,
  });

  return { ok: true, blockId };
};

const deleteBlockedPeriodInMemory = (blockId: string): boolean => {
  const blockedPeriod = memoryBlockedPeriods.get(blockId);

  if (!blockedPeriod) {
    return false;
  }

  const blockedSlots = memoryBlockedSlotsByDate.get(blockedPeriod.dateIso);

  if (blockedSlots) {
    blockedPeriod.slots.forEach((slot) => blockedSlots.delete(slot));

    if (blockedSlots.size === 0) {
      memoryBlockedSlotsByDate.delete(blockedPeriod.dateIso);
    } else {
      memoryBlockedSlotsByDate.set(blockedPeriod.dateIso, blockedSlots);
    }
  }

  memoryBlockedPeriods.delete(blockId);
  return true;
};

export const listBlockedPeriodsForAdmin = async (): Promise<AdminBlockedPeriodItem[]> => {
  if (!shouldUseDatabase()) {
    return sortBlockedPeriods(
      Array.from(memoryBlockedPeriods.values()).map((blockedPeriod) =>
        mapMemoryBlockedPeriodToAdminItem(blockedPeriod),
      ),
    );
  }

  try {
    await ensureSchema();
    const db = getPool();
    const result = await db.query<{
      id: string;
      date_iso: string;
      start_time: string;
      end_time: string;
      reason: string;
      created_at: string;
    }>(`
      SELECT
        id,
        date_iso,
        start_time,
        end_time,
        reason,
        created_at
      FROM admin_block_periods
      ORDER BY date_iso ASC, start_time ASC, created_at DESC
    `);

    return result.rows.map((row) => ({
      id: row.id,
      dateIso: row.date_iso,
      startTime: row.start_time,
      endTime: row.end_time,
      reason: row.reason,
      createdAtIso: new Date(row.created_at).toISOString(),
    }));
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return sortBlockedPeriods(
        Array.from(memoryBlockedPeriods.values()).map((blockedPeriod) =>
          mapMemoryBlockedPeriodToAdminItem(blockedPeriod),
        ),
      );
    }

    throw error;
  }
};

export const createBlockedPeriodForAdmin = async (payload: {
  dateIso: string;
  startTime: string;
  endTime: string;
  reason: string;
}): Promise<
  | { ok: true; blockId: string }
  | { ok: false; reason: 'invalid-time' | 'reservation-conflict' | 'block-conflict' }
> => {
  if (!shouldUseDatabase()) {
    return createBlockedPeriodInMemory(payload);
  }

  const startMinutes = toMinutes(payload.startTime);
  const endMinutes = toMinutes(payload.endTime);
  const serviceWindow = getServiceWindowByDate(payload.dateIso);
  const latestEndMinutes = serviceWindow ? serviceWindow.lastStartMinutes + STEP_MINUTES : 0;

  if (
    !serviceWindow ||
    Number.isNaN(startMinutes) ||
    Number.isNaN(endMinutes) ||
    startMinutes < serviceWindow.firstStartMinutes ||
    endMinutes > latestEndMinutes ||
    endMinutes <= startMinutes ||
    startMinutes % STEP_MINUTES !== 0 ||
    endMinutes % STEP_MINUTES !== 0
  ) {
    return { ok: false, reason: 'invalid-time' };
  }

  const slotTimes = buildSlotTimesFromRange(startMinutes, endMinutes);

  if (slotTimes.length === 0) {
    return { ok: false, reason: 'invalid-time' };
  }

  let client: PoolClient | null = null;
  const blockId = `${payload.dateIso}-${startMinutes}-${Date.now()}-blk`;

  try {
    await ensureSchema();

    const db = getPool();
    client = await db.connect();

    if (!client) {
      throw new Error('No se pudo obtener conexión de base de datos.');
    }

    await client.query('BEGIN');

    const reservationConflict = await client.query<{ slot_time: string }>(
      `
      SELECT rs.slot_time
      FROM reservation_slots rs
      INNER JOIN reservations r ON r.id = rs.reservation_id
      WHERE rs.date_iso = $1 AND rs.slot_time = ANY($2::text[]) AND r.admin_status <> 'rejected'
      LIMIT 1
      `,
      [payload.dateIso, slotTimes],
    );

    if (reservationConflict.rowCount && reservationConflict.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'reservation-conflict' };
    }

    await client.query(
      `
      INSERT INTO admin_block_periods (
        id,
        date_iso,
        start_time,
        end_time,
        reason
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        blockId,
        payload.dateIso,
        payload.startTime,
        payload.endTime,
        normalizeBlockReason(payload.reason),
      ],
    );

    const inserted = await client.query(
      `
      INSERT INTO admin_blocked_slots (date_iso, slot_time, block_id)
      SELECT $1, unnest($2::text[]), $3
      ON CONFLICT DO NOTHING
      `,
      [payload.dateIso, slotTimes, blockId],
    );

    if (inserted.rowCount !== slotTimes.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'block-conflict' };
    }

    await client.query('COMMIT');
    return { ok: true, blockId };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }

    if (enableRuntimeMemoryMode(error)) {
      return createBlockedPeriodInMemory(payload);
    }

    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
};

export const deleteBlockedPeriodForAdmin = async (
  blockId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> => {
  if (!shouldUseDatabase()) {
    const deleted = deleteBlockedPeriodInMemory(blockId);

    if (!deleted) {
      return { ok: false, reason: 'not-found' };
    }

    return { ok: true };
  }

  try {
    await ensureSchema();
    const db = getPool();
    const deleted = await db.query('DELETE FROM admin_block_periods WHERE id = $1', [blockId]);

    if (deleted.rowCount === 0) {
      return { ok: false, reason: 'not-found' };
    }

    return { ok: true };
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      const deleted = deleteBlockedPeriodInMemory(blockId);

      if (!deleted) {
        return { ok: false, reason: 'not-found' };
      }

      return { ok: true };
    }

    throw error;
  }
};

// ===== APP USERS & CLIENT CARDS DB PERSISTENCE =====

export interface DbAppUser {
  id: string;
  email: string;
  username: string;
  usernameLower: string;
  passwordHash: string;
  role: string;
  createdAtIso: string;
  tracking: unknown;
  permissions?: unknown;
}

export interface DbClientCard {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  birthDateIso?: string;
  notes: string;
  createdAtIso: string;
  createdByEmail: string;
  treatments: unknown;
  passwordHash?: string;
}

export interface DbStockProduct {
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

export interface DbPaymentOperationDetail {
  id: string;
  operationType: 'stock_sale' | 'client_pack_payment' | 'reservation_payment';
  concept: string;
  amount: number;
  paymentMethod: 'efectivo' | 'tarjeta' | 'bizum';
  performedByEmail: string;
  createdAtIso: string;
}

export interface DbCierreCaja {
  id: string;
  fechaIso: string;
  efectivo: number;
  tarjeta: number;
  bizum: number;
  total: number;
  notas: string;
  registradoPorEmail: string;
  createdAtIso: string;
  enviadoAlServicioFiscal: boolean;
  idServicioFiscal: string;
  operationDetails: DbPaymentOperationDetail[];
}

export interface DbDailyPaymentSummary {
  dateIso: string;
  efectivo: number;
  tarjeta: number;
  bizum: number;
  total: number;
  updatedAtIso: string;
  operationDetails: DbPaymentOperationDetail[];
}

let usersAndCardsSchemaReady = false;

const ensureUsersAndCardsSchema = async (): Promise<void> => {
  if (!shouldUseDatabase() || usersAndCardsSchemaReady) {
    return;
  }

  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      username_lower TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'client',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tracking JSONB NOT NULL DEFAULT '{}',
      permissions JSONB NOT NULL DEFAULT '[]'
    );
  `);

  await db.query(`
    ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]';
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS client_cards (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      birth_date_iso TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_email TEXT NOT NULL,
      treatments JSONB NOT NULL DEFAULT '[]',
      password_hash TEXT
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS stock_products (
      id TEXT PRIMARY KEY,
      product_name TEXT NOT NULL,
      brand TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      color TEXT NOT NULL,
      is_sellable BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_email TEXT NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cierre_caja_entries (
      id TEXT PRIMARY KEY,
      fecha_iso TEXT NOT NULL,
      efectivo NUMERIC(12,2) NOT NULL DEFAULT 0,
      tarjeta NUMERIC(12,2) NOT NULL DEFAULT 0,
      bizum NUMERIC(12,2) NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      notas TEXT NOT NULL DEFAULT '',
      registrado_por_email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      enviado_al_servicio_fiscal BOOLEAN NOT NULL DEFAULT false,
      id_servicio_fiscal TEXT NOT NULL DEFAULT '',
      operation_details JSONB NOT NULL DEFAULT '[]'
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_payment_summaries (
      date_iso TEXT PRIMARY KEY,
      efectivo NUMERIC(12,2) NOT NULL DEFAULT 0,
      tarjeta NUMERIC(12,2) NOT NULL DEFAULT 0,
      bizum NUMERIC(12,2) NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      operation_details JSONB NOT NULL DEFAULT '[]'
    );
  `);

  await db.query(`
    ALTER TABLE cierre_caja_entries
    ADD COLUMN IF NOT EXISTS operation_details JSONB NOT NULL DEFAULT '[]';
  `);

  await db.query(`
    ALTER TABLE daily_payment_summaries
    ADD COLUMN IF NOT EXISTS operation_details JSONB NOT NULL DEFAULT '[]';
  `);

  await db.query(`
    ALTER TABLE client_cards
    ADD COLUMN IF NOT EXISTS password_hash TEXT;
  `);

  await db.query(`
    ALTER TABLE client_cards
    ADD COLUMN IF NOT EXISTS birth_date_iso TEXT;
  `);

  usersAndCardsSchemaReady = true;
};

export const loadAllUsersFromDb = async (): Promise<DbAppUser[]> => {
  if (!shouldUseDatabase()) {
    return [];
  }

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    const result = await db.query<{
      id: string;
      email: string;
      username: string;
      username_lower: string;
      password_hash: string;
      role: string;
      created_at: string;
      tracking: unknown;
      permissions: unknown;
    }>(`
      SELECT id, email, username, username_lower, password_hash, role, created_at, tracking, permissions
      FROM app_users
    `);

    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      username: row.username,
      usernameLower: row.username_lower,
      passwordHash: row.password_hash,
      role: row.role,
      createdAtIso: new Date(row.created_at).toISOString(),
      tracking: row.tracking ?? {},
      permissions: row.permissions ?? [],
    }));
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return [];
    }

    throw error;
  }
};

export const saveUserToDb = async (user: DbAppUser): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    await db.query(
      `
      INSERT INTO app_users (id, email, username, username_lower, password_hash, role, created_at, tracking, permissions)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (email) DO UPDATE SET
        username = EXCLUDED.username,
        username_lower = EXCLUDED.username_lower,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        tracking = EXCLUDED.tracking,
        permissions = EXCLUDED.permissions
      `,
      [
        user.id,
        user.email,
        user.username,
        user.usernameLower,
        user.passwordHash,
        user.role,
        user.createdAtIso,
        JSON.stringify(user.tracking ?? {}),
        JSON.stringify(user.permissions ?? []),
      ],
    );
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return;
    }

    throw error;
  }
};

export const deleteUserFromDb = async (email: string): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    await db.query('DELETE FROM app_users WHERE email = $1', [email]);
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return;
    }

    throw error;
  }
};

export const loadAllClientCardsFromDb = async (): Promise<DbClientCard[]> => {
  if (!shouldUseDatabase()) {
    return [];
  }

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    const result = await db.query<{
      id: string;
      full_name: string;
      email: string;
      phone: string;
      birth_date_iso: string | null;
      notes: string;
      created_at: string;
      created_by_email: string;
      treatments: unknown;
      password_hash: string | null;
    }>(`
      SELECT id, full_name, email, phone, birth_date_iso, notes, created_at, created_by_email, treatments, password_hash
      FROM client_cards
    `);

    return result.rows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      birthDateIso: row.birth_date_iso ?? undefined,
      notes: row.notes ?? '',
      createdAtIso: new Date(row.created_at).toISOString(),
      createdByEmail: row.created_by_email,
      treatments: row.treatments ?? [],
      passwordHash: row.password_hash ?? undefined,
    }));
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return [];
    }

    throw error;
  }
};

export const saveClientCardToDb = async (card: DbClientCard): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  let client: PoolClient | null = null;

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    client = await db.connect();

    await client.query('BEGIN');
    await client.query(
      `
      INSERT INTO client_cards (id, full_name, email, phone, birth_date_iso, notes, created_at, created_by_email, treatments, password_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        birth_date_iso = EXCLUDED.birth_date_iso,
        notes = EXCLUDED.notes,
        created_by_email = EXCLUDED.created_by_email,
        treatments = EXCLUDED.treatments,
        password_hash = EXCLUDED.password_hash
      `,
      [
        card.id,
        card.fullName,
        card.email,
        card.phone,
        card.birthDateIso ?? null,
        card.notes,
        card.createdAtIso,
        card.createdByEmail,
        JSON.stringify(card.treatments ?? []),
        card.passwordHash ?? null,
      ],
    );

    await client.query('COMMIT');
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }

    if (enableRuntimeMemoryMode(error)) {
      return;
    }

    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
};

export const deleteClientCardFromDb = async (clientId: string): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    await db.query('DELETE FROM client_cards WHERE id = $1', [clientId]);
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return;
    }

    throw error;
  }
};

export const loadAllStockProductsFromDb = async (): Promise<DbStockProduct[]> => {
  if (!shouldUseDatabase()) {
    return [];
  }

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    const result = await db.query<{
      id: string;
      product_name: string;
      brand: string;
      quantity: number;
      price: string;
      color: string;
      is_sellable: boolean;
      created_at: string;
      created_by_email: string;
    }>(`
      SELECT id, product_name, brand, quantity, price, color, is_sellable, created_at, created_by_email
      FROM stock_products
    `);

    return result.rows.map((row) => ({
      id: row.id,
      productName: row.product_name,
      brand: row.brand,
      quantity: Number(row.quantity) || 0,
      price: Number(row.price) || 0,
      color: row.color,
      isSellable: Boolean(row.is_sellable),
      createdAtIso: new Date(row.created_at).toISOString(),
      createdByEmail: row.created_by_email,
    }));
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return [];
    }

    throw error;
  }
};

export const saveStockProductToDb = async (product: DbStockProduct): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  let client: PoolClient | null = null;

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    client = await db.connect();

    await client.query('BEGIN');
    await client.query(
      `
      INSERT INTO stock_products (
        id,
        product_name,
        brand,
        quantity,
        price,
        color,
        is_sellable,
        created_at,
        created_by_email
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        product_name = EXCLUDED.product_name,
        brand = EXCLUDED.brand,
        quantity = EXCLUDED.quantity,
        price = EXCLUDED.price,
        color = EXCLUDED.color,
        is_sellable = EXCLUDED.is_sellable,
        created_by_email = EXCLUDED.created_by_email
      `,
      [
        product.id,
        product.productName,
        product.brand,
        product.quantity,
        product.price,
        product.color,
        product.isSellable,
        product.createdAtIso,
        product.createdByEmail,
      ],
    );

    await client.query('COMMIT');
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }

    if (enableRuntimeMemoryMode(error)) {
      return;
    }

    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
};

export const deleteStockProductFromDb = async (productId: string): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    await db.query('DELETE FROM stock_products WHERE id = $1', [productId]);
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return;
    }

    throw error;
  }
};

export const loadAllCierresFromDb = async (): Promise<DbCierreCaja[]> => {
  if (!shouldUseDatabase()) {
    return [];
  }

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    const result = await db.query<{
      id: string;
      fecha_iso: string;
      efectivo: string;
      tarjeta: string;
      bizum: string;
      total: string;
      notas: string;
      registrado_por_email: string;
      created_at: string;
      enviado_al_servicio_fiscal: boolean;
      id_servicio_fiscal: string;
      operation_details: unknown;
    }>(`
      SELECT id, fecha_iso, efectivo, tarjeta, bizum, total, notas, registrado_por_email, created_at, enviado_al_servicio_fiscal, id_servicio_fiscal, operation_details
      FROM cierre_caja_entries
    `);

    return result.rows.map((row) => ({
      id: row.id,
      fechaIso: row.fecha_iso,
      efectivo: Number(row.efectivo) || 0,
      tarjeta: Number(row.tarjeta) || 0,
      bizum: Number(row.bizum) || 0,
      total: Number(row.total) || 0,
      notas: row.notas ?? '',
      registradoPorEmail: row.registrado_por_email,
      createdAtIso: new Date(row.created_at).toISOString(),
      enviadoAlServicioFiscal: Boolean(row.enviado_al_servicio_fiscal),
      idServicioFiscal: row.id_servicio_fiscal ?? '',
      operationDetails: Array.isArray(row.operation_details)
        ? (row.operation_details as DbPaymentOperationDetail[])
        : [],
    }));
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return [];
    }

    throw error;
  }
};

export const saveCierreCajaToDb = async (cierre: DbCierreCaja): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  let client: PoolClient | null = null;

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    client = await db.connect();

    await client.query('BEGIN');
    await client.query(
      `
      INSERT INTO cierre_caja_entries (
        id,
        fecha_iso,
        efectivo,
        tarjeta,
        bizum,
        total,
        notas,
        registrado_por_email,
        created_at,
        enviado_al_servicio_fiscal,
        id_servicio_fiscal,
        operation_details
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET
        fecha_iso = EXCLUDED.fecha_iso,
        efectivo = EXCLUDED.efectivo,
        tarjeta = EXCLUDED.tarjeta,
        bizum = EXCLUDED.bizum,
        total = EXCLUDED.total,
        notas = EXCLUDED.notas,
        registrado_por_email = EXCLUDED.registrado_por_email,
        enviado_al_servicio_fiscal = EXCLUDED.enviado_al_servicio_fiscal,
        id_servicio_fiscal = EXCLUDED.id_servicio_fiscal,
        operation_details = EXCLUDED.operation_details
      `,
      [
        cierre.id,
        cierre.fechaIso,
        cierre.efectivo,
        cierre.tarjeta,
        cierre.bizum,
        cierre.total,
        cierre.notas,
        cierre.registradoPorEmail,
        cierre.createdAtIso,
        cierre.enviadoAlServicioFiscal,
        cierre.idServicioFiscal,
        JSON.stringify(cierre.operationDetails ?? []),
      ],
    );

    await client.query('COMMIT');
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }

    if (enableRuntimeMemoryMode(error)) {
      return;
    }

    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
};

export const deleteCierreCajaFromDb = async (cierreId: string): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    await db.query('DELETE FROM cierre_caja_entries WHERE id = $1', [cierreId]);
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return;
    }

    throw error;
  }
};

export const loadAllDailyPaymentsFromDb = async (): Promise<DbDailyPaymentSummary[]> => {
  if (!shouldUseDatabase()) {
    return [];
  }

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    const result = await db.query<{
      date_iso: string;
      efectivo: string;
      tarjeta: string;
      bizum: string;
      total: string;
      updated_at: string;
      operation_details: unknown;
    }>(`
      SELECT date_iso, efectivo, tarjeta, bizum, total, updated_at, operation_details
      FROM daily_payment_summaries
    `);

    return result.rows.map((row) => ({
      dateIso: row.date_iso,
      efectivo: Number(row.efectivo) || 0,
      tarjeta: Number(row.tarjeta) || 0,
      bizum: Number(row.bizum) || 0,
      total: Number(row.total) || 0,
      updatedAtIso: new Date(row.updated_at).toISOString(),
      operationDetails: Array.isArray(row.operation_details)
        ? (row.operation_details as DbPaymentOperationDetail[])
        : [],
    }));
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return [];
    }

    throw error;
  }
};

export const saveDailyPaymentToDb = async (summary: DbDailyPaymentSummary): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  let client: PoolClient | null = null;

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    client = await db.connect();

    await client.query('BEGIN');
    await client.query(
      `
      INSERT INTO daily_payment_summaries (
        date_iso,
        efectivo,
        tarjeta,
        bizum,
        total,
        updated_at,
        operation_details
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (date_iso) DO UPDATE SET
        efectivo = EXCLUDED.efectivo,
        tarjeta = EXCLUDED.tarjeta,
        bizum = EXCLUDED.bizum,
        total = EXCLUDED.total,
        updated_at = EXCLUDED.updated_at,
        operation_details = EXCLUDED.operation_details
      `,
      [
        summary.dateIso,
        summary.efectivo,
        summary.tarjeta,
        summary.bizum,
        summary.total,
        summary.updatedAtIso,
        JSON.stringify(summary.operationDetails ?? []),
      ],
    );

    await client.query('COMMIT');
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }

    if (enableRuntimeMemoryMode(error)) {
      return;
    }

    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
};

export const getDatabasePoolForIntegrations = (): Pool | null => {
  if (!shouldUseDatabase()) {
    return null;
  }

  return getPool();
};

// ==================== ALERTAS ====================

export interface ClientAlert {
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

interface MemoryAlert {
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

const memoryAlerts = new Map<string, MemoryAlert>();
const ALERTS_CACHE_FILE = path.join(process.cwd(), '.dev-client-alerts-cache.json');
let alertsSchemaReady = false;

const loadAlertsFromCache = (): void => {
  try {
    if (!fs.existsSync(ALERTS_CACHE_FILE)) {
      return;
    }

    const raw = fs.readFileSync(ALERTS_CACHE_FILE, 'utf8');
    const items: MemoryAlert[] = JSON.parse(raw);

    if (!Array.isArray(items)) {
      return;
    }

    memoryAlerts.clear();
    items.forEach((item) => {
      memoryAlerts.set(item.id, item);
    });
  } catch {
    // ignore cache errors in dev
  }
};

const saveAlertsToCache = (): void => {
  try {
    const items = Array.from(memoryAlerts.values());
    fs.writeFileSync(ALERTS_CACHE_FILE, JSON.stringify(items, null, 2), 'utf8');
  } catch {
    // ignore cache errors in dev
  }
};

const mapAlertRow = (row: {
  id: string;
  client_email: string;
  date_iso: string;
  start_time: string;
  end_time: string;
  appointment_type_name: string;
  status: string;
  approval_status?: string;
  created_at: string;
  approved_at?: string | null;
  approved_by_email?: string | null;
}): ClientAlert => ({
  id: row.id,
  clientEmail: row.client_email,
  dateIso: row.date_iso,
  startTime: row.start_time,
  endTime: row.end_time,
  appointmentTypeName: row.appointment_type_name,
  status: row.status as 'active' | 'completed' | 'cancelled',
  approvalStatus: (row.approval_status ?? 'pending') as 'pending' | 'approved' | 'rejected',
  createdAtIso: new Date(row.created_at).toISOString(),
  approvedAtIso: row.approved_at ? new Date(row.approved_at).toISOString() : null,
  approvedByEmail: row.approved_by_email ?? null,
});

const ensureAlertsSchema = async (): Promise<void> => {
  if (!shouldUseDatabase()) {
    return;
  }

  if (alertsSchemaReady) {
    return;
  }

  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS client_alerts (
      id TEXT PRIMARY KEY,
      client_email TEXT NOT NULL,
      date_iso TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      appointment_type_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      approval_status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(
    `ALTER TABLE client_alerts ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending'`,
  );
  await db.query(`ALTER TABLE client_alerts ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE client_alerts ADD COLUMN IF NOT EXISTS approved_by_email TEXT`);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_client_alerts_email ON client_alerts(client_email);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_client_alerts_date ON client_alerts(date_iso, start_time);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_client_alerts_approval_status ON client_alerts(approval_status);
  `);

  alertsSchemaReady = true;
};

export const createAlert = async (
  alert: Omit<ClientAlert, 'id' | 'createdAtIso'>,
): Promise<ClientAlert> => {
  const id = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const createdAtIso = new Date().toISOString();
  const fullAlert: ClientAlert = { ...alert, id, createdAtIso };

  if (!shouldUseDatabase()) {
    loadAlertsFromCache();
    memoryAlerts.set(id, fullAlert);
    saveAlertsToCache();
    return fullAlert;
  }

  try {
    await ensureAlertsSchema();
    const db = getPool();
    await db.query(
      `
      INSERT INTO client_alerts (
        id,
        client_email,
        date_iso,
        start_time,
        end_time,
        appointment_type_name,
        status,
        approval_status,
        created_at,
        approved_at,
        approved_by_email
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        fullAlert.id,
        fullAlert.clientEmail,
        fullAlert.dateIso,
        fullAlert.startTime,
        fullAlert.endTime,
        fullAlert.appointmentTypeName,
        fullAlert.status,
        fullAlert.approvalStatus,
        new Date(fullAlert.createdAtIso),
        fullAlert.approvedAtIso ? new Date(fullAlert.approvedAtIso) : null,
        fullAlert.approvedByEmail || null,
      ],
    );

    return fullAlert;
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      loadAlertsFromCache();
      memoryAlerts.set(id, fullAlert);
      saveAlertsToCache();
      return fullAlert;
    }

    throw error;
  }
};

export const getAllAlerts = async (): Promise<ClientAlert[]> => {
  if (!shouldUseDatabase()) {
    loadAlertsFromCache();
    return Array.from(memoryAlerts.values())
      .filter((alert) => alert.status === 'active')
      .sort((a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime());
  }

  try {
    await ensureAlertsSchema();
    const db = getPool();
    const result = await db.query<{
      id: string;
      client_email: string;
      date_iso: string;
      start_time: string;
      end_time: string;
      appointment_type_name: string;
      status: string;
      approval_status?: string;
      created_at: string;
      approved_at?: string | null;
      approved_by_email?: string | null;
    }>(
      `
      SELECT id, client_email, date_iso, start_time, end_time, appointment_type_name, status, approval_status, created_at, approved_at, approved_by_email
      FROM client_alerts
      WHERE status = 'active'
      ORDER BY created_at DESC
      `,
    );

    return result.rows.map(mapAlertRow);
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      loadAlertsFromCache();
      return Array.from(memoryAlerts.values())
        .filter((alert) => alert.status === 'active')
        .sort((a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime());
    }

    throw error;
  }
};

export const getAlertById = async (alertId: string): Promise<ClientAlert | null> => {
  if (!shouldUseDatabase()) {
    loadAlertsFromCache();
    return memoryAlerts.get(alertId) ?? null;
  }

  try {
    await ensureAlertsSchema();
    const db = getPool();
    const result = await db.query<{
      id: string;
      client_email: string;
      date_iso: string;
      start_time: string;
      end_time: string;
      appointment_type_name: string;
      status: string;
      approval_status?: string;
      created_at: string;
      approved_at?: string | null;
      approved_by_email?: string | null;
    }>(
      `
      SELECT id, client_email, date_iso, start_time, end_time, appointment_type_name, status, approval_status, created_at, approved_at, approved_by_email
      FROM client_alerts
      WHERE id = $1
      `,
      [alertId],
    );

    return result.rows[0] ? mapAlertRow(result.rows[0]) : null;
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      loadAlertsFromCache();
      return memoryAlerts.get(alertId) ?? null;
    }

    throw error;
  }
};

export const getAlertsByClientEmail = async (clientEmail: string): Promise<ClientAlert[]> => {
  if (!shouldUseDatabase()) {
    loadAlertsFromCache();
    return Array.from(memoryAlerts.values())
      .filter((a) => a.clientEmail === clientEmail && a.status === 'active')
      .sort((a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime());
  }

  try {
    await ensureAlertsSchema();
    const db = getPool();
    const result = await db.query<{
      id: string;
      client_email: string;
      date_iso: string;
      start_time: string;
      end_time: string;
      appointment_type_name: string;
      status: string;
      approval_status?: string;
      created_at: string;
      approved_at?: string | null;
      approved_by_email?: string | null;
    }>(
      `
      SELECT id, client_email, date_iso, start_time, end_time, appointment_type_name, status, approval_status, created_at, approved_at, approved_by_email
      FROM client_alerts
      WHERE client_email = $1 AND status = 'active'
      ORDER BY created_at DESC
      `,
      [clientEmail],
    );

    return result.rows.map(mapAlertRow);
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      loadAlertsFromCache();
      return Array.from(memoryAlerts.values())
        .filter((a) => a.clientEmail === clientEmail && a.status === 'active')
        .sort((a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime());
    }

    throw error;
  }
};

export const getAlertsForSlot = async (
  dateIso: string,
  startTime: string,
): Promise<ClientAlert[]> => {
  if (!shouldUseDatabase()) {
    loadAlertsFromCache();
    return Array.from(memoryAlerts.values()).filter(
      (a) => a.dateIso === dateIso && a.startTime === startTime && a.status === 'active',
    );
  }

  try {
    await ensureAlertsSchema();
    const db = getPool();
    const result = await db.query<{
      id: string;
      client_email: string;
      date_iso: string;
      start_time: string;
      end_time: string;
      appointment_type_name: string;
      status: string;
      approval_status?: string;
      created_at: string;
      approved_at?: string | null;
      approved_by_email?: string | null;
    }>(
      `
      SELECT id, client_email, date_iso, start_time, end_time, appointment_type_name, status, approval_status, created_at, approved_at, approved_by_email
      FROM client_alerts
      WHERE date_iso = $1 AND start_time = $2 AND status = 'active'
      `,
      [dateIso, startTime],
    );

    return result.rows.map(mapAlertRow);
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      loadAlertsFromCache();
      return Array.from(memoryAlerts.values()).filter(
        (a) => a.dateIso === dateIso && a.startTime === startTime && a.status === 'active',
      );
    }

    throw error;
  }
};

export const updateAlertStatus = async (
  alertId: string,
  newStatus: 'active' | 'completed' | 'cancelled',
): Promise<void> => {
  if (!shouldUseDatabase()) {
    loadAlertsFromCache();
    const alert = memoryAlerts.get(alertId);
    if (alert) {
      alert.status = newStatus;
      memoryAlerts.set(alertId, alert);
      saveAlertsToCache();
    }
    return;
  }

  try {
    await ensureAlertsSchema();
    const db = getPool();
    await db.query(`UPDATE client_alerts SET status = $1 WHERE id = $2`, [newStatus, alertId]);
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      loadAlertsFromCache();
      const alert = memoryAlerts.get(alertId);
      if (alert) {
        alert.status = newStatus;
        memoryAlerts.set(alertId, alert);
        saveAlertsToCache();
      }
      return;
    }

    throw error;
  }
};

export const updateAlertApprovalStatus = async (
  alertId: string,
  approvalStatus: 'pending' | 'approved' | 'rejected',
  approvedByEmail?: string,
): Promise<void> => {
  const approvedAtIso = approvalStatus === 'approved' ? new Date().toISOString() : null;

  if (!shouldUseDatabase()) {
    loadAlertsFromCache();
    const alert = memoryAlerts.get(alertId);

    if (alert) {
      alert.approvalStatus = approvalStatus;
      alert.approvedAtIso = approvedAtIso;
      alert.approvedByEmail = approvedByEmail || null;
      memoryAlerts.set(alertId, alert);
      saveAlertsToCache();
    }

    return;
  }

  try {
    await ensureAlertsSchema();
    const db = getPool();
    await db.query(
      `
      UPDATE client_alerts
      SET approval_status = $1, approved_at = $2, approved_by_email = $3
      WHERE id = $4
      `,
      [approvalStatus, approvedAtIso, approvedByEmail || null, alertId],
    );
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      loadAlertsFromCache();
      const alert = memoryAlerts.get(alertId);

      if (alert) {
        alert.approvalStatus = approvalStatus;
        alert.approvedAtIso = approvedAtIso;
        alert.approvedByEmail = approvedByEmail || null;
        memoryAlerts.set(alertId, alert);
        saveAlertsToCache();
      }

      return;
    }

    throw error;
  }
};

export const deleteAlert = async (alertId: string): Promise<void> => {
  if (!shouldUseDatabase()) {
    loadAlertsFromCache();
    memoryAlerts.delete(alertId);
    saveAlertsToCache();
    return;
  }

  try {
    await ensureAlertsSchema();
    const db = getPool();
    await db.query(`DELETE FROM client_alerts WHERE id = $1`, [alertId]);
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      loadAlertsFromCache();
      memoryAlerts.delete(alertId);
      saveAlertsToCache();
      return;
    }

    throw error;
  }
};
