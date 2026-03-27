import { Pool, PoolClient } from 'pg';

export interface ReservaPersistRequest {
  dateIso: string;
  time: string;
  durationMinutes: number;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  appointmentTypeName: string;
}

export type AdminReservationStatus = 'pending' | 'accepted' | 'rejected';

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
  createdAtIso: string;
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
  createdAtIso: string;
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
  new Set(memorySlotsByDate.get(dateIso) ?? new Set<string>());

const getBlockedSlotsFromMemory = (dateIso: string): Set<string> =>
  new Set(memoryBlockedSlotsByDate.get(dateIso) ?? new Set<string>());

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
): { ok: true; reservationId: string } | { ok: false; conflict: true } => {
  const reservationId = `${payload.dateIso}-${startMinutes}-${Date.now()}`;
  const slotTimes = buildSlotTimes(startMinutes, payload.durationMinutes);
  const dateSlots = memorySlotsByDate.get(payload.dateIso) ?? new Set<string>();
  const blockedSlots = memoryBlockedSlotsByDate.get(payload.dateIso) ?? new Set<string>();
  const hasConflict = slotTimes.some((slot) => dateSlots.has(slot) || blockedSlots.has(slot));

  if (hasConflict) {
    return { ok: false, conflict: true };
  }

  slotTimes.forEach((slot) => dateSlots.add(slot));
  memorySlotsByDate.set(payload.dateIso, dateSlots);
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
    createdAtIso: new Date().toISOString(),
    slots: slotTimes,
  });

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
};

export const getAvailableSlotsForDate = async (
  dateIso: string,
  durationMinutes: number,
): Promise<string[]> => {
  seedMockReservationsInMemory();

  if (durationMinutes <= 0) {
    return [];
  }

  let bookedSet: Set<string>;
  let blockedSet: Set<string>;

  if (shouldUseDatabase()) {
    try {
      await ensureSchema();
      const db = getPool();
      const booked = await db.query<{ slot_time: string }>(
        'SELECT slot_time FROM reservation_slots WHERE date_iso = $1',
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
      blockedSet = getBlockedSlotsFromMemory(dateIso);
    }
  } else {
    bookedSet = getBookedSlotsFromMemory(dateIso);
    blockedSet = getBlockedSlotsFromMemory(dateIso);
  }

  const lastStart = CLOSE_MINUTES - durationMinutes;
  const availableSlots: string[] = [];

  for (let start = OPEN_MINUTES; start <= lastStart; start += STEP_MINUTES) {
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
): Promise<{ ok: true; reservationId: string } | { ok: false; conflict: true }> => {
  seedMockReservationsInMemory();

  const startMinutes = toMinutes(payload.time);
  const endMinutes = startMinutes + payload.durationMinutes;

  if (
    Number.isNaN(startMinutes) ||
    startMinutes < OPEN_MINUTES ||
    endMinutes > CLOSE_MINUTES ||
    payload.durationMinutes <= 0
  ) {
    throw new Error('La hora seleccionada no es válida.');
  }

  if (!shouldUseDatabase()) {
    return createReservationWithSlotsInMemory(payload, startMinutes);
  }

  let client: PoolClient | null = null;
  const reservationId = `${payload.dateIso}-${startMinutes}-${Date.now()}`;
  const slotTimes = buildSlotTimes(startMinutes, payload.durationMinutes);

  try {
    await ensureSchema();

    const db = getPool();
    client = await db.connect();

    if (!client) {
      throw new Error('No se pudo obtener conexión de base de datos.');
    }

    await client.query('BEGIN');

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
        appointment_type_name
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
      return createReservationWithSlotsInMemory(payload, startMinutes);
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
  createdAtIso: reservation.createdAtIso,
});

export const listReservationsForAdmin = async (): Promise<AdminReservationItem[]> => {
  seedMockReservationsInMemory();

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
      return { ok: true };
    }

    throw error;
  }
};

export const updateReservationAdminStatus = async (
  reservationId: string,
  status: AdminReservationStatus,
): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'payment-required' }> => {
  if (!shouldUseDatabase()) {
    const reservation = memoryReservations.get(reservationId);

    if (!reservation) {
      return { ok: false, reason: 'not-found' };
    }

    if (!reservation.paymentReceived) {
      return { ok: false, reason: 'payment-required' };
    }

    reservation.adminStatus = status;
    memoryReservations.set(reservationId, reservation);
    return { ok: true };
  }

  try {
    await ensureSchema();
    const db = getPool();
    const current = await db.query<{ payment_received: boolean }>(
      'SELECT payment_received FROM reservations WHERE id = $1',
      [reservationId],
    );

    if (current.rowCount === 0) {
      return { ok: false, reason: 'not-found' };
    }

    if (!current.rows[0]?.payment_received) {
      return { ok: false, reason: 'payment-required' };
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

      if (!reservation.paymentReceived) {
        return { ok: false, reason: 'payment-required' };
      }

      reservation.adminStatus = status;
      memoryReservations.set(reservationId, reservation);
      return { ok: true };
    }

    throw error;
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

  if (
    Number.isNaN(startMinutes) ||
    Number.isNaN(endMinutes) ||
    startMinutes < OPEN_MINUTES ||
    endMinutes > CLOSE_MINUTES ||
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

  if (
    Number.isNaN(startMinutes) ||
    Number.isNaN(endMinutes) ||
    startMinutes < OPEN_MINUTES ||
    endMinutes > CLOSE_MINUTES ||
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
      SELECT slot_time
      FROM reservation_slots
      WHERE date_iso = $1 AND slot_time = ANY($2::text[])
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
