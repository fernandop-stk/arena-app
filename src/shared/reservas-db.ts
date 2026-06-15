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
  requiresReservationSignal?: boolean;
}

export type AdminReservationStatus = 'pending' | 'accepted' | 'rejected';
export type ClientConfirmationStatus = 'pending' | 'confirmed';

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
  paymentReceived: boolean;
  adminStatus: AdminReservationStatus;
  clientConfirmationStatus: ClientConfirmationStatus;
  clientConfirmationReminderSentAtIso?: string | null;
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
  paymentReceived: boolean;
  adminStatus: AdminReservationStatus;
  clientConfirmationStatus: ClientConfirmationStatus;
  clientConfirmationReminderSentAtIso?: string | null;
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

  const dateSlots = memorySlotsByDate.get(reservation.dateIso);

  if (dateSlots) {
    reservation.slots.forEach((slot) => dateSlots.delete(slot));

    if (dateSlots.size === 0) {
      memorySlotsByDate.delete(reservation.dateIso);
    } else {
      memorySlotsByDate.set(reservation.dateIso, dateSlots);
    }
  }

  memoryReservations.delete(reservationId);
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

      memoryReservations.set(item.id, item);
      const dateSlots = memorySlotsByDate.get(item.dateIso) ?? new Set<string>();

      if (item.adminStatus !== 'rejected') {
        item.slots.forEach((slot) => dateSlots.add(slot));
      }

      memorySlotsByDate.set(item.dateIso, dateSlots);
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
  if (process.env['ALLOW_MEMORY_RESERVAS_FALLBACK'] === 'true') {
    return true;
  }

  return process.env['NODE_ENV'] !== 'production';
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

  if (!connectionString || isPlaceholderConnectionString(connectionString)) {
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
    pool = new Pool({
      connectionString,
      ssl: process.env['NODE_ENV'] === 'production' ? { rejectUnauthorized: false } : false,
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
      payment_received BOOLEAN NOT NULL DEFAULT FALSE,
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
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS reservation_slots (
      date_iso TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      PRIMARY KEY (date_iso, slot_time)
    );
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
  },
): { ok: true; reservationId: string } | { ok: false; conflict: true } => {
  purgeExpiredProvisionalReservationsInMemory();

  const reservationId = `${payload.dateIso}-${startMinutes}-${Date.now()}`;
  const slotTimes = buildSlotTimes(startMinutes, payload.durationMinutes);
  const dateSlots = getBookedSlotsFromMemory(payload.dateIso);
  const blockedSlots = options?.allowClosedSchedule
    ? getBlockedSlotsFromMemory(payload.dateIso)
    : getEffectiveBlockedSlotsFromMemory(payload.dateIso);
  const hasConflict = slotTimes.some((slot) => dateSlots.has(slot) || blockedSlots.has(slot));

  if (hasConflict) {
    return { ok: false, conflict: true };
  }

  const reservedSlots = memorySlotsByDate.get(payload.dateIso) ?? new Set<string>();
  slotTimes.forEach((slot) => reservedSlots.add(slot));
  memorySlotsByDate.set(payload.dateIso, reservedSlots);
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
    paymentReceived: false,
    adminStatus: 'pending',
    clientConfirmationStatus: 'pending',
    clientConfirmationReminderSentAtIso: null,
    createdAtIso,
    expiresAtIso: getReservationExpiresAtIso({
      appointmentTypeName: payload.appointmentTypeName,
      createdAtIso,
      requiresReservationSignal: payload.requiresReservationSignal,
    }),
    slots: slotTimes,
  });

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

  const dateSlots = memorySlotsByDate.get(reservation.dateIso);

  if (!dateSlots) {
    memoryReservations.delete(reservationId);
    return;
  }

  reservation.slots.forEach((slot) => dateSlots.delete(slot));

  if (dateSlots.size === 0) {
    memorySlotsByDate.delete(reservation.dateIso);
  } else {
    memorySlotsByDate.set(reservation.dateIso, dateSlots);
  }

  memoryReservations.delete(reservationId);
  saveMemoryToFile();
};

const releaseReservationSlotsInMemory = (reservationId: string): void => {
  const reservation = memoryReservations.get(reservationId);

  if (!reservation) {
    return;
  }

  const dateSlots = memorySlotsByDate.get(reservation.dateIso);

  if (!dateSlots) {
    return;
  }

  reservation.slots.forEach((slot) => dateSlots.delete(slot));

  if (dateSlots.size === 0) {
    memorySlotsByDate.delete(reservation.dateIso);
  } else {
    memorySlotsByDate.set(reservation.dateIso, dateSlots);
  }
};

const reserveReservationSlotsInMemory = (reservationId: string): boolean => {
  const reservation = memoryReservations.get(reservationId);

  if (!reservation) {
    return false;
  }

  const activeSlots = getBookedSlotsFromMemory(reservation.dateIso);

  if (reservation.slots.some((slot) => activeSlots.has(slot))) {
    return false;
  }

  const dateSlots = memorySlotsByDate.get(reservation.dateIso) ?? new Set<string>();
  reservation.slots.forEach((slot) => dateSlots.add(slot));
  memorySlotsByDate.set(reservation.dateIso, dateSlots);
  return true;
};

export const getAvailableSlotsForDate = async (
  dateIso: string,
  durationMinutes: number,
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

  let bookedSet: Set<string>;
  let blockedSet: Set<string>;

  if (shouldUseDatabase()) {
    try {
      await ensureSchema();
      const db = getPool();
      const booked = await db.query<{ slot_time: string }>(
        `
        SELECT rs.slot_time
        FROM reservation_slots rs
        INNER JOIN reservations r ON r.id = rs.reservation_id
        WHERE rs.date_iso = $1 AND r.admin_status <> 'rejected'
        `,
        [dateIso],
      );

      bookedSet = new Set(booked.rows.map((row) => row.slot_time));
      const blocked = await db.query<{ slot_time: string }>(
        'SELECT slot_time FROM admin_blocked_slots WHERE date_iso = $1',
        [dateIso],
      );

      blockedSet = new Set(blocked.rows.map((row) => row.slot_time));
    } catch (error) {
      if (!enableRuntimeMemoryMode(error)) {
        throw error;
      }

      bookedSet = getBookedSlotsFromMemory(dateIso);
      blockedSet = getEffectiveBlockedSlotsFromMemory(dateIso);
    }
  } else {
    bookedSet = getBookedSlotsFromMemory(dateIso);
    blockedSet = getEffectiveBlockedSlotsFromMemory(dateIso);
  }

  getRecurringClosedSlotsForDate(dateIso).forEach((slot) => blockedSet.add(slot));

  const { firstStartMinutes, lastStartMinutes } = serviceWindow;
  const availableSlots: string[] = [];

  for (let start = firstStartMinutes; start <= lastStartMinutes; start += STEP_MINUTES) {
    const neededSlots = buildSlotTimes(start, durationMinutes);
    const hasConflict = neededSlots.some((slot) => bookedSet.has(slot) || blockedSet.has(slot));

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

    const activeReservationConflict = await client.query<{ slot_time: string }>(
      `
      SELECT rs.slot_time
      FROM reservation_slots rs
      INNER JOIN reservations r ON r.id = rs.reservation_id
      WHERE rs.date_iso = $1
        AND rs.slot_time = ANY($2::text[])
        AND r.admin_status <> 'rejected'
      LIMIT 1
      `,
      [payload.dateIso, slotTimes],
    );

    if (activeReservationConflict.rowCount && activeReservationConflict.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, conflict: true };
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
        client_confirmation_status,
        expires_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
        'pending',
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
  paymentReceived: reservation.paymentReceived,
  adminStatus: reservation.adminStatus,
  clientConfirmationStatus: reservation.clientConfirmationStatus ?? 'pending',
  clientConfirmationReminderSentAtIso: reservation.clientConfirmationReminderSentAtIso ?? null,
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
      payment_received: boolean;
      admin_status: string;
      client_confirmation_status: string;
      client_confirmation_reminder_sent_at: string | null;
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
        payment_received,
        admin_status,
        client_confirmation_status,
        client_confirmation_reminder_sent_at,
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
      paymentReceived: row.payment_received,
      adminStatus: row.admin_status as AdminReservationStatus,
      clientConfirmationStatus: row.client_confirmation_status as ClientConfirmationStatus,
      clientConfirmationReminderSentAtIso: row.client_confirmation_reminder_sent_at,
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
): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> => {
  if (!shouldUseDatabase()) {
    const reservation = memoryReservations.get(reservationId);

    if (!reservation) {
      return { ok: false, reason: 'not-found' };
    }

    reservation.paymentReceived = paymentReceived;

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
          admin_status = CASE WHEN $2 = false THEN 'pending' ELSE admin_status END
      WHERE id = $1
      `,
      [reservationId, paymentReceived],
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
        reservation.adminStatus = 'pending';
      }

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
): Promise<
  { ok: true } | { ok: false; reason: 'not-found' | 'payment-required' | 'slot-conflict' }
> => {
  await cleanupExpiredProvisionalReservations();

  if (!shouldUseDatabase()) {
    const reservation = memoryReservations.get(reservationId);

    if (!reservation) {
      return { ok: false, reason: 'not-found' };
    }

    if (status === 'accepted' && !reservation.paymentReceived) {
      return { ok: false, reason: 'payment-required' };
    }

    if (status === 'accepted' && reservation.adminStatus === 'rejected') {
      const reserved = reserveReservationSlotsInMemory(reservationId);

      if (!reserved) {
        return { ok: false, reason: 'slot-conflict' };
      }
    }

    if (status === 'rejected') {
      releaseReservationSlotsInMemory(reservationId);
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
    }>(
      'SELECT payment_received, admin_status, date_iso, start_time, duration_minutes FROM reservations WHERE id = $1',
      [reservationId],
    );

    if (current.rowCount === 0) {
      return { ok: false, reason: 'not-found' };
    }

    if (status === 'accepted' && !current.rows[0]?.payment_received) {
      return { ok: false, reason: 'payment-required' };
    }

    const currentReservation = current.rows[0];

    if (status === 'accepted' && currentReservation?.admin_status === 'rejected') {
      const slotTimes = buildSlotTimes(
        toMinutes(currentReservation.start_time),
        currentReservation.duration_minutes,
      );

      const conflict = await db.query<{ slot_time: string }>(
        `
        SELECT rs.slot_time
        FROM reservation_slots rs
        INNER JOIN reservations r ON r.id = rs.reservation_id
        WHERE rs.date_iso = $1
          AND rs.slot_time = ANY($2::text[])
          AND rs.reservation_id <> $3
          AND r.admin_status <> 'rejected'
        LIMIT 1
        `,
        [currentReservation.date_iso, slotTimes, reservationId],
      );

      if (conflict.rowCount && conflict.rowCount > 0) {
        return { ok: false, reason: 'slot-conflict' };
      }

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

      if (status === 'accepted' && !reservation.paymentReceived) {
        return { ok: false, reason: 'payment-required' };
      }

      if (status === 'accepted' && reservation.adminStatus === 'rejected') {
        const reserved = reserveReservationSlotsInMemory(reservationId);

        if (!reserved) {
          return { ok: false, reason: 'slot-conflict' };
        }
      }

      if (status === 'rejected') {
        releaseReservationSlotsInMemory(reservationId);
      }

      reservation.adminStatus = status;
      memoryReservations.set(reservationId, reservation);
      saveMemoryToFile();
      return { ok: true };
    }

    throw error;
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
  },
  options?: {
    allowClosedSchedule?: boolean;
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

    const hasSlotConflict = Array.from(memoryReservations.values()).some((item) => {
      if (
        item.id === reservationId ||
        item.adminStatus === 'rejected' ||
        item.dateIso !== payload.dateIso
      ) {
        return false;
      }

      return item.slots.some((slot) => nextSlots.includes(slot));
    });

    if (reservation.adminStatus !== 'rejected' && hasSlotConflict) {
      return { ok: false, reason: 'slot-conflict' };
    }

    if (reservation.adminStatus !== 'rejected') {
      const previousDateSlots = memorySlotsByDate.get(reservation.dateIso);

      if (previousDateSlots) {
        reservation.slots.forEach((slot) => previousDateSlots.delete(slot));

        if (previousDateSlots.size === 0) {
          memorySlotsByDate.delete(reservation.dateIso);
        } else {
          memorySlotsByDate.set(reservation.dateIso, previousDateSlots);
        }
      }

      const nextDateSlots = memorySlotsByDate.get(payload.dateIso) ?? new Set<string>();
      nextSlots.forEach((slot) => nextDateSlots.add(slot));
      memorySlotsByDate.set(payload.dateIso, nextDateSlots);
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
      const slotConflict = await client.query<{ slot_time: string }>(
        `
        SELECT rs.slot_time
        FROM reservation_slots rs
        INNER JOIN reservations r ON r.id = rs.reservation_id
        WHERE rs.date_iso = $1
          AND rs.slot_time = ANY($2::text[])
          AND rs.reservation_id <> $3
          AND r.admin_status <> 'rejected'
        LIMIT 1
        `,
        [payload.dateIso, nextSlots, reservationId],
      );

      if (slotConflict.rowCount && slotConflict.rowCount > 0) {
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
          customer_email = $9
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

      const hasSlotConflict = Array.from(memoryReservations.values()).some((item) => {
        if (
          item.id === reservationId ||
          item.adminStatus === 'rejected' ||
          item.dateIso !== payload.dateIso
        ) {
          return false;
        }

        return item.slots.some((slot) => nextSlots.includes(slot));
      });

      if (reservation.adminStatus !== 'rejected' && hasSlotConflict) {
        return { ok: false, reason: 'slot-conflict' };
      }

      if (reservation.adminStatus !== 'rejected') {
        const previousDateSlots = memorySlotsByDate.get(reservation.dateIso);

        if (previousDateSlots) {
          reservation.slots.forEach((slot) => previousDateSlots.delete(slot));

          if (previousDateSlots.size === 0) {
            memorySlotsByDate.delete(reservation.dateIso);
          } else {
            memorySlotsByDate.set(reservation.dateIso, previousDateSlots);
          }
        }

        const nextDateSlots = memorySlotsByDate.get(payload.dateIso) ?? new Set<string>();
        nextSlots.forEach((slot) => nextDateSlots.add(slot));
        memorySlotsByDate.set(payload.dateIso, nextDateSlots);
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
      tracking JSONB NOT NULL DEFAULT '{}'
    );
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
    }>(`
      SELECT id, email, username, username_lower, password_hash, role, created_at, tracking
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
      INSERT INTO app_users (id, email, username, username_lower, password_hash, role, created_at, tracking)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (email) DO UPDATE SET
        username = EXCLUDED.username,
        username_lower = EXCLUDED.username_lower,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        tracking = EXCLUDED.tracking
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

  try {
    await ensureUsersAndCardsSchema();
    const db = getPool();
    await db.query(
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
  } catch (error) {
    if (enableRuntimeMemoryMode(error)) {
      return;
    }

    throw error;
  }
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
