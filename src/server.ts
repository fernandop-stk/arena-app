import 'dotenv/config';
import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Resend } from 'resend';
import {
  AdminReservationStatus,
  ClientConfirmationStatus,
  createBlockedPeriodForAdmin,
  createReservationWithSlots,
  deleteBlockedPeriodForAdmin,
  deleteReservationById,
  deleteUserFromDb,
  getAvailableSlotsForDate,
  listBlockedPeriodsForAdmin,
  listReservationsForAdmin,
  getReservationByIdForAdmin,
  loadAllClientCardsFromDb,
  loadAllUsersFromDb,
  markReservationClientReminderSentAt,
  saveClientCardToDb,
  saveUserToDb,
  updateReservationAdminStatus,
  updateReservationClientConfirmationStatus,
  updateReservationPaymentReceived,
  createAlert,
  getAllAlerts,
  getAlertById,
  getAlertsByClientEmail,
  getAlertsForSlot,
  updateAlertStatus,
  updateAlertApprovalStatus,
  deleteAlert,
  updateReservationByAdmin,
} from './shared/reservas-db';
import {
  getPackPriceByName,
  getProvisionalReservationHoursByName,
  requiresReservationSignalByName,
} from './shared/pack-prices';
import {
  createNotification,
  getAllNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  clearReadNotifications,
  initializeNotificationsSchema,
  setNotificationsPool,
} from './shared/notifications-db';

const browserDistFolder = join(import.meta.dirname, '../browser');
const app = express();
const allowedHosts = [
  'localhost',
  '127.0.0.1',
  '::1',
  ...(process.env['NG_ALLOWED_HOSTS']
    ?.split(',')
    .map((host) => host.trim())
    .filter(Boolean) ?? []),
];
const angularApp = new AngularNodeAppEngine({ allowedHosts });
let adminOwnerEmail =
  process.env['ADMIN_OWNER_EMAIL']?.trim().toLowerCase() ?? 'ferperezsanchez@gmail.com';
const resendAllowedRecipient = process.env['RESEND_ALLOWED_TO']?.trim().toLowerCase() ?? '';
const adminMagicSecret = process.env['ADMIN_MAGIC_SECRET'] ?? process.env['RESEND_API_KEY'] ?? '';
const adminCookieName = 'arena_admin_session';
const authCookieName = 'arena_auth_session';
const clientCookieName = 'arena_client_session';
const authSessionSecret =
  process.env['AUTH_SESSION_SECRET']?.trim() || adminMagicSecret.trim() || 'arena-dev-auth-secret';
const reservationConfirmationSecret =
  process.env['RESERVATION_CONFIRMATION_SECRET']?.trim() || authSessionSecret;
const adminEmployeeEmails = new Set(
  (process.env['ADMIN_EMPLOYEE_EMAILS'] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const getPublicAppBaseUrl = (): string => {
  const configured = process.env['APP_BASE_URL']?.trim();

  if (configured) {
    return configured.replace(/\/$/, '');
  }

  const port = process.env['PORT']?.trim() || '4000';
  return `http://localhost:${port}`;
};

function resolveEmailRecipient(email: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    return normalizedEmail;
  }

  if (!resendAllowedRecipient) {
    return normalizedEmail;
  }

  if (normalizedEmail !== resendAllowedRecipient) {
    console.info(
      `[EMAIL TEST MODE] Reenviando correo desde ${normalizedEmail} a destinatario permitido ${resendAllowedRecipient}`,
    );
  }

  return resendAllowedRecipient;
}

const getAlertDurationMinutes = (alert: { startTime: string; endTime: string }): number => {
  const startMinutes =
    Number.parseInt(alert.startTime.slice(0, 2), 10) * 60 +
    Number.parseInt(alert.startTime.slice(3, 5), 10);
  const endMinutes =
    Number.parseInt(alert.endTime.slice(0, 2), 10) * 60 +
    Number.parseInt(alert.endTime.slice(3, 5), 10);

  return Math.max(endMinutes - startMinutes, 0);
};

async function sendAlertNotificationToClient(alert: {
  clientEmail: string;
  appointmentTypeName: string;
  dateIso: string;
  startTime: string;
}): Promise<boolean> {
  const apiKey = process.env['RESEND_API_KEY'];
  const fromEmail = process.env['RESEND_FROM_EMAIL'] ?? 'onboarding@resend.dev';

  if (!apiKey) {
    return false;
  }

  const resend = new Resend(apiKey);
  const emailTarget = resolveEmailRecipient(alert.clientEmail);
  const html = buildAlertFreedEmailHtml({
    customerName: 'Cliente',
    appointmentTypeName: alert.appointmentTypeName,
    dateIso: alert.dateIso,
    startTime: alert.startTime,
  });

  const sendResult = await resend.emails.send({
    from: fromEmail,
    to: emailTarget,
    subject: `Hueco disponible - ${alert.appointmentTypeName} (${alert.dateIso} ${alert.startTime})`,
    html,
  });

  return !sendResult.error;
}

async function notifyFreedSlotAlerts(reservation: {
  dateIso: string;
  startTime: string;
  endTime: string;
  appointmentTypeName: string;
}): Promise<void> {
  try {
    const startMinutes =
      Number.parseInt(reservation.startTime.slice(0, 2), 10) * 60 +
      Number.parseInt(reservation.startTime.slice(3, 5), 10);
    const endMinutes =
      Number.parseInt(reservation.endTime.slice(0, 2), 10) * 60 +
      Number.parseInt(reservation.endTime.slice(3, 5), 10);
    const alertsById = new Map<string, Awaited<ReturnType<typeof getAlertsForSlot>>[number]>();

    for (let current = startMinutes; current < endMinutes; current += 30) {
      const hour = Math.floor(current / 60)
        .toString()
        .padStart(2, '0');
      const minutes = (current % 60).toString().padStart(2, '0');
      const slotTime = `${hour}:${minutes}`;
      const slotAlerts = await getAlertsForSlot(reservation.dateIso, slotTime);

      for (const alert of slotAlerts) {
        alertsById.set(alert.id, alert);
      }
    }

    const alerts = Array.from(alertsById.values());
    const approvedAlerts = alerts.filter((alert) => alert.approvalStatus === 'approved');

    if (approvedAlerts.length === 0) {
      return;
    }

    for (const alert of approvedAlerts) {
      const sendOk = await sendAlertNotificationToClient(alert);

      if (sendOk) {
        await updateAlertStatus(alert.id, 'completed');
      }
    }
  } catch (alertError) {
    console.error('Error notificando alertas al liberar reserva:', alertError);
  }
}

async function notifyRejectedReservation(reservation: {
  customerEmail: string;
  customerName: string;
  appointmentTypeName: string;
  dateIso: string;
  startTime: string;
}): Promise<void> {
  try {
    const apiKey = process.env['RESEND_API_KEY'];
    const fromEmail = process.env['RESEND_FROM_EMAIL'] ?? 'onboarding@resend.dev';

    if (!apiKey) {
      return;
    }

    const resend = new Resend(apiKey);
    const html = buildReservationRejectedEmailHtml({
      customerName: reservation.customerName,
      appointmentTypeName: reservation.appointmentTypeName,
      dateIso: reservation.dateIso,
      startTime: reservation.startTime,
    });

    const sendResult = await resend.emails.send({
      from: fromEmail,
      to: resolveEmailRecipient(reservation.customerEmail),
      subject: `Reserva no confirmada - ${reservation.appointmentTypeName} (${reservation.dateIso} ${reservation.startTime})`,
      html,
    });

    if (sendResult.error) {
      throw new Error(sendResult.error.message || 'Resend rechazó el envío del email de rechazo.');
    }
  } catch (error) {
    console.error('Error enviando email de reserva rechazada:', error);
  }
}

type ReservationClientDecision = 'confirm' | 'reject';

interface ReservationConfirmationTokenPayload {
  reservationId: string;
  action: ReservationClientDecision;
  exp: number;
}

const buildReservationReminderEmailHtml = (data: {
  customerName: string;
  appointmentTypeName: string;
  dateIso: string;
  startTime: string;
  confirmUrl: string;
  rejectUrl: string;
}): string => {
  const safeName = escapeHtml(data.customerName || 'Cliente');
  const safeType = escapeHtml(data.appointmentTypeName);
  const safeDate = escapeHtml(data.dateIso);
  const safeStart = escapeHtml(data.startTime);
  const safeConfirmUrl = escapeHtml(data.confirmUrl);
  const safeRejectUrl = escapeHtml(data.rejectUrl);

  return `
    <div style="background:#fcf3ea;padding:24px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#3b2f2a;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;background:#fff9f4;border-radius:16px;overflow:hidden;border:1px solid #e8d8c9;">
        <tr>
          <td style="background:linear-gradient(135deg,#c97b63 0%,#d9a441 100%);padding:24px;">
            <p style="margin:0 0 6px;color:#fff6ee;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Arena Hair Studio</p>
            <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.25;">Confirma tu cita</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#5a4a42;">Hola ${safeName}, tu cita es en menos de 48 horas:</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#fff;border:1px solid #ecd9ca;border-radius:12px;overflow:hidden;">
              <tr><td style="padding:14px 16px;border-bottom:1px solid #f1e4d9;font-size:14px;"><strong>Servicio</strong><br><span style="color:#7a675d;">${safeType}</span></td></tr>
              <tr><td style="padding:14px 16px;border-bottom:1px solid #f1e4d9;font-size:14px;"><strong>Fecha</strong><br><span style="color:#7a675d;">${safeDate}</span></td></tr>
              <tr><td style="padding:14px 16px;font-size:14px;"><strong>Hora</strong><br><span style="color:#7a675d;">${safeStart}</span></td></tr>
            </table>

            <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;">
              <a href="${safeConfirmUrl}" style="display:inline-block;background:#3d8c54;color:#fff;text-decoration:none;padding:11px 18px;border-radius:999px;font-weight:700;font-size:14px;">Confirmar cita</a>
              <a href="${safeRejectUrl}" style="display:inline-block;background:#b74b4b;color:#fff;text-decoration:none;padding:11px 18px;border-radius:999px;font-weight:700;font-size:14px;">Rechazar cita</a>
            </div>

            <p style="margin:16px 0 0;font-size:12px;line-height:1.55;color:#8f7b6f;">Si rechazas la cita, se eliminará automáticamente de la agenda.</p>
          </td>
        </tr>
      </table>
    </div>
  `;
};

const createReservationConfirmationToken = (
  payload: ReservationConfirmationTokenPayload,
): string => {
  const payloadBase64 = toBase64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', reservationConfirmationSecret)
    .update(payloadBase64)
    .digest('base64url');
  return `${payloadBase64}.${signature}`;
};

const verifyReservationConfirmationToken = (
  token: string,
): ReservationConfirmationTokenPayload | null => {
  const [payloadPart, signaturePart] = token.split('.');

  if (!payloadPart || !signaturePart) {
    return null;
  }

  try {
    const expectedSignature = createHmac('sha256', reservationConfirmationSecret)
      .update(payloadPart)
      .digest('base64url');

    if (signaturePart !== expectedSignature) {
      return null;
    }

    const parsed = JSON.parse(fromBase64Url(payloadPart)) as {
      reservationId?: unknown;
      action?: unknown;
      exp?: unknown;
    };

    if (
      typeof parsed.reservationId !== 'string' ||
      (parsed.action !== 'confirm' && parsed.action !== 'reject') ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }

    if (parsed.exp <= Date.now()) {
      return null;
    }

    return {
      reservationId: parsed.reservationId,
      action: parsed.action,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
};

const buildReservationDecisionResultHtml = (
  title: string,
  message: string,
  tone: 'success' | 'danger' | 'neutral' = 'neutral',
): string => {
  const badgeColor = tone === 'success' ? '#3d8c54' : tone === 'danger' ? '#b74b4b' : '#6b594f';

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title)}</title>
      </head>
      <body style="margin:0;background:#fcf3ea;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#3b2f2a;">
        <div style="max-width:640px;margin:0 auto;padding:28px 18px;">
          <div style="background:#fff9f4;border:1px solid #e8d8c9;border-radius:16px;padding:24px;">
            <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${badgeColor};">Arena Hair Studio</p>
            <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
            <p style="margin:0;font-size:15px;line-height:1.6;color:#5a4a42;">${escapeHtml(message)}</p>
          </div>
        </div>
      </body>
    </html>
  `;
};

const getReservationStartMs = (dateIso: string, startTime: string): number | null => {
  const value = new Date(`${dateIso}T${startTime}:00`).getTime();
  return Number.isNaN(value) ? null : value;
};

const shouldSend48hReminder = (reservation: {
  dateIso: string;
  startTime: string;
  adminStatus: AdminReservationStatus;
  clientConfirmationStatus: ClientConfirmationStatus;
  clientConfirmationReminderSentAtIso?: string | null;
}): boolean => {
  if (reservation.adminStatus === 'rejected') {
    return false;
  }

  if (reservation.clientConfirmationStatus === 'confirmed') {
    return false;
  }

  if (reservation.clientConfirmationReminderSentAtIso) {
    return false;
  }

  const appointmentMs = getReservationStartMs(reservation.dateIso, reservation.startTime);

  if (appointmentMs === null) {
    return false;
  }

  const timeUntilMs = appointmentMs - Date.now();

  if (timeUntilMs <= 0) {
    return false;
  }

  return timeUntilMs <= 48 * 60 * 60 * 1000;
};

const send48hReservationReminder = async (reservation: {
  id: string;
  customerEmail: string;
  customerName: string;
  appointmentTypeName: string;
  dateIso: string;
  startTime: string;
}): Promise<boolean> => {
  const apiKey = process.env['RESEND_API_KEY'];
  const fromEmail = process.env['RESEND_FROM_EMAIL'] ?? 'onboarding@resend.dev';

  if (!apiKey) {
    return false;
  }

  const expiresAt = Date.now() + 72 * 60 * 60 * 1000;
  const confirmToken = createReservationConfirmationToken({
    reservationId: reservation.id,
    action: 'confirm',
    exp: expiresAt,
  });
  const rejectToken = createReservationConfirmationToken({
    reservationId: reservation.id,
    action: 'reject',
    exp: expiresAt,
  });
  const baseUrl = getPublicAppBaseUrl();
  const confirmUrl = `${baseUrl}/api/reservas/confirmacion?token=${encodeURIComponent(confirmToken)}`;
  const rejectUrl = `${baseUrl}/api/reservas/confirmacion?token=${encodeURIComponent(rejectToken)}`;

  const resend = new Resend(apiKey);
  const html = buildReservationReminderEmailHtml({
    customerName: reservation.customerName,
    appointmentTypeName: reservation.appointmentTypeName,
    dateIso: reservation.dateIso,
    startTime: reservation.startTime,
    confirmUrl,
    rejectUrl,
  });

  const sendResult = await resend.emails.send({
    from: fromEmail,
    to: resolveEmailRecipient(reservation.customerEmail),
    subject: `Confirma tu cita - ${reservation.appointmentTypeName} (${reservation.dateIso} ${reservation.startTime})`,
    html,
  });

  return !sendResult.error;
};

const dispatch48hReservationReminders = async (
  reservations: Array<{
    id: string;
    customerEmail: string;
    customerName: string;
    appointmentTypeName: string;
    dateIso: string;
    startTime: string;
    adminStatus: AdminReservationStatus;
    clientConfirmationStatus: ClientConfirmationStatus;
    clientConfirmationReminderSentAtIso?: string | null;
  }>,
): Promise<void> => {
  const candidates = reservations.filter((reservation) => shouldSend48hReminder(reservation));

  for (const reservation of candidates) {
    try {
      const sent = await send48hReservationReminder(reservation);

      if (sent) {
        await markReservationClientReminderSentAt(reservation.id, new Date().toISOString());
      }
    } catch (error) {
      console.error('Error enviando recordatorio de confirmación 48h:', error);
    }
  }
};

type AppUserRole = 'superadmin' | 'admin' | 'client';
type EmployeeWorkStatus = 'idle' | 'working' | 'vacation' | 'sick_leave' | 'recovering_hours';
type EmployeeTrackingAction =
  | 'check_in'
  | 'check_out'
  | 'vacation'
  | 'sick_leave'
  | 'recovering_hours'
  | 'clear_status';

interface EmployeeTrackingHistoryItem {
  action: EmployeeTrackingAction;
  createdAtIso: string;
  note: string;
}

interface EmployeeTrackingInfo {
  workStatus: EmployeeWorkStatus;
  lastCheckInIso: string;
  lastCheckOutIso: string;
  vacationNote: string;
  sickLeaveNote: string;
  recoveryHoursNote: string;
  history: EmployeeTrackingHistoryItem[];
}

type EmployeePermission =
  | 'agenda_ver'
  | 'agenda_gestionar'
  | 'bloqueos_gestionar'
  | 'reservas_ver'
  | 'reservas_gestionar'
  | 'cierre_registrar'
  | 'estadisticas_ver'
  | 'clientes_gestionar'
  | 'almacen_gestionar'
  | 'cobros_gestionar';

const ALL_EMPLOYEE_PERMISSIONS: EmployeePermission[] = [
  'agenda_ver',
  'agenda_gestionar',
  'bloqueos_gestionar',
  'reservas_ver',
  'reservas_gestionar',
  'cierre_registrar',
  'estadisticas_ver',
  'clientes_gestionar',
  'almacen_gestionar',
  'cobros_gestionar',
];

interface AppUser {
  id: string;
  email: string;
  username: string;
  usernameLower: string;
  passwordHash: string;
  role: AppUserRole;
  createdAtIso: string;
  tracking: EmployeeTrackingInfo;
  permissions?: EmployeePermission[];
}

interface AppSession {
  isAuthenticated: boolean;
  isAdmin: boolean;
  email: string;
  username: string;
  role: AppUserRole | '';
}

interface AdminEmployeeItem {
  email: string;
  username: string;
  role: AppUserRole;
  createdAtIso: string;
  tracking: EmployeeTrackingInfo;
  permissions: EmployeePermission[];
}

interface ClientTreatmentItem {
  id: string;
  name: string;
  note: string;
  createdAtIso: string;
  createdByEmail: string;
  priceEuro?: number;
  paymentMethod?: 'efectivo' | 'tarjeta' | 'bizum' | null;
}

interface DailyPaymentSummaryItem {
  dateIso: string;
  efectivo: number;
  tarjeta: number;
  bizum: number;
  total: number;
  updatedAtIso: string;
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
  treatments: ClientTreatmentItem[];
  passwordHash?: string;
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
  // preparado para integración con servicio fiscal externo (ej. Verifactu / API del SII)
  enviadoAlServicioFiscal: boolean;
  idServicioFiscal: string;
}

const usersByEmail = new Map<string, AppUser>();
const usersByUsername = new Map<string, AppUser>();
const clientCardsById = new Map<string, ClientCardItem>();
const stockProductsById = new Map<string, StockProductItem>();
const cierreCajaById = new Map<string, CierreCajaItem>();
const dailyPaymentsByDateIso = new Map<string, DailyPaymentSummaryItem>();
const clientRecoveryTokens = new Map<string, { email: string; expiresAt: number }>();
let authSeeded = false;
const maxEmployeeTrackingHistoryItems = 180;
const runtimeDataDir = join(process.cwd(), '.runtime-data');
const usersBackupFilePath = join(runtimeDataDir, 'users.json');
const clientCardsBackupFilePath = join(runtimeDataDir, 'client-cards.json');
const stockProductsBackupFilePath = join(runtimeDataDir, 'stock-products.json');
const cierreCajaBackupFilePath = join(runtimeDataDir, 'cierre-caja.json');
const dailyPaymentsBackupFilePath = join(runtimeDataDir, 'daily-payments.json');

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const buildReservationEmailHtml = (data: {
  customerName: string;
  customerPhone: string;
  appointmentTypeName: string;
  provisionalHoldHours?: number;
  dateIso: string;
  time: string;
  establishmentAddress: string;
  establishmentPhone: string;
  observaciones?: string;
}): string => {
  const customerName = escapeHtml(data.customerName);
  const customerPhone = escapeHtml(data.customerPhone);
  const appointmentTypeName = escapeHtml(data.appointmentTypeName);
  const dateIso = escapeHtml(data.dateIso);
  const time = escapeHtml(data.time);
  const establishmentAddress = escapeHtml(data.establishmentAddress);
  const establishmentPhone = escapeHtml(data.establishmentPhone);
  const provisionalHoldHours = data.provisionalHoldHours ?? 0;
  const provisionalNotice =
    provisionalHoldHours > 0
      ? `<tr><td style="padding:14px 16px;font-size:14px;"><strong>Señal y reserva provisional</strong><br><span style="color:#7a675d;">Este servicio requiere señal. La franja queda marcada como ocupada de forma provisional durante ${provisionalHoldHours} horas si no se confirma.</span></td></tr>`
      : '';
  const observaciones = data.observaciones ? escapeHtml(data.observaciones) : '';
  const observacionesRow = observaciones
    ? `<tr><td style="padding:14px 16px;font-size:14px;"><strong>Observaciones</strong><br><span style="color:#7a675d;">${observaciones}</span></td></tr>`
    : '';

  return `
    <div style="background:#fcf3ea;padding:24px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#3b2f2a;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;background:#fff9f4;border-radius:16px;overflow:hidden;border:1px solid #e8d8c9;">
        <tr>
          <td style="background:linear-gradient(135deg,#c97b63 0%,#d9a441 100%);padding:24px;">
            <p style="margin:0 0 6px;color:#fff6ee;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Arena Studio</p>
            <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.25;">Confirmación de tu cita</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 14px;font-size:16px;line-height:1.45;">Hola <strong>${customerName}</strong>,</p>
            <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#7a675d;">Tu reserva se ha registrado correctamente. Aquí tienes todos los detalles:</p>

            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e8d8c9;border-radius:12px;overflow:hidden;background:#fff4eb;margin-bottom:16px;">
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Servicio</strong><br><span style="color:#7a675d;">${appointmentTypeName}</span></td>
              </tr>
              ${provisionalNotice}
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Fecha</strong><br><span style="color:#7a675d;">${dateIso}</span></td>
              </tr>
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Hora</strong><br><span style="color:#7a675d;">${time}</span></td>
              </tr>
              <tr>
                <td style="padding:14px 16px;font-size:14px;"><strong>Teléfono de contacto</strong><br><span style="color:#7a675d;">${customerPhone}</span></td>
              </tr>
              ${observacionesRow}
            </table>

            <h2 style="margin:0 0 10px;font-size:16px;color:#3b2f2a;">Datos del establecimiento</h2>
            <p style="margin:0 0 4px;font-size:14px;line-height:1.5;color:#7a675d;"><strong>Dirección:</strong> ${establishmentAddress}</p>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#7a675d;"><strong>Teléfono:</strong> ${establishmentPhone}</p>

            <p style="margin:0;font-size:14px;line-height:1.6;color:#7a675d;">Gracias por confiar en Arena Studio. ¡Te esperamos!</p>
          </td>
        </tr>
      </table>
    </div>
  `;
};

const buildAlertCoveredEmailHtml = (data: {
  customerName: string;
  appointmentTypeName: string;
  dateIso: string;
  startTime: string;
}): string => {
  const customerName = escapeHtml(data.customerName);
  const appointmentTypeName = escapeHtml(data.appointmentTypeName);
  const dateIso = escapeHtml(data.dateIso);
  const startTime = escapeHtml(data.startTime);

  return `
    <div style="background:#fcf3ea;padding:24px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#3b2f2a;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;background:#fff9f4;border-radius:16px;overflow:hidden;border:1px solid #e8d8c9;">
        <tr>
          <td style="background:linear-gradient(135deg,#c97b63 0%,#d9a441 100%);padding:24px;">
            <p style="margin:0 0 6px;color:#fff6ee;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Arena Studio</p>
            <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.25;">Hueco completado</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 14px;font-size:16px;line-height:1.45;">Hola <strong>${customerName}</strong>,</p>
            <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#7a675d;">Lo sentimos, el hueco que solicitaste en la alerta ha sido completado por otro cliente:</p>

            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e8d8c9;border-radius:12px;overflow:hidden;background:#fff4eb;margin-bottom:16px;">
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Servicio</strong><br><span style="color:#7a675d;">${appointmentTypeName}</span></td>
              </tr>
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Fecha</strong><br><span style="color:#7a675d;">${dateIso}</span></td>
              </tr>
              <tr>
                <td style="padding:14px 16px;font-size:14px;"><strong>Hora</strong><br><span style="color:#7a675d;">${startTime}</span></td>
              </tr>
            </table>

            <p style="margin:0;font-size:14px;line-height:1.6;color:#7a675d;">Te recomendamos crear una nueva alerta para otro hueco disponible si lo deseas.</p>
          </td>
        </tr>
      </table>
    </div>
  `;
};

const buildAlertFreedEmailHtml = (data: {
  customerName: string;
  appointmentTypeName: string;
  dateIso: string;
  startTime: string;
}): string => {
  const customerName = escapeHtml(data.customerName);
  const appointmentTypeName = escapeHtml(data.appointmentTypeName);
  const dateIso = escapeHtml(data.dateIso);
  const startTime = escapeHtml(data.startTime);

  return `
    <div style="background:#fcf3ea;padding:24px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#3b2f2a;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;background:#fff9f4;border-radius:16px;overflow:hidden;border:1px solid #e8d8c9;">
        <tr>
          <td style="background:linear-gradient(135deg,#7e9f7d 0%,#90c8b1 100%);padding:24px;">
            <p style="margin:0 0 6px;color:#fff6ee;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Arena Studio</p>
            <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.25;">¡Hueco disponible!</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 14px;font-size:16px;line-height:1.45;">Hola <strong>${customerName}</strong>,</p>
            <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#7a675d;">Se ha liberado el hueco que tenías en alerta:</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e8d8c9;border-radius:12px;overflow:hidden;background:#fff4eb;margin-bottom:16px;">
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Servicio</strong><br><span style="color:#7a675d;">${appointmentTypeName}</span></td>
              </tr>
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Fecha</strong><br><span style="color:#7a675d;">${dateIso}</span></td>
              </tr>
              <tr>
                <td style="padding:14px 16px;font-size:14px;"><strong>Hora</strong><br><span style="color:#7a675d;">${startTime}</span></td>
              </tr>
            </table>
            <p style="margin:0;font-size:14px;line-height:1.6;color:#7a675d;">Reserva cuanto antes para asegurarlo.</p>
          </td>
        </tr>
      </table>
    </div>
  `;
};

const buildReservationRejectedEmailHtml = (data: {
  customerName: string;
  appointmentTypeName: string;
  dateIso: string;
  startTime: string;
}): string => {
  const customerName = escapeHtml(data.customerName);
  const appointmentTypeName = escapeHtml(data.appointmentTypeName);
  const dateIso = escapeHtml(data.dateIso);
  const startTime = escapeHtml(data.startTime);

  return `
    <div style="background:#fcf3ea;padding:24px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#3b2f2a;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;background:#fff9f4;border-radius:16px;overflow:hidden;border:1px solid #e8d8c9;">
        <tr>
          <td style="background:linear-gradient(135deg,#b86a6a 0%,#d98b73 100%);padding:24px;">
            <p style="margin:0 0 6px;color:#fff6ee;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Arena Studio</p>
            <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.25;">Tu reserva no ha podido ser confirmada</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 14px;font-size:16px;line-height:1.45;">Hola <strong>${customerName}</strong>,</p>
            <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#7a675d;">No hemos podido confirmar tu reserva para el siguiente hueco:</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e8d8c9;border-radius:12px;overflow:hidden;background:#fff4eb;margin-bottom:16px;">
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Servicio</strong><br><span style="color:#7a675d;">${appointmentTypeName}</span></td>
              </tr>
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Fecha</strong><br><span style="color:#7a675d;">${dateIso}</span></td>
              </tr>
              <tr>
                <td style="padding:14px 16px;font-size:14px;"><strong>Hora</strong><br><span style="color:#7a675d;">${startTime}</span></td>
              </tr>
            </table>
            <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#7a675d;">Si este horario sigue libre, puedes volver a reservarlo desde la web.</p>
            <p style="margin:0;font-size:14px;line-height:1.6;color:#7a675d;">Ponte en contacto con nosotros si quieres saber más información.</p>
          </td>
        </tr>
      </table>
    </div>
  `;
};

const toBase64Url = (value: string): string => Buffer.from(value).toString('base64url');

const fromBase64Url = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

const signAdminMagicTokenValue = (value: string): string =>
  createHmac('sha256', adminMagicSecret).update(value).digest('base64url');

const signAuthTokenValue = (value: string): string =>
  createHmac('sha256', authSessionSecret).update(value).digest('base64url');

const createAdminMagicToken = (email: string, expiresAtMs: number): string => {
  const payload = toBase64Url(JSON.stringify({ email, exp: expiresAtMs }));
  const signature = signAdminMagicTokenValue(payload);

  return `${payload}.${signature}`;
};

const verifyAdminMagicToken = (token: string): { email: string; exp: number } | null => {
  const [payloadPart, signaturePart] = token.split('.');

  if (!payloadPart || !signaturePart || !adminMagicSecret) {
    return null;
  }

  const expectedSignature = signAdminMagicTokenValue(payloadPart);

  if (expectedSignature.length !== signaturePart.length) {
    return null;
  }

  const isValidSignature = timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(signaturePart),
  );

  if (!isValidSignature) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(payloadPart)) as { email?: unknown; exp?: unknown };

    if (typeof parsed.email !== 'string' || typeof parsed.exp !== 'number') {
      return null;
    }

    if (parsed.exp <= Date.now()) {
      return null;
    }

    return {
      email: parsed.email.toLowerCase(),
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
};

const getCookieValue = (cookieHeader: string | undefined, name: string): string | null => {
  if (!cookieHeader) {
    return null;
  }

  const cookie = cookieHeader
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));

  if (!cookie) {
    return null;
  }

  return decodeURIComponent(cookie.slice(name.length + 1));
};

const hashPassword = (password: string): string => {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
};

const verifyPassword = (password: string, encoded: string): boolean => {
  const [salt, digest] = encoded.split(':');

  if (!salt || !digest) {
    return false;
  }

  const computed = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');

  if (computed.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(computed, expected);
};

const buildUserId = (): string => `user-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const buildClientCardId = (): string =>
  `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const buildClientTreatmentId = (): string =>
  `treat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const buildStockProductId = (): string =>
  `stock-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const normalizeBirthDateIso = (value: unknown): string => {
  const raw = `${value ?? ''}`.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return '';
  }

  const parsed = new Date(`${raw}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  if (parsed.toISOString().slice(0, 10) !== raw) {
    return '';
  }

  if (parsed.getTime() > Date.now()) {
    return '';
  }

  return raw;
};

const normalizeClientCard = (card: ClientCardItem): ClientCardItem => ({
  ...card,
  birthDateIso: normalizeBirthDateIso(card.birthDateIso),
  treatments: (card.treatments ?? [])
    .slice()
    .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso)),
});

const normalizeStockProduct = (product: StockProductItem): StockProductItem => {
  const normalizedQuantity = Number.isFinite(product.quantity)
    ? Math.max(0, Math.floor(product.quantity))
    : 0;
  const normalizedPrice = Number.isFinite(product.price) ? Math.max(0, product.price) : 0;

  return {
    ...product,
    productName: `${product.productName ?? ''}`.trim().slice(0, 120),
    brand: `${product.brand ?? ''}`.trim().slice(0, 80),
    color: `${product.color ?? ''}`.trim().slice(0, 40),
    quantity: normalizedQuantity,
    price: Number(normalizedPrice.toFixed(2)),
    isSellable: Boolean(product.isSellable),
  };
};

const createDefaultTrackingInfo = (): EmployeeTrackingInfo => ({
  workStatus: 'idle',
  lastCheckInIso: '',
  lastCheckOutIso: '',
  vacationNote: '',
  sickLeaveNote: '',
  recoveryHoursNote: '',
  history: [],
});

const normalizeTrackingInfo = (
  tracking: EmployeeTrackingInfo | undefined,
): EmployeeTrackingInfo => ({
  ...createDefaultTrackingInfo(),
  ...tracking,
  history: tracking?.history ?? [],
});

const ensureRuntimeDataDir = async (): Promise<void> => {
  await mkdir(runtimeDataDir, { recursive: true });
};

const persistUsersToDisk = async (): Promise<void> => {
  try {
    await ensureRuntimeDataDir();
    const users = Array.from(usersByEmail.values());
    await writeFile(usersBackupFilePath, JSON.stringify(users, null, 2), 'utf8');
  } catch (error) {
    console.error('Error guardando backup local de usuarios:', error);
  }
};

const persistClientCardsToDisk = async (): Promise<void> => {
  try {
    await ensureRuntimeDataDir();
    const cards = Array.from(clientCardsById.values()).map((card) => normalizeClientCard(card));
    await writeFile(clientCardsBackupFilePath, JSON.stringify(cards, null, 2), 'utf8');
  } catch (error) {
    console.error('Error guardando backup local de fichas:', error);
  }
};

const persistStockProductsToDisk = async (): Promise<void> => {
  try {
    await ensureRuntimeDataDir();
    const products = Array.from(stockProductsById.values())
      .map((product) => normalizeStockProduct(product))
      .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
    await writeFile(stockProductsBackupFilePath, JSON.stringify(products, null, 2), 'utf8');
  } catch (error) {
    console.error('Error guardando backup local de almacén:', error);
  }
};

const loadUsersFromDisk = async (): Promise<AppUser[]> => {
  try {
    const raw = await readFile(usersBackupFilePath, 'utf8');
    const parsed = JSON.parse(raw) as AppUser[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((user) => ({
      ...user,
      email: `${user.email ?? ''}`.toLowerCase(),
      usernameLower: `${user.usernameLower ?? user.username ?? ''}`.toLowerCase(),
      tracking: normalizeTrackingInfo(user.tracking),
    }));
  } catch {
    return [];
  }
};

const loadClientCardsFromDisk = async (): Promise<ClientCardItem[]> => {
  try {
    const raw = await readFile(clientCardsBackupFilePath, 'utf8');
    const parsed = JSON.parse(raw) as ClientCardItem[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((card) => Boolean(card?.id))
      .map((card) =>
        normalizeClientCard({
          ...card,
          email: `${card.email ?? ''}`.toLowerCase(),
          notes: `${card.notes ?? ''}`,
          treatments: Array.isArray(card.treatments) ? card.treatments : [],
        }),
      );
  } catch {
    return [];
  }
};

const loadStockProductsFromDisk = async (): Promise<StockProductItem[]> => {
  try {
    const raw = await readFile(stockProductsBackupFilePath, 'utf8');
    const parsed = JSON.parse(raw) as StockProductItem[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((product) => Boolean(product?.id))
      .map((product) =>
        normalizeStockProduct({
          ...product,
          createdByEmail: `${product.createdByEmail ?? ''}`.toLowerCase(),
        }),
      );
  } catch {
    return [];
  }
};

// ── Cierre de caja helpers ────────────────────────────────────────────────────

const buildCierreId = (): string =>
  `cierre_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const normalizeCierre = (cierre: CierreCajaItem): CierreCajaItem => ({
  id: `${cierre.id ?? ''}`,
  fechaIso: `${cierre.fechaIso ?? ''}`,
  efectivo: Number(cierre.efectivo) || 0,
  tarjeta: Number(cierre.tarjeta) || 0,
  bizum: Number(cierre.bizum) || 0,
  total: Number(cierre.total) || 0,
  notas: `${cierre.notas ?? ''}`,
  registradoPorEmail: `${cierre.registradoPorEmail ?? ''}`,
  createdAtIso: `${cierre.createdAtIso ?? new Date().toISOString()}`,
  enviadoAlServicioFiscal: Boolean(cierre.enviadoAlServicioFiscal),
  idServicioFiscal: `${cierre.idServicioFiscal ?? ''}`,
});

const parseCierreAmount = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') {
    return 0;
  }

  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return null;
  }

  return amount;
};

const persistCierreCajaToDisk = async (): Promise<void> => {
  try {
    const data = Array.from(cierreCajaById.values());
    await writeFile(cierreCajaBackupFilePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[cierre-caja] Error persisting to disk:', err);
  }
};

const loadCierreCajaFromDisk = async (): Promise<CierreCajaItem[]> => {
  try {
    const raw = await readFile(cierreCajaBackupFilePath, 'utf8');
    const parsed = JSON.parse(raw) as CierreCajaItem[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((c) => Boolean(c?.id)).map(normalizeCierre);
  } catch {
    return [];
  }
};

const normalizeDailyPaymentSummary = (item: DailyPaymentSummaryItem): DailyPaymentSummaryItem => {
  const efectivo = Number(item.efectivo) || 0;
  const tarjeta = Number(item.tarjeta) || 0;
  const bizum = Number(item.bizum) || 0;
  return {
    dateIso: `${item.dateIso ?? ''}`,
    efectivo,
    tarjeta,
    bizum,
    total: Number((efectivo + tarjeta + bizum).toFixed(2)),
    updatedAtIso: `${item.updatedAtIso ?? new Date().toISOString()}`,
  };
};

const persistDailyPaymentsToDisk = async (): Promise<void> => {
  try {
    const data = Array.from(dailyPaymentsByDateIso.values());
    await writeFile(dailyPaymentsBackupFilePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[daily-payments] Error persisting to disk:', err);
  }
};

const loadDailyPaymentsFromDisk = async (): Promise<DailyPaymentSummaryItem[]> => {
  try {
    const raw = await readFile(dailyPaymentsBackupFilePath, 'utf8');
    const parsed = JSON.parse(raw) as DailyPaymentSummaryItem[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => Boolean(item?.dateIso))
      .map((item) => normalizeDailyPaymentSummary(item));
  } catch {
    return [];
  }
};

const addPaymentToDailySummary = (
  dateIso: string,
  paymentMethod: 'efectivo' | 'tarjeta' | 'bizum',
  amount: number,
): DailyPaymentSummaryItem => {
  const current = dailyPaymentsByDateIso.get(dateIso) ?? {
    dateIso,
    efectivo: 0,
    tarjeta: 0,
    bizum: 0,
    total: 0,
    updatedAtIso: new Date().toISOString(),
  };

  const next: DailyPaymentSummaryItem = {
    ...current,
    [paymentMethod]: Number((current[paymentMethod] + amount).toFixed(2)),
    updatedAtIso: new Date().toISOString(),
  };

  const normalized = normalizeDailyPaymentSummary(next);
  dailyPaymentsByDateIso.set(dateIso, normalized);
  void persistDailyPaymentsToDisk();
  return normalized;
};

const appendTrackingHistory = (
  tracking: EmployeeTrackingInfo,
  action: EmployeeTrackingAction,
  createdAtIso: string,
  note: string,
): EmployeeTrackingInfo => ({
  ...tracking,
  history: [
    {
      action,
      createdAtIso,
      note,
    },
    ...tracking.history,
  ].slice(0, maxEmployeeTrackingHistoryItems),
});

const resolveNextTrackingState = (
  currentTracking: EmployeeTrackingInfo,
  action: EmployeeTrackingAction,
  note: string,
  nowIso: string,
): EmployeeTrackingInfo | null => {
  switch (action) {
    case 'check_in':
      return appendTrackingHistory(
        {
          ...currentTracking,
          workStatus: 'working',
          lastCheckInIso: nowIso,
          vacationNote: '',
          sickLeaveNote: '',
          recoveryHoursNote: '',
        },
        'check_in',
        nowIso,
        note || 'Entrada registrada',
      );
    case 'check_out':
      return appendTrackingHistory(
        {
          ...currentTracking,
          workStatus: 'idle',
          lastCheckOutIso: nowIso,
        },
        'check_out',
        nowIso,
        note || 'Salida registrada',
      );
    case 'vacation':
      return appendTrackingHistory(
        {
          ...currentTracking,
          workStatus: 'vacation',
          vacationNote: note || 'Vacaciones registradas',
        },
        'vacation',
        nowIso,
        note || 'Vacaciones registradas',
      );
    case 'sick_leave':
      return appendTrackingHistory(
        {
          ...currentTracking,
          workStatus: 'sick_leave',
          sickLeaveNote: note || 'Baja registrada',
        },
        'sick_leave',
        nowIso,
        note || 'Baja registrada',
      );
    case 'recovering_hours':
      return appendTrackingHistory(
        {
          ...currentTracking,
          workStatus: 'recovering_hours',
          recoveryHoursNote: note || 'Recuperación de horas',
        },
        'recovering_hours',
        nowIso,
        note || 'Recuperación de horas',
      );
    case 'clear_status':
      return appendTrackingHistory(
        {
          ...currentTracking,
          workStatus: 'idle',
          vacationNote: '',
          sickLeaveNote: '',
          recoveryHoursNote: '',
        },
        'clear_status',
        nowIso,
        note || 'Estado limpiado',
      );
    default:
      return null;
  }
};

const getRoleForEmail = (email: string): AppUserRole => {
  if (email === adminOwnerEmail) {
    return 'superadmin';
  }

  if (adminEmployeeEmails.has(email)) {
    return 'admin';
  }

  return 'client';
};

const upsertUser = (user: AppUser): void => {
  usersByEmail.set(user.email, user);
  usersByUsername.set(user.usernameLower, user);
  void persistUsersToDisk();
  saveUserToDb(user).catch((err: unknown) => {
    console.error('Error persistiendo usuario en DB:', err);
  });
};

const getSuperadminUser = (): AppUser | null => {
  for (const user of usersByEmail.values()) {
    if (user.role === 'superadmin') {
      return user;
    }
  }

  return null;
};

const syncAdminOwnerEmailFromUsers = (): void => {
  const superadmin = getSuperadminUser();

  if (superadmin) {
    adminOwnerEmail = superadmin.email;
  }
};

const seedAuthUsers = (): void => {
  if (authSeeded) {
    return;
  }

  authSeeded = true;

  const existingSuperadmin = getSuperadminUser();

  if (existingSuperadmin) {
    adminOwnerEmail = existingSuperadmin.email;
    return;
  }

  const ownerPassword = process.env['ADMIN_SUPERADMIN_PASSWORD'] ?? 'Hair-studio';
  const ownerUsername = process.env['ADMIN_SUPERADMIN_USERNAME']?.trim() || 'admin';
  const ownerUsernameLower = ownerUsername.toLowerCase();
  const existingOwnerByEmail = usersByEmail.get(adminOwnerEmail);
  const existingOwnerByUsername = usersByUsername.get(ownerUsernameLower);

  if (existingOwnerByEmail) {
    usersByUsername.delete(existingOwnerByEmail.usernameLower);
  }

  if (existingOwnerByUsername && existingOwnerByUsername.email !== adminOwnerEmail) {
    usersByEmail.delete(existingOwnerByUsername.email);
  }

  upsertUser({
    id: existingOwnerByEmail?.id ?? buildUserId(),
    email: adminOwnerEmail,
    username: ownerUsername,
    usernameLower: ownerUsernameLower,
    passwordHash: hashPassword(ownerPassword),
    role: 'superadmin',
    createdAtIso: existingOwnerByEmail?.createdAtIso ?? new Date().toISOString(),
    tracking: normalizeTrackingInfo(existingOwnerByEmail?.tracking),
  });

  if (process.env['SEED_MOCK_CLIENTS'] !== 'true') {
    void persistClientCardsToDisk();
    return;
  }

  const mockClients: Array<{ fullName: string; email: string; phone: string; notes: string }> = [
    {
      fullName: 'Lucía Martín',
      email: 'lucia.martin@cliente.local',
      phone: '611 100 101',
      notes: 'Le gusta reservar por la tarde.',
    },
    {
      fullName: 'Carmen Ruiz',
      email: 'carmen.ruiz@cliente.local',
      phone: '611 100 102',
      notes: 'Piel sensible en cuero cabelludo.',
    },
    {
      fullName: 'Marta Alonso',
      email: 'marta.alonso@cliente.local',
      phone: '611 100 103',
      notes: 'Prefiere tonos fríos.',
    },
    {
      fullName: 'Patricia Gómez',
      email: 'patricia.gomez@cliente.local',
      phone: '611 100 104',
      notes: 'Suele pedir corte + peinado.',
    },
    {
      fullName: 'Laura Pérez',
      email: 'laura.perez@cliente.local',
      phone: '611 100 105',
      notes: 'Avisar con antelación para sábados.',
    },
    {
      fullName: 'Ana Torres',
      email: 'ana.torres@cliente.local',
      phone: '611 100 106',
      notes: 'Cabello muy largo.',
    },
    {
      fullName: 'Elena Navarro',
      email: 'elena.navarro@cliente.local',
      phone: '611 100 107',
      notes: 'Cliente recurrente mensual.',
    },
    {
      fullName: 'Sonia Díaz',
      email: 'sonia.diaz@cliente.local',
      phone: '611 100 108',
      notes: 'Prefiere cita temprana.',
    },
    {
      fullName: 'Natalia Castro',
      email: 'natalia.castro@cliente.local',
      phone: '611 100 109',
      notes: 'Mechas cada 8 semanas.',
    },
    {
      fullName: 'Beatriz Molina',
      email: 'beatriz.molina@cliente.local',
      phone: '611 100 110',
      notes: 'Suele venir con pack cuidado.',
    },
  ];

  const mockClientTreatmentPlans: Array<Array<{ name: string; note: string }>> = [
    [
      { name: 'Corte + peinado', note: 'Retoque mensual' },
      { name: 'Hidratación profunda', note: 'Cabello seco' },
      { name: 'Corte + peinado', note: 'Mantenimiento de puntas' },
    ],
    [
      { name: 'Color raíz', note: 'Cobertura de cana' },
      { name: 'Matiz', note: 'Neutralizar tonos cálidos' },
      { name: 'Color raíz', note: 'Mantenimiento del color' },
      { name: 'Tratamiento calmante', note: 'Cuero cabelludo sensible' },
    ],
    [
      { name: 'Balayage', note: 'Reflejos suaves' },
      { name: 'Matiz', note: 'Tonos fríos' },
      { name: 'Balayage', note: 'Refuerzo de medios y puntas' },
      { name: 'Corte + peinado', note: 'Dar forma final' },
    ],
    [
      { name: 'Corte + peinado', note: 'Cambio de look' },
      { name: 'Botox capilar', note: 'Control de encrespado' },
      { name: 'Peinado evento', note: 'Boda de tarde' },
    ],
    [
      { name: 'Mechas babylight', note: 'Iluminar contorno' },
      { name: 'Matiz', note: 'Ajuste ceniza' },
      { name: 'Mechas babylight', note: 'Mantenimiento parcial' },
      { name: 'Hidratación profunda', note: 'Recuperación post-color' },
      { name: 'Corte + peinado', note: 'Saneado' },
    ],
    [
      { name: 'Alisado keratina', note: 'Reducir volumen' },
      { name: 'Corte + peinado', note: 'Definir capas largas' },
      { name: 'Hidratación profunda', note: 'Sellado de puntas' },
    ],
    [
      { name: 'Color fantasía', note: 'Tono cereza' },
      { name: 'Matiz', note: 'Brillo extra' },
      { name: 'Color fantasía', note: 'Refresco de intensidad' },
      { name: 'Tratamiento reparación', note: 'Proteger fibra' },
    ],
    [
      { name: 'Corte pixie', note: 'Repaso de nuca' },
      { name: 'Color raíz', note: 'Cobertura parcial' },
      { name: 'Corte pixie', note: 'Texturizado superior' },
      { name: 'Peinado express', note: 'Antes del trabajo' },
    ],
    [
      { name: 'Mechas balayage', note: 'Claridad media melena' },
      { name: 'Matiz', note: 'Enfriar reflejo' },
      { name: 'Mechas balayage', note: 'Mantenimiento cada 8 semanas' },
      { name: 'Hidratación profunda', note: 'Post decoloración' },
    ],
    [
      { name: 'Pack cuidado', note: 'Lavado + mascarilla + masaje' },
      { name: 'Corte + peinado', note: 'Largo medio' },
      { name: 'Pack cuidado', note: 'Sesión de mantenimiento' },
      { name: 'Brushing', note: 'Acabado de volumen' },
      { name: 'Pack cuidado', note: 'Hidratación intensiva' },
    ],
  ];

  mockClients.forEach((mockClient, index) => {
    const normalizedEmail = mockClient.email.toLowerCase();
    const existing = Array.from(clientCardsById.values()).find(
      (card) => card.email === normalizedEmail,
    );

    if (existing) {
      if (!existing.treatments) {
        clientCardsById.set(
          existing.id,
          normalizeClientCard({
            ...existing,
            treatments: [],
          }),
        );
      }

      return;
    }

    const nowDate = new Date();
    nowDate.setDate(nowDate.getDate() - (index + 1) * 3);

    const treatmentPlan = mockClientTreatmentPlans[index % mockClientTreatmentPlans.length];
    const cardId = buildClientCardId();

    clientCardsById.set(
      cardId,
      normalizeClientCard({
        id: cardId,
        fullName: mockClient.fullName,
        email: normalizedEmail,
        phone: mockClient.phone,
        notes: mockClient.notes,
        createdAtIso: nowDate.toISOString(),
        createdByEmail: adminOwnerEmail,
        treatments: treatmentPlan.map((item, treatmentIndex) => {
          const treatmentDate = new Date(nowDate);
          treatmentDate.setDate(nowDate.getDate() - (treatmentPlan.length - treatmentIndex) * 7);

          return {
            id: buildClientTreatmentId(),
            name: item.name,
            note: item.note,
            createdAtIso: treatmentDate.toISOString(),
            createdByEmail: adminOwnerEmail,
          };
        }),
      }),
    );
  });

  const ireneEmail = 'eneridelgado@gmail.com';
  const ireneMockPasswordHash = hashPassword('Qwertyu!');
  const ireneExistingCard = Array.from(clientCardsById.values()).find(
    (card) => card.email === ireneEmail,
  );

  const ireneMockTreatments: Array<{ name: string; note: string; createdAtIso: string }> = [
    {
      name: 'Pack Corte y Peinado',
      note: '[MOCK IRENE] Reserva pasada · septiembre',
      createdAtIso: '2025-09-12T10:30:00.000Z',
    },
    {
      name: 'Pack Color',
      note: '[MOCK IRENE] Reserva pasada · octubre',
      createdAtIso: '2025-10-18T16:00:00.000Z',
    },
    {
      name: 'Pack Ilumina',
      note: '[MOCK IRENE] Reserva pasada · noviembre',
      createdAtIso: '2025-11-23T11:00:00.000Z',
    },
    {
      name: 'Pack Invitada · Opción 2',
      note: '[MOCK IRENE] Reserva pasada · enero',
      createdAtIso: '2026-01-11T09:30:00.000Z',
    },
    {
      name: 'Pack Corte',
      note: '[MOCK IRENE] Reserva pasada · febrero',
      createdAtIso: '2026-02-07T17:30:00.000Z',
    },
  ];

  const ireneCurrentTreatments = ireneExistingCard?.treatments ?? [];
  const ireneHasMockTreatments = ireneCurrentTreatments.some((treatment) =>
    treatment.note.includes('[MOCK IRENE]'),
  );

  const ireneCard: ClientCardItem = normalizeClientCard(
    ireneExistingCard
      ? {
          ...ireneExistingCard,
          fullName: ireneExistingCard.fullName || 'Irene Delgado',
          phone: ireneExistingCard.phone || '611 200 200',
          notes: ireneExistingCard.notes || 'Cliente demo para visualización de historial.',
          passwordHash: ireneMockPasswordHash,
          treatments: ireneHasMockTreatments
            ? ireneCurrentTreatments
            : [
                ...ireneMockTreatments.map((item) => ({
                  id: buildClientTreatmentId(),
                  name: item.name,
                  note: item.note,
                  createdAtIso: item.createdAtIso,
                  createdByEmail: adminOwnerEmail,
                })),
                ...ireneCurrentTreatments,
              ],
        }
      : {
          id: buildClientCardId(),
          fullName: 'Irene Delgado',
          email: ireneEmail,
          phone: '611 200 200',
          notes: 'Cliente demo para visualización de historial.',
          createdAtIso: '2025-09-10T09:00:00.000Z',
          createdByEmail: adminOwnerEmail,
          passwordHash: ireneMockPasswordHash,
          treatments: ireneMockTreatments.map((item) => ({
            id: buildClientTreatmentId(),
            name: item.name,
            note: item.note,
            createdAtIso: item.createdAtIso,
            createdByEmail: adminOwnerEmail,
          })),
        },
  );

  clientCardsById.set(ireneCard.id, ireneCard);
  saveClientCardToDb(ireneCard).catch((err: unknown) => {
    console.error('Error persistiendo mock de Irene en DB:', err);
  });

  void persistClientCardsToDisk();
};

const createAuthSessionToken = (user: AppUser, expiresAtMs: number): string => {
  const payload = toBase64Url(
    JSON.stringify({
      email: user.email,
      role: user.role,
      exp: expiresAtMs,
    }),
  );
  const signature = signAuthTokenValue(payload);

  return `${payload}.${signature}`;
};

const verifyAuthSessionToken = (
  token: string,
): { email: string; role: AppUserRole; exp: number } | null => {
  const [payloadPart, signaturePart] = token.split('.');

  if (!payloadPart || !signaturePart || !authSessionSecret) {
    return null;
  }

  const expectedSignature = signAuthTokenValue(payloadPart);

  if (expectedSignature.length !== signaturePart.length) {
    return null;
  }

  const isValidSignature = timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(signaturePart),
  );

  if (!isValidSignature) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(payloadPart)) as {
      email?: unknown;
      role?: unknown;
      exp?: unknown;
    };

    if (
      typeof parsed.email !== 'string' ||
      typeof parsed.role !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }

    if (!['superadmin', 'admin', 'client'].includes(parsed.role)) {
      return null;
    }

    if (parsed.exp <= Date.now()) {
      return null;
    }

    return {
      email: parsed.email.toLowerCase(),
      role: parsed.role as AppUserRole,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
};

const getUserByIdentity = (identity: string): AppUser | null => {
  const value = identity.trim().toLowerCase();

  if (!value) {
    return null;
  }

  return usersByEmail.get(value) ?? usersByUsername.get(value) ?? null;
};

const getAuthSession = (cookieHeader: string | undefined): AppSession => {
  seedAuthUsers();

  const authToken = getCookieValue(cookieHeader, authCookieName);

  if (authToken) {
    const verified = verifyAuthSessionToken(authToken);

    if (verified) {
      const user = usersByEmail.get(verified.email);

      if (user) {
        const effectiveRole = getEffectiveUserRole(user);

        return {
          isAuthenticated: true,
          isAdmin: effectiveRole === 'admin' || effectiveRole === 'superadmin',
          email: user.email,
          username: user.username,
          role: effectiveRole,
        };
      }
    }
  }

  // Compatibilidad temporal: mantiene acceso por enlace mágico de email.
  const adminMagicToken = getCookieValue(cookieHeader, adminCookieName);

  if (adminMagicToken) {
    const verified = verifyAdminMagicToken(adminMagicToken);

    if (verified && verified.email === adminOwnerEmail) {
      return {
        isAuthenticated: true,
        isAdmin: true,
        email: adminOwnerEmail,
        username: usersByEmail.get(adminOwnerEmail)?.username ?? 'jefa',
        role: 'superadmin',
      };
    }
  }

  return {
    isAuthenticated: false,
    isAdmin: false,
    email: '',
    username: '',
    role: '',
  };
};

const buildAuthCookieValue = (token: string, maxAgeSeconds: number): string => {
  const secureFlag = process.env['NODE_ENV'] === 'production' ? '; Secure' : '';

  return `${authCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`;
};

const clearAuthCookies = (): string[] => {
  const secureFlag = process.env['NODE_ENV'] === 'production' ? '; Secure' : '';

  return [
    `${authCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`,
    `${adminCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`,
  ];
};

const isAdminRequest = (cookieHeader: string | undefined): { isAdmin: boolean; email: string } => {
  const session = getAuthSession(cookieHeader);

  if (!session.isAdmin) {
    return { isAdmin: false, email: '' };
  }

  return { isAdmin: true, email: session.email };
};

const isSuperadminRequest = (
  cookieHeader: string | undefined,
): { isSuperadmin: boolean; email: string } => {
  const session = getAuthSession(cookieHeader);

  if (session.role !== 'superadmin') {
    return { isSuperadmin: false, email: '' };
  }

  return { isSuperadmin: true, email: session.email };
};

const getEffectiveUserRole = (user: AppUser): AppUserRole => {
  if (user.role === 'client' && (user.permissions?.length ?? 0) > 0) {
    return 'admin';
  }

  return user.role;
};

const listUsersForSuperadmin = (): AdminEmployeeItem[] =>
  Array.from(usersByEmail.values())
    .map((user) => ({
      email: user.email,
      username: user.username,
      role: getEffectiveUserRole(user),
      createdAtIso: user.createdAtIso,
      tracking: normalizeTrackingInfo(user.tracking),
      permissions: user.permissions ?? [],
    }))
    .sort((a, b) => {
      if (a.role === b.role) {
        return a.email.localeCompare(b.email);
      }

      if (a.role === 'superadmin') return -1;
      if (b.role === 'superadmin') return 1;
      if (a.role === 'admin') return -1;
      if (b.role === 'admin') return 1;
      return 0;
    });

const buildAdminMagicLinkEmailHtml = (magicLink: string): string => {
  const safeLink = escapeHtml(magicLink);

  return `
    <div style="background:#fcf3ea;padding:24px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#3b2f2a;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;background:#fff9f4;border-radius:16px;overflow:hidden;border:1px solid #e8d8c9;">
        <tr>
          <td style="background:linear-gradient(135deg,#c97b63 0%,#d9a441 100%);padding:24px;">
            <p style="margin:0 0 6px;color:#fff6ee;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Arena Studio</p>
            <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.25;">Acceso temporal administración</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Has solicitado acceso al panel de administración.</p>
            <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#7a675d;">Este enlace caduca en 15 minutos.</p>

            <a href="${safeLink}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:linear-gradient(90deg,#c97b63 0%,#d9a441 100%);color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Entrar como admin</a>

            <p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#7a675d;word-break:break-all;">Si el botón no funciona, copia y pega este enlace:<br />${safeLink}</p>
          </td>
        </tr>
      </table>
    </div>
  `;
};

app.use(express.json());

app.post('/api/auth/register', (req, res) => {
  seedAuthUsers();

  const email = `${req.body?.email ?? ''}`.trim().toLowerCase();
  const username = `${req.body?.username ?? ''}`.trim();
  const password = `${req.body?.password ?? ''}`;
  const usernameLower = username.toLowerCase();

  const isValidEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  if (!email || !username || !password) {
    return res
      .status(400)
      .json({ ok: false, error: 'Email, usuario y contraseña son obligatorios.' });
  }

  if (!isValidEmail) {
    return res.status(400).json({ ok: false, error: 'El email no tiene un formato válido.' });
  }

  if (username.length < 3 || username.length > 40) {
    return res
      .status(400)
      .json({ ok: false, error: 'El usuario debe tener entre 3 y 40 caracteres.' });
  }

  if (password.length < 8) {
    return res
      .status(400)
      .json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' });
  }

  if (!/[A-Z]/.test(password)) {
    return res
      .status(400)
      .json({ ok: false, error: 'La contraseña debe incluir al menos una mayúscula.' });
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    return res
      .status(400)
      .json({ ok: false, error: 'La contraseña debe incluir al menos un carácter especial.' });
  }

  if (usersByEmail.has(email)) {
    if (email === adminOwnerEmail) {
      return res.status(409).json({
        ok: false,
        error: 'Ese email está reservado para superadmin. Inicia sesión con el usuario admin.',
      });
    }

    return res.status(409).json({ ok: false, error: 'Ya existe una cuenta con ese email.' });
  }

  if (usersByUsername.has(usernameLower)) {
    return res.status(409).json({ ok: false, error: 'Ese nombre de usuario ya está en uso.' });
  }

  const role = getRoleForEmail(email);

  const user: AppUser = {
    id: buildUserId(),
    email,
    username,
    usernameLower,
    passwordHash: hashPassword(password),
    role,
    createdAtIso: new Date().toISOString(),
    tracking: createDefaultTrackingInfo(),
  };

  upsertUser(user);

  const maxAgeSeconds = 60 * 60 * 24 * 7;
  const expiresAt = Date.now() + maxAgeSeconds * 1000;
  const token = createAuthSessionToken(user, expiresAt);

  res.setHeader('Set-Cookie', buildAuthCookieValue(token, maxAgeSeconds));

  return res.status(200).json({
    ok: true,
    user: {
      email: user.email,
      username: user.username,
      role: user.role,
    },
  });
});

app.post('/api/auth/login', (req, res) => {
  seedAuthUsers();

  const identity = `${req.body?.identity ?? ''}`;
  const password = `${req.body?.password ?? ''}`;

  if (!identity.trim() || !password) {
    return res
      .status(400)
      .json({ ok: false, error: 'Usuario/email y contraseña son obligatorios.' });
  }

  const user = getUserByIdentity(identity);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ ok: false, error: 'Credenciales inválidas.' });
  }

  const maxAgeSeconds = 60 * 60 * 24 * 7;
  const expiresAt = Date.now() + maxAgeSeconds * 1000;
  const token = createAuthSessionToken(user, expiresAt);

  res.setHeader('Set-Cookie', buildAuthCookieValue(token, maxAgeSeconds));

  return res.status(200).json({
    ok: true,
    user: {
      email: user.email,
      username: user.username,
      role: user.role,
    },
  });
});

app.get('/api/auth/session', (req, res) => {
  const session = getAuthSession(req.headers.cookie);
  const user = session.email ? usersByEmail.get(session.email) : undefined;

  return res.status(200).json({
    ok: true,
    isAuthenticated: session.isAuthenticated,
    isAdmin: session.isAdmin,
    email: session.email,
    username: session.username,
    role: session.role,
    permissions: user?.permissions ?? [],
  });
});

app.get('/api/empleado/fichaje', (req, res) => {
  seedAuthUsers();
  const session = getAuthSession(req.headers.cookie);

  if (!session.isAuthenticated || session.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo empleados autorizados pueden fichar.' });
  }

  const user = usersByEmail.get(session.email);

  if (!user) {
    return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
  }

  const tracking = normalizeTrackingInfo(user.tracking);

  return res.status(200).json({
    ok: true,
    tracking: {
      workStatus: tracking.workStatus,
      lastCheckInIso: tracking.lastCheckInIso,
      lastCheckOutIso: tracking.lastCheckOutIso,
    },
  });
});

app.post('/api/empleado/fichaje', (req, res) => {
  seedAuthUsers();
  const session = getAuthSession(req.headers.cookie);

  if (!session.isAuthenticated || session.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo empleados autorizados pueden fichar.' });
  }

  const user = usersByEmail.get(session.email);

  if (!user) {
    return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
  }

  const action = `${req.body?.action ?? ''}`.trim() as EmployeeTrackingAction;
  const note = `${req.body?.note ?? ''}`.trim().slice(0, 160);

  if (!['check_in', 'check_out'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'Acción de fichaje inválida.' });
  }

  const nowIso = new Date().toISOString();
  const currentTracking = normalizeTrackingInfo(user.tracking);
  const nextTracking = resolveNextTrackingState(currentTracking, action, note, nowIso);

  if (!nextTracking) {
    return res.status(400).json({ ok: false, error: 'No se pudo aplicar el fichaje.' });
  }

  upsertUser({
    ...user,
    tracking: nextTracking,
  });

  return res.status(200).json({
    ok: true,
    tracking: {
      workStatus: nextTracking.workStatus,
      lastCheckInIso: nextTracking.lastCheckInIso,
      lastCheckOutIso: nextTracking.lastCheckOutIso,
    },
  });
});

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearAuthCookies());

  return res.status(200).json({ ok: true });
});

app.post('/api/cliente/registro', (req, res) => {
  const nombre = `${req.body?.nombre ?? ''}`.trim();
  const apellidos = `${req.body?.apellidos ?? ''}`.trim();
  const fechaNacimiento = normalizeBirthDateIso(req.body?.fechaNacimiento);
  const telefono = `${req.body?.telefono ?? ''}`.trim();
  const email = `${req.body?.email ?? ''}`.trim().toLowerCase();
  const password = `${req.body?.password ?? ''}`.trim();

  if (!nombre || !apellidos || !fechaNacimiento || !telefono || !email || !password) {
    return res.status(400).json({
      ok: false,
      error: 'Todos los campos son obligatorios.',
    });
  }

  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!isValidEmail) {
    return res.status(400).json({ ok: false, error: 'El email no tiene un formato válido.' });
  }

  const phoneRegex = /^\d{9,}$/;
  if (!phoneRegex.test(telefono)) {
    return res.status(400).json({ ok: false, error: 'El teléfono debe tener al menos 9 dígitos.' });
  }

  const existingWithEmail = Array.from(clientCardsById.values()).find(
    (card) => card.email === email,
  );

  if (existingWithEmail) {
    return res.status(409).json({ ok: false, error: 'Ya existe una cuenta con ese email.' });
  }

  try {
    const fullName = `${nombre} ${apellidos}`;
    const passwordHash = hashPassword(password);

    const card: ClientCardItem = {
      id: buildClientCardId(),
      fullName,
      email,
      phone: telefono,
      birthDateIso: fechaNacimiento,
      notes: '',
      createdAtIso: new Date().toISOString(),
      createdByEmail: 'cliente-auto-registro',
      treatments: [],
      passwordHash,
    };

    const normalizedCard = normalizeClientCard(card);
    clientCardsById.set(card.id, normalizedCard);
    void persistClientCardsToDisk();
    saveClientCardToDb(normalizedCard).catch((err: unknown) => {
      console.error('Error persistiendo ficha de cliente en DB:', err);
    });

    return res.status(200).json({
      ok: true,
      message: '¡Cuenta creada exitosamente! Ya puedes iniciar sesión.',
      id: card.id,
    });
  } catch (error: unknown) {
    console.error('Error al registrar cliente:', error);
    return res
      .status(500)
      .json({ ok: false, error: 'Error al crear la cuenta. Intenta de nuevo.' });
  }
});

// Helper function to generate recovery token
function generateRecoveryToken(email: string): string {
  const secret = process.env['ADMIN_MAGIC_SECRET'] || 'secret-key';
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes
  const tokenData = `${email}:${expiresAt}`;

  // Simple HMAC-like token generation
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(tokenData);
  const token = hmac.digest('hex');

  clientRecoveryTokens.set(token, { email, expiresAt });

  return token;
}

// Helper function to validate recovery token
function validateRecoveryToken(token: string): { email: string } | null {
  const tokenData = clientRecoveryTokens.get(token);

  if (!tokenData) {
    return null;
  }

  if (Date.now() > tokenData.expiresAt) {
    clientRecoveryTokens.delete(token);
    return null;
  }

  return { email: tokenData.email };
}

// POST /api/cliente/solicitar-recuperacion
app.post('/api/cliente/solicitar-recuperacion', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ ok: false, error: 'Email es requerido' });
    }

    const emailLower = email.toLowerCase().trim();

    // Check if client exists
    const client = Array.from(clientCardsById.values()).find(
      (c) => c.email && c.email.toLowerCase() === emailLower,
    );

    if (!client) {
      // Don't reveal if email exists (security best practice)
      return res.status(200).json({
        ok: true,
        message:
          'Si la cuenta existe, recibirás un email con las instrucciones para recuperar tu contraseña.',
      });
    }

    // Generate recovery token
    const token = generateRecoveryToken(emailLower);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const recoveryLink = `${baseUrl}/cliente/recuperar?token=${encodeURIComponent(token)}`;

    // Send recovery email
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #27180f; border-bottom: 3px solid #c97b63; padding-bottom: 10px;">Recuperar Contraseña</h2>
        
        <p style="color: #333; font-size: 16px; margin: 20px 0;">
          Hemos recibido una solicitud para recuperar tu contraseña. Haz clic en el botón de abajo para crear una nueva contraseña.
        </p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${recoveryLink}" style="background-color: #c97b63; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">
            Recuperar Contraseña
          </a>
        </div>

        <p style="color: #666; font-size: 14px; margin: 20px 0;">
          O copia este enlace en tu navegador:<br>
          <span style="color: #c97b63; word-break: break-all;">${recoveryLink}</span>
        </p>

        <p style="color: #999; font-size: 12px; margin: 20px 0;">
          Este enlace expirará en 15 minutos.<br>
          Si no solicitaste recuperar tu contraseña, ignora este email.
        </p>

        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <div style="text-align: center; color: #999; font-size: 12px;">
          <p>© ${new Date().getFullYear()} Arena. Todos los derechos reservados.</p>
        </div>
      </div>
    `;

    const resendApiKey = process.env['RESEND_API_KEY'];
    const resendFromEmail = process.env['RESEND_FROM_EMAIL'] || 'noreply@arena.com';

    if (resendApiKey) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: resendFromEmail,
            to: emailLower,
            subject: 'Recupera tu contraseña - Arena',
            html: emailHtml,
          }),
        });

        if (!response.ok) {
          console.error('Error sending recovery email:', await response.text());
        }
      } catch (emailError) {
        console.error('Error sending recovery email:', emailError);
      }
    } else {
      console.warn('RESEND_API_KEY not configured, skipping email send');
    }

    return res.status(200).json({
      ok: true,
      message:
        'Si la cuenta existe, recibirás un email con las instrucciones para recuperar tu contraseña.',
    });
  } catch (error: unknown) {
    console.error('Error al solicitar recuperación:', error);
    return res
      .status(500)
      .json({ ok: false, error: 'Error al procesar la solicitud. Intenta de nuevo.' });
  }
});

// POST /api/cliente/resetear-contraseña
app.post('/api/cliente/resetear-contraseña', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ ok: false, error: 'Token inválido o expirado' });
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      return res
        .status(400)
        .json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres' });
    }

    // Validate recovery token
    const tokenData = validateRecoveryToken(token);

    if (!tokenData) {
      return res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
    }

    // Find client by email
    const client = Array.from(clientCardsById.values()).find(
      (c) => c.email && c.email.toLowerCase() === tokenData.email.toLowerCase(),
    );

    if (!client) {
      return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
    }

    // Hash new password
    const passwordHash = await hashPassword(password);

    // Update client
    client.passwordHash = passwordHash;
    clientCardsById.set(client.id, client);

    // Persist to disk
    const clientCardsFile = join(runtimeDataDir, 'cliente-cards.json');
    writeFileSync(clientCardsFile, JSON.stringify(Array.from(clientCardsById.values()), null, 2));

    // Persist to DB if configured
    saveClientCardToDb(client).catch((err: unknown) => {
      if (err) console.error('Error updating client password in DB:', err);
    });

    // Invalidate token
    clientRecoveryTokens.delete(token);

    return res.status(200).json({
      ok: true,
      message:
        '¡Contraseña actualizada exitosamente! Ya puedes iniciar sesión con tu nueva contraseña.',
    });
  } catch (error: unknown) {
    console.error('Error al resetear contraseña:', error);
    return res
      .status(500)
      .json({ ok: false, error: 'Error al actualizar la contraseña. Intenta de nuevo.' });
  }
});

const createClientSessionToken = (email: string, expiresAtMs: number): string => {
  const payload = toBase64Url(
    JSON.stringify({
      email,
      role: 'client',
      exp: expiresAtMs,
    }),
  );
  const signature = signAuthTokenValue(payload);

  return `${payload}.${signature}`;
};

const getClientSession = (
  cookieHeader: string | undefined,
): { isAuthenticated: boolean; email: string; card: ClientCardItem | null } => {
  const sessionToken = getCookieValue(cookieHeader, clientCookieName);

  if (!sessionToken) {
    return { isAuthenticated: false, email: '', card: null };
  }

  const verified = verifyAuthSessionToken(sessionToken);

  if (!verified || verified.role !== 'client') {
    return { isAuthenticated: false, email: '', card: null };
  }

  const card = Array.from(clientCardsById.values()).find(
    (item) => item.email.toLowerCase() === verified.email,
  );

  if (!card) {
    return { isAuthenticated: false, email: '', card: null };
  }

  return {
    isAuthenticated: true,
    email: verified.email,
    card,
  };
};

const getAlertSession = (
  cookieHeader: string | undefined,
): { isAuthenticated: boolean; email: string; card: ClientCardItem | null } => {
  const clientSession = getClientSession(cookieHeader);

  if (clientSession.isAuthenticated) {
    return clientSession;
  }

  const authSession = getAuthSession(cookieHeader);

  if (!authSession.isAuthenticated || authSession.role !== 'client') {
    return { isAuthenticated: false, email: '', card: null };
  }

  const card = Array.from(clientCardsById.values()).find(
    (item) => item.email.toLowerCase() === authSession.email.toLowerCase(),
  );

  return {
    isAuthenticated: true,
    email: authSession.email,
    card: card ?? null,
  };
};

const buildClientCookieValue = (token: string, maxAgeSeconds: number): string => {
  const secureFlag = process.env['NODE_ENV'] === 'production' ? '; Secure' : '';

  return `${clientCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`;
};

const clearClientCookie = (): string => {
  const secureFlag = process.env['NODE_ENV'] === 'production' ? '; Secure' : '';
  return `${clientCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`;
};

app.post('/api/cliente/login', (req, res) => {
  seedAuthUsers();
  const email = `${req.body?.email ?? req.body?.identity ?? ''}`.trim().toLowerCase();
  const password = `${req.body?.password ?? ''}`;

  if (!email || !password) {
    return res
      .status(400)
      .json({ ok: false, error: 'Email/nombre y contraseña son obligatorios.' });
  }

  // Buscar cliente por email exacto O por nombre
  const client = Array.from(clientCardsById.values()).find(
    (item) => item.email.toLowerCase() === email || item.fullName.toLowerCase().startsWith(email),
  );

  if (!client?.passwordHash || !verifyPassword(password, client.passwordHash)) {
    return res.status(401).json({ ok: false, error: 'Credenciales inválidas.' });
  }

  const maxAgeSeconds = 60 * 60 * 24 * 7;
  const token = createClientSessionToken(
    client.email.toLowerCase(),
    Date.now() + maxAgeSeconds * 1000,
  );

  res.setHeader('Set-Cookie', buildClientCookieValue(token, maxAgeSeconds));

  return res.status(200).json({
    ok: true,
    client: {
      id: client.id,
      fullName: client.fullName,
      email: client.email,
    },
  });
});

app.get('/api/cliente/session', (req, res) => {
  seedAuthUsers();
  const session = getClientSession(req.headers.cookie);

  return res.status(200).json({
    ok: true,
    isAuthenticated: session.isAuthenticated,
    client: session.card
      ? {
          id: session.card.id,
          fullName: session.card.fullName,
          email: session.card.email,
          phone: session.card.phone,
          birthDateIso: session.card.birthDateIso,
        }
      : null,
  });
});

app.post('/api/cliente/logout', (_req, res) => {
  seedAuthUsers();
  res.setHeader('Set-Cookie', clearClientCookie());
  return res.status(200).json({ ok: true });
});

app.get('/api/cliente/packs', (req, res) => {
  seedAuthUsers();
  const session = getClientSession(req.headers.cookie);

  if (!session.isAuthenticated || !session.card) {
    return res
      .status(401)
      .json({ ok: false, error: 'Debes iniciar sesión para ver tu historial.' });
  }

  return res.status(200).json({
    ok: true,
    client: {
      id: session.card.id,
      fullName: session.card.fullName,
      email: session.card.email,
    },
    treatments: session.card.treatments ?? [],
  });
});

app.post('/api/cliente/alertas', async (req, res) => {
  seedAuthUsers();
  const session = getAlertSession(req.headers.cookie);

  if (!session.isAuthenticated) {
    return res.status(401).json({ ok: false, error: 'Debes iniciar sesión para crear alertas.' });
  }

  const { dateIso, startTime, endTime, appointmentTypeName } = req.body ?? {};

  if (!dateIso || !startTime || !endTime || !appointmentTypeName) {
    return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios.' });
  }

  try {
    const existingAlerts = await getAlertsByClientEmail(session.email);

    if (existingAlerts.length >= 5) {
      return res.status(409).json({
        ok: false,
        error: 'Ya tienes el máximo de 5 alertas activas. Elimina una antes de crear otra.',
      });
    }

    const newAlert = await createAlert({
      clientEmail: session.email,
      dateIso,
      startTime,
      endTime,
      appointmentTypeName,
      status: 'active',
      approvalStatus: 'pending',
    });

    return res.status(201).json({ ok: true, alert: newAlert });
  } catch (error) {
    console.error('Error al crear alerta:', error);
    return res.status(500).json({ ok: false, error: 'Error al crear la alerta.' });
  }
});

app.get('/api/cliente/alertas', async (req, res) => {
  seedAuthUsers();
  const session = getAlertSession(req.headers.cookie);

  if (!session.isAuthenticated) {
    return res.status(401).json({ ok: false, error: 'Debes iniciar sesión para ver tus alertas.' });
  }

  try {
    const alerts = await getAlertsByClientEmail(session.email);
    return res.status(200).json({ ok: true, alerts });
  } catch (error) {
    console.error('Error al obtener alertas:', error);
    return res.status(500).json({ ok: false, error: 'Error al obtener las alertas.' });
  }
});

app.delete('/api/cliente/alertas/:id', async (req, res) => {
  seedAuthUsers();
  const session = getAlertSession(req.headers.cookie);

  if (!session.isAuthenticated) {
    return res
      .status(401)
      .json({ ok: false, error: 'Debes iniciar sesión para eliminar alertas.' });
  }

  const { id } = req.params;

  try {
    await deleteAlert(id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error al eliminar alerta:', error);
    return res.status(500).json({ ok: false, error: 'Error al eliminar la alerta.' });
  }
});

app.post('/api/admin/alertas/test', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const { clientEmail, dateIso, startTime, endTime, appointmentTypeName } = req.body ?? {};

  if (!clientEmail || !dateIso || !startTime || !endTime || !appointmentTypeName) {
    return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios.' });
  }

  try {
    const alert = await createAlert({
      clientEmail: `${clientEmail}`.trim().toLowerCase(),
      dateIso,
      startTime,
      endTime,
      appointmentTypeName,
      status: 'active',
      approvalStatus: 'pending',
    });

    return res.status(201).json({ ok: true, alert });
  } catch (error) {
    console.error('Error creando alerta de test admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo crear la alerta de test.' });
  }
});

app.get('/api/admin/alertas/test', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const email = `${req.query['email'] ?? ''}`.trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ ok: false, error: 'Email requerido.' });
  }

  try {
    const alerts = await getAlertsByClientEmail(email);
    return res.status(200).json({ ok: true, alerts });
  } catch (error) {
    console.error('Error listando alertas de test admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron listar las alertas.' });
  }
});

app.get('/api/admin/alertas', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(403).json({ ok: false, error: 'No autorizado.' });
  }

  const dateIso = `${req.query['dateIso'] ?? ''}`.trim();

  try {
    const alerts = await getAllAlerts();
    const filteredAlerts = dateIso ? alerts.filter((alert) => alert.dateIso === dateIso) : alerts;

    return res.status(200).json({ ok: true, alerts: filteredAlerts });
  } catch (error) {
    console.error('Error listando alertas admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron listar las alertas.' });
  }
});

app.patch('/api/admin/alertas/:id/aprobar', async (req, res) => {
  const session = isSuperadminRequest(req.headers.cookie);

  if (!session.isSuperadmin) {
    return res.status(403).json({ ok: false, error: 'Solo la superadmin puede aprobar alertas.' });
  }

  const alertId = `${req.params['id'] ?? ''}`.trim();

  if (!alertId) {
    return res.status(400).json({ ok: false, error: 'ID de alerta requerido.' });
  }

  try {
    const alert = await getAlertById(alertId);

    if (!alert || alert.status !== 'active') {
      return res.status(404).json({ ok: false, error: 'La alerta no existe o ya no está activa.' });
    }

    await updateAlertApprovalStatus(alertId, 'approved', session.email);

    const durationMinutes = getAlertDurationMinutes(alert);
    const availableSlots = await getAvailableSlotsForDate(alert.dateIso, durationMinutes);
    const slotIsAvailable = availableSlots.includes(alert.startTime);

    if (slotIsAvailable) {
      const sendOk = await sendAlertNotificationToClient(alert);

      if (sendOk) {
        await updateAlertStatus(alertId, 'completed');
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error aprobando alerta:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo aprobar la alerta.' });
  }
});

app.patch('/api/admin/alertas/:id/rechazar', async (req, res) => {
  const session = isSuperadminRequest(req.headers.cookie);

  if (!session.isSuperadmin) {
    return res.status(403).json({ ok: false, error: 'Solo la superadmin puede rechazar alertas.' });
  }

  const alertId = `${req.params['id'] ?? ''}`.trim();

  if (!alertId) {
    return res.status(400).json({ ok: false, error: 'ID de alerta requerido.' });
  }

  try {
    const alert = await getAlertById(alertId);

    if (!alert || alert.status !== 'active') {
      return res.status(404).json({ ok: false, error: 'La alerta no existe o ya no está activa.' });
    }

    await updateAlertApprovalStatus(alertId, 'rejected', session.email);
    await updateAlertStatus(alertId, 'cancelled');

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error rechazando alerta:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo rechazar la alerta.' });
  }
});

app.post('/api/admin/request-link', async (req, res) => {
  const email = `${req.body?.email ?? ''}`.trim().toLowerCase();
  const isProd = process.env['NODE_ENV'] === 'production';

  if (!email) {
    return res.status(200).json({
      ok: true,
      message: 'Si el correo está autorizado, recibirás un enlace de acceso.',
    });
  }

  if (email !== adminOwnerEmail) {
    return res.status(200).json({
      ok: true,
      message: 'Si el correo está autorizado, recibirás un enlace de acceso.',
    });
  }

  const apiKey = process.env['RESEND_API_KEY'];
  const fromEmail = process.env['RESEND_FROM_EMAIL'] ?? 'onboarding@resend.dev';

  if (!apiKey || !adminMagicSecret) {
    if (!isProd) {
      return res.status(200).json({
        ok: true,
        message:
          'No se pudo enviar email en local. Configura ADMIN_MAGIC_SECRET para usar enlace temporal.',
      });
    }

    return res.status(500).json({
      ok: false,
      error: 'Configuración de envío admin incompleta en servidor.',
    });
  }

  const expiresAt = Date.now() + 15 * 60 * 1000;
  const token = createAdminMagicToken(email, expiresAt);
  const baseUrl = process.env['APP_BASE_URL'] ?? `http://localhost:${process.env['PORT'] || 4000}`;
  const magicLink = `${baseUrl}/api/admin/verify?token=${encodeURIComponent(token)}`;

  try {
    const resend = new Resend(apiKey);
    const emailTarget = resolveEmailRecipient(email);
    const sendResult = await resend.emails.send({
      from: fromEmail,
      to: emailTarget,
      subject: 'Acceso admin temporal - Arena Studio',
      html: buildAdminMagicLinkEmailHtml(magicLink),
    });

    if (sendResult.error) {
      throw new Error(sendResult.error.message || 'Resend rechazó el envío del acceso admin.');
    }

    return res.status(200).json({
      ok: true,
      message: 'Si el correo está autorizado, recibirás un enlace de acceso.',
    });
  } catch (error) {
    console.error('Error enviando enlace admin:', error);

    if (!isProd) {
      return res.status(200).json({
        ok: true,
        message:
          'No se pudo enviar email en local. Usa el enlace temporal mostrado para continuar.',
        devMagicLink: magicLink,
      });
    }

    return res.status(500).json({
      ok: false,
      error: 'No se pudo enviar el enlace de acceso admin.',
    });
  }
});

app.get('/api/admin/verify', (req, res) => {
  seedAuthUsers();

  const token = `${req.query['token'] ?? ''}`;
  const verified = verifyAdminMagicToken(token);

  if (!verified || verified.email !== adminOwnerEmail) {
    return res.status(401).send('Enlace inválido o caducado.');
  }

  const user = usersByEmail.get(adminOwnerEmail);

  if (!user) {
    return res.status(500).send('No se pudo crear sesión de superadmin.');
  }

  const secureFlag = process.env['NODE_ENV'] === 'production' ? '; Secure' : '';
  const maxAgeSeconds = 60 * 60 * 24 * 7;
  const authToken = createAuthSessionToken(user, Date.now() + maxAgeSeconds * 1000);

  res.setHeader('Set-Cookie', [
    buildAuthCookieValue(authToken, maxAgeSeconds),
    `${adminCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secureFlag}`,
  ]);

  const redirectUrl = process.env['ADMIN_REDIRECT_URL'] ?? '/admin';
  return res.redirect(302, redirectUrl);
});

app.get('/api/admin/session', (req, res) => {
  const session = getAuthSession(req.headers.cookie);

  return res.status(200).json({
    ok: true,
    isAuthenticated: session.isAuthenticated,
    isAdmin: session.isAdmin,
    email: session.email,
    username: session.username,
    role: session.role,
  });
});

app.get('/api/admin/identificacion-usuarios', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const users = Array.from(usersByEmail.values())
    .map((user) => ({
      email: user.email,
      username: user.username,
      role: getEffectiveUserRole(user),
    }))
    .filter((user) => user.role === 'superadmin' || user.role === 'admin')
    .sort((a, b) => {
      if (a.role === b.role) {
        return a.username.localeCompare(b.username);
      }

      if (a.role === 'superadmin') return -1;
      if (b.role === 'superadmin') return 1;
      return 0;
    });

  return res.status(200).json({ ok: true, users });
});

app.get('/api/admin/almacen', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const products = Array.from(stockProductsById.values())
    .map((product) => normalizeStockProduct(product))
    .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));

  return res.status(200).json({ ok: true, products });
});

app.post('/api/admin/almacen', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const productName = `${req.body?.productName ?? ''}`.trim();
  const brand = `${req.body?.brand ?? ''}`.trim();
  const color = `${req.body?.color ?? ''}`.trim();
  const quantity = Number(req.body?.quantity ?? NaN);
  const price = Number(req.body?.price ?? NaN);
  const isSellable = Boolean(req.body?.isSellable);

  if (!productName || !brand || !color) {
    return res.status(400).json({
      ok: false,
      error: 'Nombre del producto, marca y color son obligatorios.',
    });
  }

  if (!Number.isFinite(quantity) || quantity < 0) {
    return res.status(400).json({
      ok: false,
      error: 'La cantidad debe ser un número válido igual o mayor que 0.',
    });
  }

  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({
      ok: false,
      error: 'El precio debe ser un número válido igual o mayor que 0.',
    });
  }

  const product = normalizeStockProduct({
    id: buildStockProductId(),
    productName,
    brand,
    color,
    quantity,
    price,
    isSellable,
    createdAtIso: new Date().toISOString(),
    createdByEmail: session.email,
  });

  stockProductsById.set(product.id, product);
  void persistStockProductsToDisk();

  return res.status(200).json({ ok: true, product });
});

// ── Cierre de caja ─────────────────────────────────────────────────────────

app.patch('/api/admin/almacen/:id/quantity', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const { id } = req.params;
  const delta = Number(req.body?.delta ?? NaN);

  if (!Number.isFinite(delta) || !Number.isInteger(delta)) {
    return res.status(400).json({ ok: false, error: 'El delta debe ser un entero.' });
  }

  const product = stockProductsById.get(id);

  if (!product) {
    return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
  }

  const newQuantity = product.quantity + delta;

  if (newQuantity < 0) {
    return res.status(400).json({ ok: false, error: 'No hay suficiente stock.' });
  }

  const updated = { ...product, quantity: newQuantity };
  stockProductsById.set(id, updated);
  void persistStockProductsToDisk();

  return res.status(200).json({ ok: true, product: normalizeStockProduct(updated) });
});

app.get('/api/admin/cierre-caja', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const cierres = Array.from(cierreCajaById.values())
    .map(normalizeCierre)
    .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));

  return res.status(200).json({ ok: true, cierres });
});

app.get('/api/admin/cierre-caja/auto-diario', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const today = dailyPaymentsByDateIso.get(todayIso) ?? {
    dateIso: todayIso,
    efectivo: 0,
    tarjeta: 0,
    bizum: 0,
    total: 0,
    updatedAtIso: '',
  };

  return res.status(200).json({
    ok: true,
    today: normalizeDailyPaymentSummary(today),
  });
});

app.post('/api/admin/cierre-caja', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  try {
    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as {
            efectivo?: unknown;
            tarjeta?: unknown;
            bizum?: unknown;
            notas?: unknown;
          })
        : {};

    const ef = parseCierreAmount(body.efectivo);
    const ta = parseCierreAmount(body.tarjeta);
    const bi = parseCierreAmount(body.bizum);

    if (ef === null || ta === null || bi === null) {
      return res.status(400).json({
        ok: false,
        error: 'Los importes deben ser números válidos.',
      });
    }

    if (ef < 0 || ta < 0 || bi < 0) {
      return res.status(400).json({ ok: false, error: 'Los importes no pueden ser negativos.' });
    }

    const now = new Date();
    const fechaIso = now.toISOString().slice(0, 10);

    const cierre = normalizeCierre({
      id: buildCierreId(),
      fechaIso,
      efectivo: ef,
      tarjeta: ta,
      bizum: bi,
      total: ef + ta + bi,
      notas: typeof body.notas === 'string' ? body.notas.trim().slice(0, 500) : '',
      registradoPorEmail: session.email,
      createdAtIso: now.toISOString(),
      // preparado para envío futuro a servicio fiscal (ej. Verifactu/SII)
      enviadoAlServicioFiscal: false,
      idServicioFiscal: '',
    });

    cierreCajaById.set(cierre.id, cierre);
    void persistCierreCajaToDisk();

    // TODO: cuando se conecte el servicio fiscal externo, llamar aquí a la API
    // correspondiente (ej. Verifactu, SII, software de contabilidad) y actualizar
    // cierre.enviadoAlServicioFiscal y cierre.idServicioFiscal con la respuesta.

    return res.status(200).json({ ok: true, cierre });
  } catch (error) {
    console.error('[cierre-caja] Error registrando cierre:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo registrar el cierre en este momento.',
    });
  }
});

app.patch('/api/admin/cierre-caja/:id', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const id = `${req.params['id'] ?? ''}`.trim();

  if (!id) {
    return res.status(400).json({ ok: false, error: 'ID de cierre inválido.' });
  }

  const existing = cierreCajaById.get(id);

  if (!existing) {
    return res.status(404).json({ ok: false, error: 'Cierre no encontrado.' });
  }

  const body =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as { efectivo?: unknown; tarjeta?: unknown; bizum?: unknown; notas?: unknown })
      : {};

  const ef = parseCierreAmount(body.efectivo);
  const ta = parseCierreAmount(body.tarjeta);
  const bi = parseCierreAmount(body.bizum);

  if (ef === null || ta === null || bi === null) {
    return res.status(400).json({ ok: false, error: 'Los importes deben ser números válidos.' });
  }

  if (ef < 0 || ta < 0 || bi < 0) {
    return res.status(400).json({ ok: false, error: 'Los importes no pueden ser negativos.' });
  }

  const updated = normalizeCierre({
    ...existing,
    efectivo: ef,
    tarjeta: ta,
    bizum: bi,
    total: ef + ta + bi,
    notas: typeof body.notas === 'string' ? body.notas.trim().slice(0, 500) : existing.notas,
  });

  cierreCajaById.set(id, updated);
  void persistCierreCajaToDisk();

  return res.status(200).json({ ok: true, cierre: updated });
});

app.delete('/api/admin/cierre-caja/:id', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const id = `${req.params['id'] ?? ''}`.trim();

  if (!id) {
    return res.status(400).json({ ok: false, error: 'ID de cierre inválido.' });
  }

  if (!cierreCajaById.has(id)) {
    return res.status(404).json({ ok: false, error: 'Cierre no encontrado.' });
  }

  cierreCajaById.delete(id);
  void persistCierreCajaToDisk();

  return res.status(200).json({ ok: true });
});

app.get('/api/admin/clientes', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const cards = Array.from(clientCardsById.values())
    .map((card) => normalizeClientCard(card))
    .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));

  return res.status(200).json({ ok: true, cards });
});

app.post('/api/admin/clientes', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const fullName = `${req.body?.fullName ?? ''}`.trim();
  const email = `${req.body?.email ?? ''}`.trim().toLowerCase();
  const phone = `${req.body?.phone ?? ''}`.trim();
  const birthDateIso = normalizeBirthDateIso(req.body?.birthDateIso);
  const notes = `${req.body?.notes ?? ''}`.trim().slice(0, 500);

  if (!fullName || !email || !phone || !birthDateIso) {
    return res.status(400).json({
      ok: false,
      error: 'Nombre, email, teléfono y fecha de nacimiento son obligatorios.',
    });
  }

  const isValidEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  if (!isValidEmail) {
    return res.status(400).json({ ok: false, error: 'El email no tiene un formato válido.' });
  }

  const existingWithEmail = Array.from(clientCardsById.values()).find(
    (card) => card.email === email,
  );

  if (existingWithEmail) {
    return res.status(409).json({ ok: false, error: 'Ya existe una ficha con ese email.' });
  }

  const card: ClientCardItem = {
    id: buildClientCardId(),
    fullName,
    email,
    phone,
    birthDateIso,
    notes,
    createdAtIso: new Date().toISOString(),
    createdByEmail: session.email,
    treatments: [],
  };

  const normalizedCard = normalizeClientCard(card);
  clientCardsById.set(card.id, normalizedCard);
  void persistClientCardsToDisk();
  saveClientCardToDb(normalizedCard).catch((err: unknown) => {
    console.error('Error persistiendo ficha de cliente en DB:', err);
  });

  return res.status(200).json({ ok: true, card: normalizedCard });
});

app.patch('/api/admin/clientes/:id', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const id = `${req.params['id'] ?? ''}`.trim();
  const fullName = `${req.body?.fullName ?? ''}`.trim();
  const email = `${req.body?.email ?? ''}`.trim().toLowerCase();
  const phone = `${req.body?.phone ?? ''}`.trim();
  const birthDateIso = normalizeBirthDateIso(req.body?.birthDateIso);
  const notes = `${req.body?.notes ?? ''}`.trim().slice(0, 500);

  if (!id || !fullName || !email || !phone || !birthDateIso) {
    return res.status(400).json({
      ok: false,
      error: 'Nombre, email, teléfono y fecha de nacimiento son obligatorios.',
    });
  }

  const card = clientCardsById.get(id);

  if (!card) {
    return res.status(404).json({ ok: false, error: 'Ficha de cliente no encontrada.' });
  }

  const isValidEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  if (!isValidEmail) {
    return res.status(400).json({ ok: false, error: 'El email no tiene un formato válido.' });
  }

  const existingWithEmail = Array.from(clientCardsById.values()).find(
    (currentCard) => currentCard.email === email && currentCard.id !== id,
  );

  if (existingWithEmail) {
    return res.status(409).json({ ok: false, error: 'Ya existe una ficha con ese email.' });
  }

  const nextCard = normalizeClientCard({
    ...card,
    fullName,
    email,
    phone,
    birthDateIso,
    notes,
  });

  clientCardsById.set(id, nextCard);
  void persistClientCardsToDisk();
  saveClientCardToDb(nextCard).catch((err: unknown) => {
    console.error('Error persistiendo actualización de ficha de cliente en DB:', err);
  });

  return res.status(200).json({ ok: true, card: nextCard });
});

app.post('/api/admin/clientes/:id/packs', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const id = `${req.params['id'] ?? ''}`.trim();
  const name = `${req.body?.name ?? ''}`.trim();
  const note = `${req.body?.note ?? ''}`.trim().slice(0, 300);

  if (!id || !name) {
    return res
      .status(400)
      .json({ ok: false, error: 'ID de cliente y tratamiento son obligatorios.' });
  }

  const card = clientCardsById.get(id);

  if (!card) {
    return res.status(404).json({ ok: false, error: 'Ficha de cliente no encontrada.' });
  }

  const treatment: ClientTreatmentItem = {
    id: buildClientTreatmentId(),
    name: name.slice(0, 80),
    note,
    createdAtIso: new Date().toISOString(),
    createdByEmail: session.email,
    priceEuro: getPackPriceByName(name.slice(0, 80)),
    paymentMethod: null,
  };

  const nextCard = normalizeClientCard({
    ...card,
    treatments: [treatment, ...(card.treatments ?? [])],
  });

  clientCardsById.set(card.id, nextCard);
  void persistClientCardsToDisk();
  saveClientCardToDb(nextCard).catch((err: unknown) => {
    console.error('Error persistiendo tratamiento en DB:', err);
  });

  return res.status(200).json({ ok: true, card: nextCard });
});

app.patch('/api/admin/clientes/:clientId/packs/:treatmentId/payment', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const clientId = `${req.params['clientId'] ?? ''}`.trim();
  const treatmentId = `${req.params['treatmentId'] ?? ''}`.trim();
  const priceEuro = Number(req.body?.priceEuro ?? NaN);
  const paymentMethod = req.body?.paymentMethod ?? null;

  if (!clientId || !treatmentId) {
    return res.status(400).json({
      ok: false,
      error: 'ID de cliente e ID de tratamiento son obligatorios.',
    });
  }

  if (!['efectivo', 'tarjeta', 'bizum'].includes(paymentMethod)) {
    return res.status(400).json({
      ok: false,
      error: 'Método de pago debe ser "efectivo", "tarjeta" o "bizum".',
    });
  }

  if (!Number.isFinite(priceEuro) || priceEuro < 0) {
    return res.status(400).json({
      ok: false,
      error: 'Precio debe ser un número válido igual o mayor que 0.',
    });
  }

  const card = clientCardsById.get(clientId);

  if (!card) {
    return res.status(404).json({ ok: false, error: 'Ficha de cliente no encontrada.' });
  }

  const treatment = card.treatments?.find((t) => t.id === treatmentId);

  if (!treatment) {
    return res.status(404).json({ ok: false, error: 'Tratamiento no encontrado.' });
  }

  if (treatment.paymentMethod) {
    return res.status(409).json({
      ok: false,
      error: `Este tratamiento ya estaba cobrado por ${treatment.paymentMethod}.`,
    });
  }

  const updatedTreatment: ClientTreatmentItem = {
    ...treatment,
    priceEuro: Number(priceEuro.toFixed(2)),
    paymentMethod: paymentMethod as 'efectivo' | 'tarjeta' | 'bizum',
  };

  const updatedTreatments = (card.treatments ?? []).map((t) =>
    t.id === treatmentId ? updatedTreatment : t,
  );

  const updatedCard: ClientCardItem = {
    ...card,
    treatments: updatedTreatments,
  };

  clientCardsById.set(clientId, updatedCard);
  void persistClientCardsToDisk();
  const todayIso = new Date().toISOString().slice(0, 10);
  addPaymentToDailySummary(
    todayIso,
    paymentMethod as 'efectivo' | 'tarjeta' | 'bizum',
    Number(priceEuro.toFixed(2)),
  );
  saveClientCardToDb(updatedCard).catch((err: unknown) => {
    console.error('Error persistiendo pago de tratamiento en DB:', err);
  });

  return res.status(200).json({ ok: true, card: updatedCard });
});

app.get('/api/admin/empleados', (req, res) => {
  seedAuthUsers();
  const session = isSuperadminRequest(req.headers.cookie);

  if (!session.isSuperadmin) {
    return res.status(403).json({ ok: false, error: 'Solo superadmin puede gestionar empleados.' });
  }

  return res.status(200).json({
    ok: true,
    users: listUsersForSuperadmin(),
  });
});

app.post('/api/admin/empleados', (req, res) => {
  seedAuthUsers();
  const session = isSuperadminRequest(req.headers.cookie);

  if (!session.isSuperadmin) {
    return res.status(403).json({ ok: false, error: 'Solo superadmin puede gestionar empleados.' });
  }

  const email = `${req.body?.email ?? ''}`.trim().toLowerCase();
  const username = `${req.body?.username ?? ''}`.trim();
  const password = `${req.body?.password ?? ''}`;
  const role = `${req.body?.role ?? 'admin'}`.trim() as AppUserRole;
  const usernameLower = username.toLowerCase();
  const rawPermissions: unknown = req.body?.permissions;
  const permissions: EmployeePermission[] = Array.isArray(rawPermissions)
    ? rawPermissions.filter((p): p is EmployeePermission =>
        ALL_EMPLOYEE_PERMISSIONS.includes(p as EmployeePermission),
      )
    : [];

  if (!email || !username || !password) {
    return res
      .status(400)
      .json({ ok: false, error: 'Email, usuario y contraseña son obligatorios.' });
  }

  const isValidEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  if (!isValidEmail) {
    return res.status(400).json({ ok: false, error: 'El email no tiene un formato válido.' });
  }

  if (username.length < 3 || username.length > 40) {
    return res
      .status(400)
      .json({ ok: false, error: 'El usuario debe tener entre 3 y 40 caracteres.' });
  }

  if (password.length < 8) {
    return res
      .status(400)
      .json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' });
  }

  if (!/[A-Z]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return res.status(400).json({
      ok: false,
      error: 'La contraseña debe incluir una mayúscula y un carácter especial.',
    });
  }

  if (!['admin', 'client'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Rol inválido.' });
  }

  if (email === adminOwnerEmail) {
    return res.status(409).json({ ok: false, error: 'Ese email está reservado para superadmin.' });
  }

  if (usersByEmail.has(email)) {
    return res.status(409).json({ ok: false, error: 'Ya existe una cuenta con ese email.' });
  }

  if (usersByUsername.has(usernameLower)) {
    return res.status(409).json({ ok: false, error: 'Ese nombre de usuario ya está en uso.' });
  }

  upsertUser({
    id: buildUserId(),
    email,
    username,
    usernameLower,
    passwordHash: hashPassword(password),
    role,
    createdAtIso: new Date().toISOString(),
    tracking: createDefaultTrackingInfo(),
    permissions,
  });

  return res.status(200).json({ ok: true });
});

app.patch('/api/admin/superadmin/credenciales', (req, res) => {
  seedAuthUsers();
  const session = isSuperadminRequest(req.headers.cookie);

  if (!session.isSuperadmin) {
    return res
      .status(403)
      .json({ ok: false, error: 'Solo superadmin puede actualizar credenciales.' });
  }

  const currentSuperadmin = getSuperadminUser();

  if (!currentSuperadmin) {
    return res.status(404).json({ ok: false, error: 'No se encontró la cuenta superadmin.' });
  }

  const email = `${req.body?.email ?? ''}`.trim().toLowerCase();
  const username = `${req.body?.username ?? ''}`.trim();
  const password = `${req.body?.password ?? ''}`;
  const usernameLower = username.toLowerCase();

  if (!email || !username) {
    return res.status(400).json({ ok: false, error: 'Email y usuario son obligatorios.' });
  }

  const isValidEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  if (!isValidEmail) {
    return res.status(400).json({ ok: false, error: 'El email no tiene un formato válido.' });
  }

  if (username.length < 3 || username.length > 40) {
    return res
      .status(400)
      .json({ ok: false, error: 'El usuario debe tener entre 3 y 40 caracteres.' });
  }

  if (password) {
    if (password.length < 8) {
      return res
        .status(400)
        .json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' });
    }

    if (!/[A-Z]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      return res.status(400).json({
        ok: false,
        error: 'La contraseña debe incluir una mayúscula y un carácter especial.',
      });
    }
  }

  const userByEmail = usersByEmail.get(email);

  if (userByEmail && userByEmail.id !== currentSuperadmin.id) {
    return res.status(409).json({ ok: false, error: 'Ya existe una cuenta con ese email.' });
  }

  const userByUsername = usersByUsername.get(usernameLower);

  if (userByUsername && userByUsername.id !== currentSuperadmin.id) {
    return res.status(409).json({ ok: false, error: 'Ese nombre de usuario ya está en uso.' });
  }

  usersByEmail.delete(currentSuperadmin.email);
  usersByUsername.delete(currentSuperadmin.usernameLower);

  const updatedSuperadmin: AppUser = {
    ...currentSuperadmin,
    email,
    username,
    usernameLower,
    passwordHash: password ? hashPassword(password) : currentSuperadmin.passwordHash,
    role: 'superadmin',
  };

  upsertUser(updatedSuperadmin);
  adminOwnerEmail = updatedSuperadmin.email;

  const maxAgeSeconds = 60 * 60 * 24 * 7;
  const expiresAt = Date.now() + maxAgeSeconds * 1000;
  const token = createAuthSessionToken(updatedSuperadmin, expiresAt);

  res.setHeader('Set-Cookie', buildAuthCookieValue(token, maxAgeSeconds));

  return res.status(200).json({
    ok: true,
    user: {
      email: updatedSuperadmin.email,
      username: updatedSuperadmin.username,
      role: updatedSuperadmin.role,
    },
  });
});

app.delete('/api/admin/empleados/:email', (req, res) => {
  seedAuthUsers();
  const session = isSuperadminRequest(req.headers.cookie);

  if (!session.isSuperadmin) {
    return res.status(403).json({ ok: false, error: 'Solo superadmin puede gestionar empleados.' });
  }

  const email = `${req.params['email'] ?? ''}`.trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ ok: false, error: 'Email inválido.' });
  }

  const targetUser = usersByEmail.get(email);

  if (!targetUser) {
    return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
  }

  if (targetUser.email === adminOwnerEmail || targetUser.role === 'superadmin') {
    return res.status(409).json({ ok: false, error: 'La cuenta superadmin no se puede eliminar.' });
  }

  usersByEmail.delete(targetUser.email);
  usersByUsername.delete(targetUser.usernameLower);
  void persistUsersToDisk();
  deleteUserFromDb(targetUser.email).catch((err: unknown) => {
    console.error('Error eliminando usuario de DB:', err);
  });

  return res.status(200).json({ ok: true });
});

app.patch('/api/admin/empleados/:email/rol', (req, res) => {
  seedAuthUsers();
  const session = isSuperadminRequest(req.headers.cookie);

  if (!session.isSuperadmin) {
    return res.status(403).json({ ok: false, error: 'Solo superadmin puede gestionar empleados.' });
  }

  const email = `${req.params['email'] ?? ''}`.trim().toLowerCase();
  const role = `${req.body?.role ?? ''}`.trim() as AppUserRole;

  if (!email || !['admin', 'client'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos.' });
  }

  const targetUser = usersByEmail.get(email);

  if (!targetUser) {
    return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
  }

  if (targetUser.email === adminOwnerEmail) {
    return res
      .status(409)
      .json({ ok: false, error: 'La cuenta superadmin no se puede modificar.' });
  }

  upsertUser({
    ...targetUser,
    role,
    permissions: role === 'client' ? [] : (targetUser.permissions ?? []),
  });

  return res.status(200).json({ ok: true });
});

app.patch('/api/admin/empleados/:email/permissions', (req, res) => {
  seedAuthUsers();
  const session = isSuperadminRequest(req.headers.cookie);

  if (!session.isSuperadmin) {
    return res.status(403).json({ ok: false, error: 'Solo superadmin puede gestionar empleados.' });
  }

  const email = `${req.params['email'] ?? ''}`.trim().toLowerCase();
  const rawPermissions: unknown = req.body?.permissions;

  if (!email) {
    return res.status(400).json({ ok: false, error: 'Email inválido.' });
  }

  const targetUser = usersByEmail.get(email);

  if (!targetUser) {
    return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
  }

  if (targetUser.role === 'superadmin') {
    return res
      .status(409)
      .json({ ok: false, error: 'El superadmin siempre tiene todos los permisos.' });
  }

  const permissions: EmployeePermission[] = Array.isArray(rawPermissions)
    ? rawPermissions.filter((p): p is EmployeePermission =>
        ALL_EMPLOYEE_PERMISSIONS.includes(p as EmployeePermission),
      )
    : [];

  upsertUser({ ...targetUser, permissions });

  return res.status(200).json({ ok: true, permissions });
});

app.patch('/api/admin/empleados/:email/tracking', (req, res) => {
  seedAuthUsers();
  const session = isSuperadminRequest(req.headers.cookie);

  if (!session.isSuperadmin) {
    return res.status(403).json({ ok: false, error: 'Solo superadmin puede gestionar empleados.' });
  }

  const email = `${req.params['email'] ?? ''}`.trim().toLowerCase();
  const action = `${req.body?.action ?? ''}`.trim() as EmployeeTrackingAction;
  const note = `${req.body?.note ?? ''}`.trim().slice(0, 160);
  const nowIso = new Date().toISOString();
  const targetUser = usersByEmail.get(email);

  if (!targetUser) {
    return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
  }

  if (targetUser.role === 'superadmin') {
    return res.status(409).json({ ok: false, error: 'La cuenta superadmin no admite fichaje.' });
  }

  const currentTracking = normalizeTrackingInfo(targetUser.tracking);
  const nextTracking = resolveNextTrackingState(currentTracking, action, note, nowIso);

  if (!nextTracking) {
    return res.status(400).json({ ok: false, error: 'Acción de fichaje inválida.' });
  }

  upsertUser({
    ...targetUser,
    tracking: nextTracking,
  });

  return res.status(200).json({ ok: true });
});

app.get('/api/admin/reservas', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  try {
    const reservations = await listReservationsForAdmin();
    await dispatch48hReservationReminders(reservations);
    return res.status(200).json({ ok: true, reservations });
  } catch (error) {
    console.error('Error listando reservas admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron listar las reservas.' });
  }
});

app.patch('/api/admin/reservas/:id/client-confirmation', async (req, res) => {
  const session = isSuperadminRequest(req.headers.cookie);

  if (!session.isSuperadmin) {
    return res.status(403).json({ ok: false, error: 'Solo superadmin puede confirmar cita.' });
  }

  const reservationId = `${req.params['id'] ?? ''}`.trim();

  if (!reservationId) {
    return res.status(400).json({ ok: false, error: 'ID de reserva inválido.' });
  }

  try {
    const reservation = await getReservationByIdForAdmin(reservationId);

    if (!reservation) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    if (reservation.adminStatus === 'rejected') {
      return res.status(409).json({ ok: false, error: 'La reserva ya está rechazada.' });
    }

    const updated = await updateReservationClientConfirmationStatus(reservationId, 'confirmed');

    if (!updated.ok) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error confirmando cita desde superadmin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo confirmar la cita.' });
  }
});

app.get('/api/admin/bloqueos', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  try {
    const blockedPeriods = await listBlockedPeriodsForAdmin();
    return res.status(200).json({ ok: true, blockedPeriods });
  } catch (error) {
    console.error('Error listando bloqueos admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron listar los bloqueos.' });
  }
});

app.post('/api/admin/bloqueos', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const dateIso = `${req.body?.dateIso ?? ''}`;
  const startTime = `${req.body?.startTime ?? ''}`;
  const endTime = `${req.body?.endTime ?? ''}`;
  const reason = `${req.body?.reason ?? ''}`;

  if (!dateIso || !startTime || !endTime) {
    return res.status(400).json({ ok: false, error: 'Fecha y rango horario son obligatorios.' });
  }

  try {
    const created = await createBlockedPeriodForAdmin({ dateIso, startTime, endTime, reason });

    if (!created.ok) {
      if (created.reason === 'invalid-time') {
        return res.status(400).json({
          ok: false,
          error:
            'Rango horario inválido. Usa tramos de 30 min en horario de servicio: martes a viernes 10:00-18:00 y sábados 09:00-13:00.',
        });
      }

      if (created.reason === 'reservation-conflict') {
        return res.status(409).json({
          ok: false,
          error: 'No se puede bloquear porque ya hay reservas en ese tramo.',
        });
      }

      return res.status(409).json({
        ok: false,
        error: 'Ese tramo ya estaba bloqueado total o parcialmente.',
      });
    }

    return res.status(200).json({ ok: true, blockId: created.blockId });
  } catch (error) {
    console.error('Error creando bloqueo admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo crear el bloqueo.' });
  }
});

app.delete('/api/admin/bloqueos/:id', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const blockId = `${req.params['id'] ?? ''}`;

  if (!blockId) {
    return res.status(400).json({ ok: false, error: 'ID de bloqueo inválido.' });
  }

  try {
    const deleted = await deleteBlockedPeriodForAdmin(blockId);

    if (!deleted.ok) {
      return res.status(404).json({ ok: false, error: 'Bloqueo no encontrado.' });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error eliminando bloqueo admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo eliminar el bloqueo.' });
  }
});

app.patch('/api/admin/reservas/:id/payment', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const reservationId = `${req.params['id'] ?? ''}`;
  const paymentReceived = Boolean(req.body?.paymentReceived);
  const paymentMethod = req.body?.paymentMethod as string | undefined;
  const requestPriceEuro = Number(req.body?.priceEuro ?? NaN);

  if (!reservationId) {
    return res.status(400).json({ ok: false, error: 'ID de reserva inválido.' });
  }

  try {
    const reservations = await listReservationsForAdmin();
    const reservation = reservations.find((item) => item.id === reservationId);

    if (!reservation) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    const resolvedPriceEuro =
      Number.isFinite(requestPriceEuro) && requestPriceEuro >= 0
        ? Number(requestPriceEuro.toFixed(2))
        : Number(getPackPriceByName(reservation.appointmentTypeName).toFixed(2));
    const shouldAccumulate =
      paymentReceived &&
      !reservation.paymentReceived &&
      paymentMethod &&
      ['efectivo', 'tarjeta', 'bizum'].includes(paymentMethod);

    const updated = await updateReservationPaymentReceived(reservationId, paymentReceived);

    if (!updated.ok) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    if (shouldAccumulate) {
      const todayIso = new Date().toISOString().slice(0, 10);
      addPaymentToDailySummary(
        todayIso,
        paymentMethod as 'efectivo' | 'tarjeta' | 'bizum',
        resolvedPriceEuro,
      );
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error actualizando pago de reserva:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo actualizar el pago.' });
  }
});

app.patch('/api/admin/reservas/:id', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);
  const superadminSession = isSuperadminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const reservationId = `${req.params['id'] ?? ''}`.trim();
  const dateIso = `${req.body?.dateIso ?? ''}`.trim();
  const startTime = `${req.body?.startTime ?? ''}`.trim();
  const durationMinutes = Number(req.body?.durationMinutes ?? NaN);
  const appointmentTypeName = `${req.body?.appointmentTypeName ?? ''}`.trim();
  const customerName = `${req.body?.customerName ?? ''}`.trim();
  const customerPhone = `${req.body?.customerPhone ?? ''}`.trim();
  const customerEmail = `${req.body?.customerEmail ?? ''}`.trim().toLowerCase();

  if (!reservationId) {
    return res.status(400).json({ ok: false, error: 'ID de reserva inválido.' });
  }

  if (
    !dateIso ||
    !startTime ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0 ||
    !appointmentTypeName ||
    !customerName ||
    !customerPhone ||
    !customerEmail
  ) {
    return res.status(400).json({ ok: false, error: 'Faltan datos para modificar la reserva.' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    return res.status(400).json({ ok: false, error: 'Fecha inválida. Usa formato YYYY-MM-DD.' });
  }

  if (!/^\d{2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ ok: false, error: 'Hora inválida. Usa formato HH:mm.' });
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) {
    return res.status(400).json({ ok: false, error: 'Email de cliente inválido.' });
  }

  try {
    const updated = await updateReservationByAdmin(
      reservationId,
      {
        dateIso,
        startTime,
        durationMinutes,
        appointmentTypeName,
        customerName,
        customerPhone,
        customerEmail,
      },
      {
        allowClosedSchedule: superadminSession.isSuperadmin,
      },
    );

    if (!updated.ok) {
      if (updated.reason === 'not-found') {
        return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
      }

      if (updated.reason === 'invalid-time') {
        return res.status(400).json({
          ok: false,
          error:
            'Horario inválido. Usa tramos de 30 min en horario de servicio: martes a viernes 10:00-18:00, sábados 09:00-13:00 y cierre de 14:00 a 15:00.',
        });
      }

      if (updated.reason === 'blocked-conflict') {
        return res.status(409).json({
          ok: false,
          error: 'No se puede mover la cita porque ese tramo está bloqueado.',
        });
      }

      return res.status(409).json({
        ok: false,
        error: 'No se puede mover la cita porque hay conflicto con otra reserva.',
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error modificando reserva admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo modificar la reserva.' });
  }
});

app.post('/api/admin/reservas', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);
  const superadminSession = isSuperadminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const dateIso = `${req.body?.dateIso ?? ''}`.trim();
  const time = `${req.body?.time ?? ''}`.trim();
  const durationMinutes = Number(req.body?.durationMinutes ?? NaN);
  const appointmentTypeName = `${req.body?.appointmentTypeName ?? ''}`.trim();
  const customerName = `${req.body?.customerName ?? ''}`.trim();
  const customerPhone = `${req.body?.customerPhone ?? ''}`.trim();
  const customerEmail = `${req.body?.customerEmail ?? ''}`.trim().toLowerCase();
  const requiresReservationSignal = Boolean(req.body?.requiresReservationSignal);

  if (
    !dateIso ||
    !time ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0 ||
    !appointmentTypeName ||
    !customerName ||
    !customerPhone ||
    !customerEmail
  ) {
    return res.status(400).json({ ok: false, error: 'Faltan datos para crear la reserva.' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    return res.status(400).json({ ok: false, error: 'Fecha inválida. Usa formato YYYY-MM-DD.' });
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ ok: false, error: 'Hora inválida. Usa formato HH:mm.' });
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) {
    return res.status(400).json({ ok: false, error: 'Email de cliente inválido.' });
  }

  try {
    const created = await createReservationWithSlots(
      {
        dateIso,
        time,
        durationMinutes,
        customerEmail,
        customerName,
        customerPhone,
        appointmentTypeName,
        requiresReservationSignal,
      },
      {
        allowClosedSchedule: superadminSession.isSuperadmin,
      },
    );

    if (!created.ok) {
      return res.status(409).json({
        ok: false,
        error: superadminSession.isSuperadmin
          ? 'No se pudo crear la reserva porque ya existe un conflicto con otra cita o bloqueo manual.'
          : 'No se pudo crear la reserva porque ese horario está cerrado o ya no está disponible.',
      });
    }

    return res.status(200).json({ ok: true, reservationId: created.reservationId });
  } catch (error) {
    console.error('Error creando reserva manual admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo crear la reserva.' });
  }
});

app.patch('/api/admin/reservas/:id/status', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const reservationId = `${req.params['id'] ?? ''}`;
  const status = `${req.body?.status ?? ''}` as AdminReservationStatus;
  const validStatuses: AdminReservationStatus[] = ['accepted', 'rejected'];

  if (!reservationId || !validStatuses.includes(status)) {
    return res.status(400).json({
      ok: false,
      error: 'Parámetros inválidos. Estado permitido: accepted o rejected.',
    });
  }

  try {
    const reservations = await listReservationsForAdmin();
    const reservation = reservations.find((item) => item.id === reservationId);

    if (!reservation) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    const updated = await updateReservationAdminStatus(reservationId, status);

    if (!updated.ok) {
      if (updated.reason === 'payment-required') {
        return res.status(409).json({
          ok: false,
          error: 'No puedes aceptar la reserva sin marcar pago recibido.',
        });
      }

      if (updated.reason === 'slot-conflict') {
        return res.status(409).json({
          ok: false,
          error: 'Ese hueco ya ha sido ocupado por otra reserva.',
        });
      }

      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    // Crear notificaciones según el nuevo estado
    if (status === 'accepted') {
      try {
        await createNotification({
          type: 'reserva_confirmada',
          title: `Reserva confirmada: ${reservation.appointmentTypeName}`,
          message: `Reserva de ${reservation.customerName} confirmada para ${reservation.dateIso} a las ${reservation.startTime}`,
          relatedId: reservationId,
          actionUrl: `/admin/reservas?id=${reservationId}`,
        });
      } catch (notifError) {
        console.error('Error creating confirmation notification:', notifError);
      }
    } else if (status === 'rejected') {
      try {
        await createNotification({
          type: 'cancelacion_reserva',
          title: `Reserva cancelada: ${reservation.appointmentTypeName}`,
          message: `Reserva de ${reservation.customerName} para ${reservation.dateIso} a las ${reservation.startTime} ha sido cancelada`,
          relatedId: reservationId,
          actionUrl: `/admin/reservas?id=${reservationId}`,
        });
      } catch (notifError) {
        console.error('Error creating cancellation notification:', notifError);
      }

      await notifyRejectedReservation({
        customerEmail: reservation.customerEmail,
        customerName: reservation.customerName,
        appointmentTypeName: reservation.appointmentTypeName,
        dateIso: reservation.dateIso,
        startTime: reservation.startTime,
      });

      await notifyFreedSlotAlerts({
        dateIso: reservation.dateIso,
        startTime: reservation.startTime,
        endTime: reservation.endTime,
        appointmentTypeName: reservation.appointmentTypeName,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error actualizando estado de reserva:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo actualizar el estado.' });
  }
});

app.delete('/api/admin/reservas/:id', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const reservationId = `${req.params['id'] ?? ''}`;

  if (!reservationId) {
    return res.status(400).json({ ok: false, error: 'ID de reserva inválido.' });
  }

  try {
    const reservations = await listReservationsForAdmin();
    const reservation = reservations.find((item) => item.id === reservationId);

    if (!reservation) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    await deleteReservationById(reservationId);

    await notifyFreedSlotAlerts({
      dateIso: reservation.dateIso,
      startTime: reservation.startTime,
      endTime: reservation.endTime,
      appointmentTypeName: reservation.appointmentTypeName,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error eliminando reserva:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo eliminar la reserva.' });
  }
});

app.post('/api/admin/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearAuthCookies());

  return res.status(200).json({ ok: true });
});

app.get('/api/reservas/disponibilidad', async (req, res) => {
  const dateIso = `${req.query['dateIso'] ?? ''}`;
  const durationMinutes = Number(req.query['durationMinutes']);

  if (!dateIso || Number.isNaN(durationMinutes)) {
    return res.status(400).json({
      ok: false,
      error: 'Parámetros inválidos para disponibilidad.',
    });
  }

  try {
    const slots = await getAvailableSlotsForDate(dateIso, durationMinutes);

    return res.status(200).json({
      ok: true,
      slots,
    });
  } catch (error) {
    console.error('Error consultando disponibilidad:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo consultar la disponibilidad.',
    });
  }
});

app.get('/api/reservas/confirmacion', async (req, res) => {
  const token = `${req.query['token'] ?? ''}`.trim();
  const parsed = verifyReservationConfirmationToken(token);

  if (!parsed) {
    return res
      .status(400)
      .send(
        buildReservationDecisionResultHtml(
          'Enlace no válido',
          'El enlace de confirmación ha caducado o no es correcto. Si lo necesitas, contacta con el salón.',
          'danger',
        ),
      );
  }

  try {
    const reservation = await getReservationByIdForAdmin(parsed.reservationId);

    if (!reservation) {
      return res
        .status(404)
        .send(
          buildReservationDecisionResultHtml(
            'Cita no disponible',
            'Esta cita ya no está en agenda o ya fue gestionada previamente.',
            'neutral',
          ),
        );
    }

    if (parsed.action === 'confirm') {
      if (reservation.adminStatus === 'rejected') {
        return res
          .status(409)
          .send(
            buildReservationDecisionResultHtml(
              'Cita no confirmable',
              'Esta cita fue rechazada anteriormente y ya no está disponible.',
              'danger',
            ),
          );
      }

      if (reservation.clientConfirmationStatus === 'confirmed') {
        return res
          .status(200)
          .send(
            buildReservationDecisionResultHtml(
              'Cita ya confirmada',
              'Tu cita ya estaba confirmada. Te esperamos en Arena Hair Studio.',
              'success',
            ),
          );
      }

      const updated = await updateReservationClientConfirmationStatus(reservation.id, 'confirmed');

      if (!updated.ok) {
        return res
          .status(404)
          .send(
            buildReservationDecisionResultHtml(
              'Cita no disponible',
              'No se ha podido confirmar porque la cita ya no existe en agenda.',
              'danger',
            ),
          );
      }

      return res
        .status(200)
        .send(
          buildReservationDecisionResultHtml(
            'Cita confirmada',
            'Tu cita ha quedado confirmada correctamente. Gracias por confirmarla.',
            'success',
          ),
        );
    }

    const deletedReservation = {
      dateIso: reservation.dateIso,
      startTime: reservation.startTime,
      endTime: reservation.endTime,
      appointmentTypeName: reservation.appointmentTypeName,
    };

    await deleteReservationById(reservation.id);
    await notifyFreedSlotAlerts(deletedReservation);

    try {
      await createNotification({
        type: 'cancelacion_reserva',
        title: `Cita rechazada por clienta: ${reservation.appointmentTypeName}`,
        message: `${reservation.customerName} rechazó su cita del ${reservation.dateIso} a las ${reservation.startTime}.`,
        relatedId: reservation.id,
        actionUrl: `/admin/reservas?id=${reservation.id}`,
      });
    } catch (notifError) {
      console.error('Error creando notificación tras rechazo de clienta:', notifError);
    }

    return res
      .status(200)
      .send(
        buildReservationDecisionResultHtml(
          'Cita rechazada',
          'Tu cita se ha eliminado de la agenda. Si quieres, puedes volver a reservar desde la web.',
          'danger',
        ),
      );
  } catch (error) {
    console.error('Error procesando confirmación/rechazo de cita:', error);
    return res
      .status(500)
      .send(
        buildReservationDecisionResultHtml(
          'No se pudo procesar',
          'Ha ocurrido un error al procesar la acción. Inténtalo de nuevo o contacta con el salón.',
          'danger',
        ),
      );
  }
});

app.post('/api/reservas/email', async (req, res) => {
  const apiKey = process.env['RESEND_API_KEY'];

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: 'RESEND_API_KEY no configurada en el servidor.',
    });
  }

  if (apiKey.includes('xxxxxxxx')) {
    return res.status(500).json({
      ok: false,
      error: 'RESEND_API_KEY tiene un valor de ejemplo. Configura la key real de Resend.',
    });
  }

  const fromEmail = process.env['RESEND_FROM_EMAIL'] ?? 'onboarding@resend.dev';
  const isValidEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail);

  if (fromEmail === 'reservas@tu-dominio.com') {
    return res.status(500).json({
      ok: false,
      error: 'RESEND_FROM_EMAIL tiene un valor de ejemplo. Usa un remitente verificado en Resend.',
    });
  }

  if (!isValidEmail) {
    return res.status(500).json({
      ok: false,
      error:
        'RESEND_FROM_EMAIL no es válido. Debe ser un email real verificado en Resend (por ejemplo, reservas@tu-dominio.com).',
    });
  }

  const {
    customerEmail,
    customerName,
    customerPhone,
    appointmentTypeName,
    requiresReservationSignal,
    dateIso,
    time,
    durationMinutes,
    establishmentAddress,
    establishmentPhone,
    observaciones,
  } = req.body ?? {};

  if (
    !customerEmail ||
    !customerName ||
    !customerPhone ||
    !appointmentTypeName ||
    !dateIso ||
    !time ||
    !durationMinutes
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan datos obligatorios para enviar el email.',
    });
  }

  let reservationId = '';
  const provisionalHoldHours =
    Boolean(requiresReservationSignal) ||
    requiresReservationSignalByName(`${appointmentTypeName ?? ''}`)
      ? getProvisionalReservationHoursByName(`${appointmentTypeName ?? ''}`) || 48
      : 0;

  try {
    const created = await createReservationWithSlots({
      dateIso,
      time,
      durationMinutes: Number(durationMinutes),
      customerEmail,
      customerName,
      customerPhone,
      appointmentTypeName,
      requiresReservationSignal: Boolean(requiresReservationSignal),
    });

    if (!created.ok) {
      return res.status(409).json({
        ok: false,
        error: 'Esa hora ya no está disponible. Elige otra.',
      });
    }

    reservationId = created.reservationId;

    // Crear notificación para el admin
    const notificationMessage = `Nueva reserva de ${customerName} (${customerPhone}) para ${appointmentTypeName} el ${dateIso} a las ${time}`;
    const notificationActionUrl = `/admin/reservas?id=${reservationId}`;

    try {
      await createNotification({
        type: 'nueva_reserva',
        title: `Nueva reserva: ${appointmentTypeName}`,
        message: notificationMessage,
        relatedId: reservationId,
        actionUrl: notificationActionUrl,
      });
    } catch (notifError) {
      console.error('Error creating notification:', notifError);
      // No lanzar error si falla la notificación
    }

    const subject = `Confirmación de cita - ${appointmentTypeName} (${dateIso} ${time})`;
    const html = buildReservationEmailHtml({
      customerName,
      customerPhone,
      appointmentTypeName,
      provisionalHoldHours,
      dateIso,
      time,
      establishmentAddress,
      establishmentPhone,
      observaciones: typeof observaciones === 'string' ? observaciones : undefined,
    });

    const resend = new Resend(apiKey);
    const customerEmailTarget = resolveEmailRecipient(customerEmail);
    const sendResult = await resend.emails.send({
      from: fromEmail,
      to: customerEmailTarget,
      subject,
      html,
    });

    if (sendResult.error) {
      throw new Error(sendResult.error.message || 'Resend rechazó el envío del email.');
    }

    // Buscar alertas para este slot y notificar a clientes
    try {
      const alerts = await getAlertsForSlot(dateIso, time);
      const resend = new Resend(apiKey);

      for (const alert of alerts) {
        // Marcar la alerta como completada
        await updateAlertStatus(alert.id, 'completed');

        // Enviar email al cliente que solicitó la alerta
        const alertHtml = buildAlertCoveredEmailHtml({
          customerName: 'Cliente',
          appointmentTypeName: alert.appointmentTypeName,
          dateIso: alert.dateIso,
          startTime: alert.startTime,
        });

        const emailTarget = resolveEmailRecipient(alert.clientEmail);

        await resend.emails.send({
          from: fromEmail,
          to: emailTarget,
          subject: `Notificación: Hueco completado - ${alert.appointmentTypeName} (${dateIso} ${time})`,
          html: alertHtml,
        });
      }
    } catch (alertError) {
      // No lanzar error si algo falla con las alertas, solo loguear
      console.error('Error procesando alertas:', alertError);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (reservationId) {
      await deleteReservationById(reservationId);
    }

    console.error('Error enviando email con Resend:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'No se pudo enviar el email con Resend.';

    return res.status(500).json({
      ok: false,
      error: errorMessage,
    });
  }
});

app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

const initializeFromDb = async (): Promise<void> => {
  let dbUsersCount = 0;
  let dbCardsCount = 0;

  try {
    const [dbUsers, dbCards] = await Promise.all([
      loadAllUsersFromDb(),
      loadAllClientCardsFromDb(),
    ]);

    dbUsersCount = dbUsers.length;
    dbCardsCount = dbCards.length;

    for (const dbUser of dbUsers) {
      const user: AppUser = {
        id: dbUser.id,
        email: dbUser.email,
        username: dbUser.username,
        usernameLower: dbUser.usernameLower,
        passwordHash: dbUser.passwordHash,
        role: dbUser.role as AppUserRole,
        createdAtIso: dbUser.createdAtIso,
        tracking: normalizeTrackingInfo(dbUser.tracking as EmployeeTrackingInfo | undefined),
      };
      usersByEmail.set(user.email, user);
      usersByUsername.set(user.usernameLower, user);
    }

    for (const dbCard of dbCards) {
      const card: ClientCardItem = {
        id: dbCard.id,
        fullName: dbCard.fullName,
        email: dbCard.email,
        phone: dbCard.phone,
        birthDateIso: dbCard.birthDateIso,
        notes: dbCard.notes,
        createdAtIso: dbCard.createdAtIso,
        createdByEmail: dbCard.createdByEmail,
        treatments: (dbCard.treatments as ClientTreatmentItem[]) ?? [],
        passwordHash: dbCard.passwordHash,
      };
      clientCardsById.set(card.id, normalizeClientCard(card));
    }

    if (dbUsers.length > 0 || dbCards.length > 0) {
      console.log(
        `DB: ${dbUsers.length} usuario(s) y ${dbCards.length} ficha(s) de cliente cargados.`,
      );
    }
  } catch (error) {
    console.warn('No se pudo cargar datos desde DB en arranque. Modo memoria activo.', error);
  }

  const diskUsers = await loadUsersFromDisk();
  const diskCards = await loadClientCardsFromDisk();
  const diskStockProducts = await loadStockProductsFromDisk();
  const diskCierres = await loadCierreCajaFromDisk();
  const diskDailyPayments = await loadDailyPaymentsFromDisk();

  for (const user of diskUsers) {
    if (!usersByEmail.has(user.email)) {
      usersByEmail.set(user.email, user);
      usersByUsername.set(user.usernameLower, user);
    }
  }

  for (const card of diskCards) {
    if (!clientCardsById.has(card.id)) {
      clientCardsById.set(card.id, normalizeClientCard(card));
    }
  }

  for (const product of diskStockProducts) {
    if (!stockProductsById.has(product.id)) {
      stockProductsById.set(product.id, normalizeStockProduct(product));
    }
  }

  for (const cierre of diskCierres) {
    if (!cierreCajaById.has(cierre.id)) {
      cierreCajaById.set(cierre.id, normalizeCierre(cierre));
    }
  }

  for (const dailyPayment of diskDailyPayments) {
    if (!dailyPaymentsByDateIso.has(dailyPayment.dateIso)) {
      dailyPaymentsByDateIso.set(dailyPayment.dateIso, normalizeDailyPaymentSummary(dailyPayment));
    }
  }

  if (
    diskUsers.length > 0 ||
    diskCards.length > 0 ||
    diskStockProducts.length > 0 ||
    diskCierres.length > 0 ||
    diskDailyPayments.length > 0
  ) {
    console.log(
      `DISK: ${diskUsers.length} usuario(s), ${diskCards.length} ficha(s) de cliente, ${diskStockProducts.length} producto(s) de almacén, ${diskCierres.length} cierre(s) y ${diskDailyPayments.length} acumulado(s) diario(s) de cobros cargados.`,
    );
  }

  syncAdminOwnerEmailFromUsers();

  if (dbUsersCount === 0 && usersByEmail.size > 0) {
    void persistUsersToDisk();
  }

  if (dbCardsCount === 0 && clientCardsById.size > 0) {
    void persistClientCardsToDisk();
  }

  if (stockProductsById.size > 0) {
    void persistStockProductsToDisk();
  }

  if (cierreCajaById.size > 0) {
    void persistCierreCajaToDisk();
  }

  if (dailyPaymentsByDateIso.size > 0) {
    void persistDailyPaymentsToDisk();
  }
};

// ============================================================================
// API Endpoints: Notificaciones (Solo para admin/superadmin)
// ============================================================================

/**
 * GET /api/notifications - Obtiene todas las notificaciones
 */
app.get('/api/notifications', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  try {
    const notifications = await getAllNotifications();
    return res.status(200).json({ ok: true, notifications });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return res.status(500).json({ ok: false, error: 'Error al obtener notificaciones.' });
  }
});

/**
 * POST /api/notifications - Crea una nueva notificación
 */
app.post('/api/notifications', async (req, res) => {
  // Este endpoint generalmente será llamado internamente desde el servidor
  // pero podemos permitirlo para admin también
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const { type, title, message, relatedId, actionUrl } = req.body ?? {};

  if (!type || !title || !message) {
    return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios.' });
  }

  try {
    const notification = await createNotification({
      type,
      title,
      message,
      relatedId,
      actionUrl,
    });
    return res.status(201).json({ ok: true, notification });
  } catch (error) {
    console.error('Error creating notification:', error);
    return res.status(500).json({ ok: false, error: 'Error al crear notificación.' });
  }
});

/**
 * PATCH /api/notifications/:id/read - Marca una notificación como leída
 */
app.patch('/api/notifications/:id/read', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const notificationId = req.params['id'] ?? '';

  if (!notificationId) {
    return res.status(400).json({ ok: false, error: 'ID de notificación inválido.' });
  }

  try {
    await markNotificationAsRead(notificationId);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    return res.status(500).json({ ok: false, error: 'Error al marcar como leído.' });
  }
});

/**
 * PATCH /api/notifications/read-all - Marca todas las notificaciones como leídas
 */
app.patch('/api/notifications/read-all', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  try {
    await markAllNotificationsAsRead();
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    return res.status(500).json({ ok: false, error: 'Error al marcar como leído.' });
  }
});

/**
 * DELETE /api/notifications/:id - Elimina una notificación
 */
app.delete('/api/notifications/:id', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const notificationId = req.params['id'] ?? '';

  if (!notificationId) {
    return res.status(400).json({ ok: false, error: 'ID de notificación inválido.' });
  }

  try {
    await deleteNotification(notificationId);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error deleting notification:', error);
    return res.status(500).json({ ok: false, error: 'Error al eliminar notificación.' });
  }
});

/**
 * DELETE /api/notifications/clear-read - Elimina todas las notificaciones leídas
 */
app.delete('/api/notifications/clear-read', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  try {
    await clearReadNotifications();
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error clearing read notifications:', error);
    return res.status(500).json({ ok: false, error: 'Error al limpiar notificaciones.' });
  }
});

const startReservationReminderScheduler = (): void => {
  const run = async (): Promise<void> => {
    try {
      const reservations = await listReservationsForAdmin();
      await dispatch48hReservationReminders(reservations);
    } catch (error) {
      console.error('Error ejecutando scheduler de recordatorios 48h:', error);
    }
  };

  void run();
  setInterval(
    () => {
      void run();
    },
    15 * 60 * 1000,
  );
};

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  initializeFromDb()
    .catch((error) => console.error('Error en inicialización desde DB:', error))
    .finally(() => {
      seedAuthUsers();
      startReservationReminderScheduler();
      app.listen(port, (error) => {
        if (error) {
          throw error;
        }

        console.log(`Node Express server listening on http://localhost:${port}`);
      });
    });
}

export const reqHandler = createNodeRequestHandler(app);
