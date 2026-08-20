import 'dotenv/config';
import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express, { type Response } from 'express';

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
  deleteClientCardFromDb,
  deleteCierreCajaFromDb,
  deleteBlockedPeriodForAdmin,
  deleteReservationById,
  deleteStockProductFromDb,
  deleteUserFromDb,
  getDatabasePoolForIntegrations,
  getAvailableSlotsForDate,
  listBlockedPeriodsForAdmin,
  loadAllCierresFromDb,
  listReservationsForAdmin,
  getReservationByIdForAdmin,
  loadAllClientCardsFromDb,
  loadAllDailyPaymentsFromDb,
  loadAllStockProductsFromDb,
  loadAllUsersFromDb,
  markReservationClientReminderSentAt,
  saveCierreCajaToDb,
  saveClientCardToDb,
  saveDailyPaymentToDb,
  saveStockProductToDb,
  saveUserToDb,
  assignReservationToWorker,
  updateReservationAdminStatus,
  updateReservationClientConfirmationStatus,
  updateReservationPaymentReceived,
  registerReservationSignalPayment,
  createAlert,
  getAllAlerts,
  getAlertById,
  getAlertsByClientEmail,
  getAlertsForSlot,
  updateAlertStatus,
  updateAlertApprovalStatus,
  deleteAlert,
  updateReservationByAdmin,
  updateReservationDetailsByAdmin,
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
const serverStartedAtIso = new Date().toISOString();
let notificationsDegradedMode = false;
const notificationStreamClients = new Set<Response>();

const broadcastNotificationsRefresh = (): void => {
  const payload = `data: ${JSON.stringify({ updatedAtIso: new Date().toISOString() })}\n\n`;

  Array.from(notificationStreamClients).forEach((client) => {
    if (client.writableEnded || client.destroyed) {
      notificationStreamClients.delete(client);
      return;
    }

    try {
      client.write(payload);
    } catch {
      notificationStreamClients.delete(client);
    }
  });
};

const createNotificationAndBroadcast = async (
  payload: Parameters<typeof createNotification>[0],
): Promise<Awaited<ReturnType<typeof createNotification>>> => {
  const notification = await createNotification(payload);
  broadcastNotificationsRefresh();
  return notification;
};

const triggerLowStockNotificationIfNeeded = async (
  product: Pick<StockProductItem, 'id' | 'productName' | 'quantity'>,
  previousQuantity: number,
): Promise<void> => {
  if (product.quantity > 3 || previousQuantity <= 3) {
    return;
  }

  const message = `Atención quedan pocas unidades de ${product.productName} en el almacén`;
  const notifications = await getAllNotifications();
  const duplicateExists = notifications.some(
    (notification) =>
      notification.message === message ||
      (notification.relatedId === product.id &&
        notification.message.includes('quedan pocas unidades de') &&
        notification.message.includes(product.productName)),
  );

  if (duplicateExists) {
    return;
  }

  await createNotificationAndBroadcast({
    type: 'aviso_importante',
    title: 'Atención',
    message,
    relatedId: product.id,
    actionUrl: '/admin-panel?tab=almacen',
  });
};

const extractHostname = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).hostname;
  } catch {
    // Allows plain hostnames coming from env vars.
    return trimmed.replace(/^https?:\/\//i, '').split('/')[0] || null;
  }
};

const envHosts = [
  ...(process.env['NG_ALLOWED_HOSTS']
    ?.split(',')
    .map((host) => host.trim())
    .filter(Boolean) ?? []),
  extractHostname(process.env['APP_BASE_URL']),
  extractHostname(process.env['RENDER_EXTERNAL_URL']),
  process.env['RENDER_EXTERNAL_HOSTNAME']?.trim() || null,
].filter((host): host is string => Boolean(host));

const allowedHosts = ['localhost', '127.0.0.1', '::1', ...new Set(envHosts)];
const angularApp = new AngularNodeAppEngine({ allowedHosts });

const getDatabaseTargetLabel = (): string => {
  const connectionString = process.env['DATABASE_URL']?.trim();

  if (!connectionString) {
    return 'DATABASE_URL:no-definida';
  }

  try {
    const parsed = new URL(connectionString);
    const dbName = parsed.pathname.replace(/^\//, '') || '(sin-db)';
    const user = parsed.username || '(sin-usuario)';
    return `${parsed.hostname}/${dbName} user=${user}`;
  } catch {
    return 'DATABASE_URL:formato-invalido';
  }
};

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

const isLocalHostname = (hostname: string): boolean => {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.endsWith('.local')
  );
};

const normalizeBaseUrl = (value: string | undefined | null): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    try {
      if (/^[a-z0-9.-]+(?::\d+)?$/i.test(trimmed)) {
        const protocol = isLocalHostname(trimmed.split(':')[0] ?? '') ? 'http' : 'https';
        return new URL(`${protocol}://${trimmed}`).origin;
      }
    } catch {
      return null;
    }
  }

  return null;
};

const getPublicAppBaseUrl = (): string => {
  const candidates = [
    process.env['APP_BASE_URL'],
    process.env['PUBLIC_APP_URL'],
    process.env['RENDER_EXTERNAL_URL'],
    process.env['RENDER_EXTERNAL_HOSTNAME'],
    process.env['VERCEL_URL'],
    process.env['URL'],
  ]
    .map((value) => normalizeBaseUrl(value))
    .filter((value): value is string => Boolean(value));

  if (candidates.length > 0) {
    const nonLocalCandidate = candidates.find((candidate) => {
      try {
        return !isLocalHostname(new URL(candidate).hostname);
      } catch {
        return false;
      }
    });

    if (nonLocalCandidate) {
      return nonLocalCandidate;
    }

    return candidates[0];
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
    const recipientEmail = reservation.customerEmail.trim().toLowerCase();

    if (!apiKey || !recipientEmail) {
      return;
    }

    const resend = new Resend(apiKey);
    const websiteUrl = 'https://www.www.arenahairstudio.com/reservas';
    const html = buildReservationRejectedEmailHtml({
      customerName: reservation.customerName,
      appointmentTypeName: reservation.appointmentTypeName,
      dateIso: reservation.dateIso,
      startTime: reservation.startTime,
      establishmentPhone: '919521611',
      websiteUrl,
    });

    const sendResult = await resend.emails.send({
      from: fromEmail,
      to: resolveEmailRecipient(recipientEmail),
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

async function notifyAcceptedReservation(reservation: {
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  appointmentTypeName: string;
  dateIso: string;
  startTime: string;
}): Promise<void> {
  try {
    const apiKey = process.env['RESEND_API_KEY'];
    const fromEmail = process.env['RESEND_FROM_EMAIL'] ?? 'onboarding@resend.dev';
    const recipientEmail = reservation.customerEmail.trim().toLowerCase();

    if (!apiKey || !recipientEmail) {
      return;
    }

    const resend = new Resend(apiKey);
    const html = buildReservationEmailHtml({
      customerName: reservation.customerName,
      appointmentTypeName: reservation.appointmentTypeName,
      provisionalHoldHours: 0,
      dateIso: reservation.dateIso,
      time: reservation.startTime,
      establishmentAddress: 'C. de Castilla, 4, 28320 Pinto, Madrid',
      establishmentPhone: '919521611',
      bizumPhone: '614716238',
    });

    const sendResult = await resend.emails.send({
      from: fromEmail,
      to: resolveEmailRecipient(recipientEmail),
      subject: `Reserva confirmada - ${reservation.appointmentTypeName} (${reservation.dateIso} ${reservation.startTime})`,
      html,
    });

    if (sendResult.error) {
      throw new Error(
        sendResult.error.message || 'Resend rechazó el envío del email de confirmación.',
      );
    }
  } catch (error) {
    console.error('Error enviando email de reserva confirmada:', error);
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
  const normalizedStartTime = normalizeReservationStartTimeForComparison(startTime);
  const value = new Date(`${dateIso}T${normalizedStartTime}:00`).getTime();
  return Number.isNaN(value) ? null : value;
};

const parseReservationClockToMinutes = (timeValue: string): number | null => {
  const normalized = `${timeValue ?? ''}`.trim();
  const match = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
};

const formatMinutesToReservationClock = (totalMinutes: number): string => {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.floor(totalMinutes)));
  const hours = Math.floor(clamped / 60)
    .toString()
    .padStart(2, '0');
  const minutes = (clamped % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}`;
};

const normalizeReservationStartTimeForComparison = (timeValue: string): string => {
  const minutes = parseReservationClockToMinutes(timeValue);

  if (minutes === null) {
    return `${timeValue ?? ''}`.trim();
  }

  return formatMinutesToReservationClock(minutes);
};

const normalizeReservationStartTimeToSlot = (timeValue: string): string => {
  const minutes = parseReservationClockToMinutes(timeValue);

  if (minutes === null) {
    return `${timeValue ?? ''}`.trim();
  }

  const rounded = Math.round(minutes / 30) * 30;
  return formatMinutesToReservationClock(rounded);
};

const normalizeReservationDurationToSlot = (durationMinutes: number): number => {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return 30;
  }

  const rounded = Math.round(durationMinutes / 30) * 30;
  return Math.max(30, rounded);
};

const getDurationFromTimeRange = (startTime: string, endTime: string): number | null => {
  const startMinutes = parseReservationClockToMinutes(startTime);
  const endMinutes = parseReservationClockToMinutes(endTime);

  if (startMinutes === null || endMinutes === null) {
    return null;
  }

  const difference = endMinutes - startMinutes;

  if (!Number.isFinite(difference) || difference <= 0) {
    return null;
  }

  return difference;
};

const tryNormalizeLegacyReservationSchedule = async (
  reservation: {
    id: string;
    dateIso: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
  },
  payload: {
    appointmentTypeName: string;
    customerName: string;
    customerPhone: string;
    customerEmail: string;
    additionalComments?: string;
  },
  options: {
    allowClosedSchedule: boolean;
    maxConcurrentReservations: number;
  },
): Promise<void> => {
  const comparableStartTime = normalizeReservationStartTimeForComparison(reservation.startTime);
  const normalizedStartTime = normalizeReservationStartTimeToSlot(comparableStartTime);
  const durationFromRange = getDurationFromTimeRange(reservation.startTime, reservation.endTime);
  const effectiveDurationMinutes = durationFromRange ?? reservation.durationMinutes;
  const normalizedDurationMinutes = normalizeReservationDurationToSlot(effectiveDurationMinutes);
  const needsNormalization =
    reservation.startTime !== comparableStartTime ||
    comparableStartTime !== normalizedStartTime ||
    reservation.durationMinutes !== effectiveDurationMinutes ||
    effectiveDurationMinutes !== normalizedDurationMinutes;

  if (!needsNormalization) {
    return;
  }

  try {
    await updateReservationByAdmin(
      reservation.id,
      {
        dateIso: reservation.dateIso,
        startTime: normalizedStartTime,
        durationMinutes: normalizedDurationMinutes,
        appointmentTypeName: payload.appointmentTypeName,
        customerName: payload.customerName,
        customerPhone: payload.customerPhone,
        customerEmail: payload.customerEmail,
        additionalComments: payload.additionalComments,
      },
      options,
    );
  } catch (error) {
    console.warn('No se pudo normalizar horario legacy de reserva:', reservation.id, error);
  }
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
  | 'citas_asignar'
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
  'citas_asignar',
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
  operationDetails: PaymentOperationDetail[];
}

interface PaymentOperationDetail {
  id: string;
  operationType: 'stock_sale' | 'client_pack_payment' | 'reservation_payment';
  concept: string;
  amount: number;
  paymentMethod: 'efectivo' | 'tarjeta' | 'bizum';
  performedByEmail: string;
  createdAtIso: string;
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

interface ReservationServiceMetaItem {
  id: string;
  type: 'pack' | 'treatment';
  name: string;
  quantity: number;
  durationMinutes: number;
  unitPriceEuro: number;
  requiresReservationSignal: boolean;
}

interface ReservationStockMetaItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPriceEuro: number;
}

interface ReservationMetaPayload {
  version: 1;
  linkedClientId?: string;
  services: ReservationServiceMetaItem[];
  stock: ReservationStockMetaItem[];
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
  operationDetails: PaymentOperationDetail[];
}

const usersByEmail = new Map<string, AppUser>();
const usersByUsername = new Map<string, AppUser>();
const clientCardsById = new Map<string, ClientCardItem>();
const stockProductsById = new Map<string, StockProductItem>();
const stockSalesById = new Map<string, StockSaleHistoryItem>();
const cierreCajaById = new Map<string, CierreCajaItem>();
const dailyPaymentsByDateIso = new Map<string, DailyPaymentSummaryItem>();
const clientRecoveryTokens = new Map<string, { email: string; expiresAt: number }>();
let authSeeded = false;
const maxEmployeeTrackingHistoryItems = 180;
const runtimeDataDir = join(process.cwd(), '.runtime-data');
const usersBackupFilePath = join(runtimeDataDir, 'users.json');
const clientCardsBackupFilePath = join(runtimeDataDir, 'client-cards.json');
const stockProductsBackupFilePath = join(runtimeDataDir, 'stock-products.json');
const stockSalesBackupFilePath = join(runtimeDataDir, 'stock-sales.json');
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
  appointmentTypeName: string;
  provisionalHoldHours?: number;
  dateIso: string;
  time: string;
  establishmentAddress: string;
  establishmentPhone: string;
  bizumPhone: string;
  observaciones?: string;
}): string => {
  const customerName = escapeHtml(data.customerName);
  const appointmentTypeName = escapeHtml(data.appointmentTypeName);
  const dateIso = escapeHtml(data.dateIso);
  const time = escapeHtml(data.time);
  const establishmentAddress = escapeHtml(data.establishmentAddress);
  const establishmentPhone = escapeHtml(data.establishmentPhone);
  const bizumPhone = escapeHtml(data.bizumPhone);
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
                <td style="padding:14px 16px;font-size:14px;"><strong>Teléfono de contacto</strong><br><span style="color:#7a675d;">${establishmentPhone}</span></td>
              </tr>
              ${observacionesRow}
            </table>

            <h2 style="margin:0 0 10px;font-size:16px;color:#3b2f2a;">Datos del establecimiento</h2>
            <p style="margin:0 0 4px;font-size:14px;line-height:1.5;color:#7a675d;"><strong>Dirección:</strong> ${establishmentAddress}</p>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#7a675d;"><strong>Teléfono:</strong> ${establishmentPhone}</p>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#7a675d;"><strong>Bizum:</strong> ${bizumPhone}</p>

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
  establishmentPhone: string;
  websiteUrl: string;
}): string => {
  const customerName = escapeHtml(data.customerName);
  const appointmentTypeName = escapeHtml(data.appointmentTypeName);
  const dateIso = escapeHtml(data.dateIso);
  const startTime = escapeHtml(data.startTime);
  const establishmentPhone = escapeHtml(data.establishmentPhone);
  const websiteUrl = escapeHtml(data.websiteUrl);

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
           <p style="margin:0;font-size:14px;line-height:1.6;color:#7a675d;">Ponte en contacto con nosotros si quieres saber más información.</p>
            <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#7a675d;"><strong>Teléfono de contacto:</strong> ${establishmentPhone}</p>
            <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#7a675d;"><strong>Web:</strong> <a href="${websiteUrl}" style="color:#b86a6a;text-decoration:underline;">${websiteUrl}</a></p>
            
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
const buildStockSaleId = (): string =>
  `stock-sale-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

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

const isFutureBirthDateIso = (value: unknown): boolean => {
  const raw = `${value ?? ''}`.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return false;
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  return raw > todayIso;
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

const normalizeStockSale = (sale: StockSaleHistoryItem): StockSaleHistoryItem => {
  const soldUnits = Number.isFinite(sale.soldUnits) ? Math.max(1, Math.floor(sale.soldUnits)) : 1;
  const unitPrice = Number.isFinite(sale.unitPrice) ? Math.max(0, sale.unitPrice) : 0;
  const totalAmount = Number.isFinite(sale.totalAmount)
    ? Math.max(0, sale.totalAmount)
    : unitPrice * soldUnits;

  return {
    ...sale,
    productId: `${sale.productId ?? ''}`.trim(),
    productName: `${sale.productName ?? ''}`.trim().slice(0, 120),
    soldUnits,
    unitPrice: Number(unitPrice.toFixed(2)),
    totalAmount: Number(totalAmount.toFixed(2)),
    paymentMethod:
      sale.paymentMethod === 'tarjeta' || sale.paymentMethod === 'bizum'
        ? sale.paymentMethod
        : 'efectivo',
    soldByEmail: `${sale.soldByEmail ?? ''}`.toLowerCase().trim(),
    soldAtIso: `${sale.soldAtIso ?? new Date().toISOString()}`,
  };
};

const RESERVATION_META_MARKER = '[arena-meta]';

const parseReservationMetaFromComments = (
  additionalCommentsRaw: string | null | undefined,
): {
  plainComments: string;
  meta: ReservationMetaPayload | null;
} => {
  const raw = `${additionalCommentsRaw ?? ''}`;
  const markerIndex = raw.lastIndexOf(RESERVATION_META_MARKER);

  if (markerIndex < 0) {
    return {
      plainComments: raw.trim(),
      meta: null,
    };
  }

  const plainComments = raw.slice(0, markerIndex).trim();
  const encodedMeta = raw.slice(markerIndex + RESERVATION_META_MARKER.length).trim();

  if (!encodedMeta) {
    return {
      plainComments,
      meta: null,
    };
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(encodedMeta)) as Partial<ReservationMetaPayload>;
    const services = Array.isArray(parsed.services)
      ? parsed.services
          .map((item) => ({
            id: `${item.id ?? ''}`.trim() || `svc-${Math.random().toString(36).slice(2, 8)}`,
            type: (item.type === 'treatment' ? 'treatment' : 'pack') as 'pack' | 'treatment',
            name: `${item.name ?? ''}`.trim(),
            quantity: Math.max(1, Math.floor(Number(item.quantity ?? 1) || 1)),
            durationMinutes: Math.max(0, Math.floor(Number(item.durationMinutes ?? 0) || 0)),
            unitPriceEuro: Math.max(0, Number(item.unitPriceEuro ?? 0) || 0),
            requiresReservationSignal: Boolean(item.requiresReservationSignal),
          }))
          .filter((item) => item.name)
      : [];
    const stock = Array.isArray(parsed.stock)
      ? parsed.stock
          .map((item) => ({
            id: `${item.id ?? ''}`.trim() || `stk-${Math.random().toString(36).slice(2, 8)}`,
            productId: `${item.productId ?? ''}`.trim(),
            productName: `${item.productName ?? ''}`.trim(),
            quantity: Math.max(1, Math.floor(Number(item.quantity ?? 1) || 1)),
            unitPriceEuro: Math.max(0, Number(item.unitPriceEuro ?? 0) || 0),
          }))
          .filter((item) => item.productId && item.productName)
      : [];

    const hasAnyItem = services.length > 0 || stock.length > 0;

    return {
      plainComments,
      meta: hasAnyItem
        ? {
            version: 1,
            linkedClientId: `${parsed.linkedClientId ?? ''}`.trim() || undefined,
            services,
            stock,
          }
        : null,
    };
  } catch {
    return {
      plainComments,
      meta: null,
    };
  }
};

const composeReservationCommentsWithMeta = (
  plainCommentsRaw: string,
  meta: ReservationMetaPayload | null,
): string => {
  const plainComments = `${plainCommentsRaw ?? ''}`.trim().slice(0, 500);

  if (!meta) {
    return plainComments;
  }

  const encoded = encodeURIComponent(JSON.stringify(meta));
  return plainComments
    ? `${plainComments}\n${RESERVATION_META_MARKER}${encoded}`
    : `${RESERVATION_META_MARKER}${encoded}`;
};

const buildDefaultReservationMeta = (data: {
  appointmentTypeName: string;
  durationMinutes: number;
  requiresReservationSignal: boolean;
  linkedClientId?: string;
}): ReservationMetaPayload => ({
  version: 1,
  linkedClientId: data.linkedClientId,
  services: [
    {
      id: 'svc-main',
      type: 'pack',
      name: data.appointmentTypeName,
      quantity: 1,
      durationMinutes: Math.max(0, Math.floor(data.durationMinutes)),
      unitPriceEuro: Math.max(0, Number(getPackPriceByName(data.appointmentTypeName) || 0)),
      requiresReservationSignal: data.requiresReservationSignal,
    },
  ],
  stock: [],
});

const getReservationMetaSummary = (
  meta: ReservationMetaPayload,
): {
  appointmentTypeName: string;
  durationMinutes: number;
  requiresReservationSignal: boolean;
  totalAmountEuro: number;
} => {
  const serviceParts = meta.services.flatMap((item) =>
    Array.from({ length: Math.max(1, item.quantity) }, () => item.name),
  );
  const appointmentTypeName = serviceParts.length > 0 ? serviceParts.join(' + ') : 'Servicio';

  const durationMinutes = meta.services.reduce(
    (acc, item) => acc + Math.max(0, item.durationMinutes) * Math.max(1, item.quantity),
    0,
  );

  const serviceAmount = meta.services.reduce(
    (acc, item) => acc + Math.max(0, item.unitPriceEuro) * Math.max(1, item.quantity),
    0,
  );
  const stockAmount = meta.stock.reduce(
    (acc, item) => acc + Math.max(0, item.unitPriceEuro) * Math.max(1, item.quantity),
    0,
  );

  const requiresReservationSignal = meta.services.some(
    (item) => item.requiresReservationSignal || requiresReservationSignalByName(item.name),
  );

  return {
    appointmentTypeName,
    durationMinutes,
    requiresReservationSignal,
    totalAmountEuro: Number((serviceAmount + stockAmount).toFixed(2)),
  };
};

const applyReservationStockOutput = async (
  meta: ReservationMetaPayload,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  if (!meta.stock.length) {
    return { ok: true };
  }

  const pendingUpdates: Array<{ current: StockProductItem; next: StockProductItem }> = [];

  for (const stockItem of meta.stock) {
    const product = stockProductsById.get(stockItem.productId);

    if (!product) {
      return {
        ok: false,
        error: `Producto no encontrado en stock: ${stockItem.productName}.`,
      };
    }

    if (!product.isSellable) {
      return {
        ok: false,
        error: `El producto ${product.productName} no está marcado para venta.`,
      };
    }

    const requestedUnits = Math.max(1, Math.floor(Number(stockItem.quantity) || 1));

    if (product.quantity < requestedUnits) {
      return {
        ok: false,
        error: `Stock insuficiente para ${product.productName}. Quedan ${product.quantity}.`,
      };
    }

    pendingUpdates.push({
      current: product,
      next: normalizeStockProduct({
        ...product,
        quantity: product.quantity - requestedUnits,
      }),
    });
  }

  for (const update of pendingUpdates) {
    try {
      await saveStockProductToDb(update.next);
      stockProductsById.set(update.next.id, update.next);
    } catch (error) {
      console.error('Error descontando stock asociado a reserva:', error);
      return {
        ok: false,
        error: 'No se pudo actualizar el stock de productos asociados a la reserva.',
      };
    }
  }

  void persistStockProductsToDisk();
  return { ok: true };
};

const sanitizeReservationMetaFromRequest = (
  rawMeta: unknown,
  fallback: {
    appointmentTypeName: string;
    durationMinutes: number;
    requiresReservationSignal: boolean;
    linkedClientId?: string;
  },
): ReservationMetaPayload => {
  const parsed =
    typeof rawMeta === 'object' && rawMeta
      ? (rawMeta as Partial<ReservationMetaPayload>)
      : undefined;

  if (!parsed || !Array.isArray(parsed.services)) {
    return buildDefaultReservationMeta(fallback);
  }

  const services = parsed.services
    .map((item) => ({
      id: `${item.id ?? ''}`.trim() || `svc-${Math.random().toString(36).slice(2, 8)}`,
      type: (item.type === 'treatment' ? 'treatment' : 'pack') as 'pack' | 'treatment',
      name: `${item.name ?? ''}`.trim(),
      quantity: Math.max(1, Math.floor(Number(item.quantity ?? 1) || 1)),
      durationMinutes: Math.max(0, Math.floor(Number(item.durationMinutes ?? 0) || 0)),
      unitPriceEuro: Math.max(0, Number(item.unitPriceEuro ?? 0) || 0),
      requiresReservationSignal: Boolean(item.requiresReservationSignal),
    }))
    .filter((item) => item.name);

  const stock = Array.isArray(parsed.stock)
    ? parsed.stock
        .map((item) => ({
          id: `${item.id ?? ''}`.trim() || `stk-${Math.random().toString(36).slice(2, 8)}`,
          productId: `${item.productId ?? ''}`.trim(),
          productName: `${item.productName ?? ''}`.trim(),
          quantity: Math.max(1, Math.floor(Number(item.quantity ?? 1) || 1)),
          unitPriceEuro: Math.max(0, Number(item.unitPriceEuro ?? 0) || 0),
        }))
        .filter((item) => item.productId && item.productName)
    : [];

  if (services.length === 0) {
    return buildDefaultReservationMeta(fallback);
  }

  return {
    version: 1,
    linkedClientId: `${parsed.linkedClientId ?? fallback.linkedClientId ?? ''}`.trim() || undefined,
    services,
    stock,
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

const normalizeEmployeePermissions = (permissions: unknown): EmployeePermission[] => {
  if (!Array.isArray(permissions)) {
    return [];
  }

  return permissions.filter((permission): permission is EmployeePermission =>
    ALL_EMPLOYEE_PERMISSIONS.includes(permission as EmployeePermission),
  );
};

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

const persistStockSalesToDisk = async (): Promise<void> => {
  try {
    await ensureRuntimeDataDir();
    const sales = Array.from(stockSalesById.values())
      .map((sale) => normalizeStockSale(sale))
      .sort((a, b) => b.soldAtIso.localeCompare(a.soldAtIso));
    await writeFile(stockSalesBackupFilePath, JSON.stringify(sales, null, 2), 'utf8');
  } catch (error) {
    console.error('Error guardando backup local de ventas de stock:', error);
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
      permissions: normalizeEmployeePermissions(user.permissions),
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

const loadStockSalesFromDisk = async (): Promise<StockSaleHistoryItem[]> => {
  try {
    const raw = await readFile(stockSalesBackupFilePath, 'utf8');
    const parsed = JSON.parse(raw) as StockSaleHistoryItem[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((sale) => Boolean(sale?.id)).map((sale) => normalizeStockSale(sale));
  } catch {
    return [];
  }
};

// ── Cierre de caja helpers ────────────────────────────────────────────────────

const buildCierreId = (): string =>
  `cierre_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const buildPaymentOperationId = (): string =>
  `payop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const normalizePaymentOperationDetail = (
  detail: PaymentOperationDetail,
): PaymentOperationDetail => {
  const paymentMethod =
    detail.paymentMethod === 'tarjeta' || detail.paymentMethod === 'bizum'
      ? detail.paymentMethod
      : 'efectivo';

  const operationType =
    detail.operationType === 'stock_sale' || detail.operationType === 'reservation_payment'
      ? detail.operationType
      : 'client_pack_payment';

  return {
    id: `${detail.id ?? buildPaymentOperationId()}`,
    operationType,
    concept: `${detail.concept ?? ''}`.trim().slice(0, 180) || 'Operación',
    amount: Number(detail.amount) || 0,
    paymentMethod,
    performedByEmail: `${detail.performedByEmail ?? ''}`.trim().toLowerCase(),
    createdAtIso: `${detail.createdAtIso ?? new Date().toISOString()}`,
  };
};

const normalizePaymentOperationDetails = (value: unknown): PaymentOperationDetail[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as Partial<PaymentOperationDetail>;
      return normalizePaymentOperationDetail({
        id: `${candidate.id ?? ''}`,
        operationType:
          candidate.operationType === 'stock_sale' ||
          candidate.operationType === 'reservation_payment'
            ? candidate.operationType
            : 'client_pack_payment',
        concept: `${candidate.concept ?? ''}`,
        amount: Number(candidate.amount) || 0,
        paymentMethod:
          candidate.paymentMethod === 'tarjeta' || candidate.paymentMethod === 'bizum'
            ? candidate.paymentMethod
            : 'efectivo',
        performedByEmail: `${candidate.performedByEmail ?? ''}`,
        createdAtIso: `${candidate.createdAtIso ?? new Date().toISOString()}`,
      });
    })
    .filter((detail): detail is PaymentOperationDetail => detail !== null && detail.amount > 0)
    .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
};

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
  operationDetails: normalizePaymentOperationDetails(cierre.operationDetails),
});

const getLatestCierreForDate = (dateIso: string): CierreCajaItem | null => {
  const normalizedDateIso = `${dateIso ?? ''}`.trim();

  if (!normalizedDateIso) {
    return null;
  }

  const cierresForDate = Array.from(cierreCajaById.values())
    .map(normalizeCierre)
    .filter((cierre) => cierre.fechaIso === normalizedDateIso)
    .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));

  return cierresForDate[0] ?? null;
};

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
    operationDetails: normalizePaymentOperationDetails(item.operationDetails),
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
  operationDetail: {
    operationType: 'stock_sale' | 'client_pack_payment' | 'reservation_payment';
    concept: string;
    performedByEmail: string;
  },
): DailyPaymentSummaryItem => {
  const current = dailyPaymentsByDateIso.get(dateIso) ?? {
    dateIso,
    efectivo: 0,
    tarjeta: 0,
    bizum: 0,
    total: 0,
    updatedAtIso: new Date().toISOString(),
    operationDetails: [],
  };

  const detail = normalizePaymentOperationDetail({
    id: buildPaymentOperationId(),
    operationType: operationDetail.operationType,
    concept: operationDetail.concept,
    amount,
    paymentMethod,
    performedByEmail: operationDetail.performedByEmail,
    createdAtIso: new Date().toISOString(),
  });

  const next: DailyPaymentSummaryItem = {
    ...current,
    [paymentMethod]: Number((current[paymentMethod] + amount).toFixed(2)),
    updatedAtIso: new Date().toISOString(),
    operationDetails: [detail, ...(current.operationDetails ?? [])],
  };

  const normalized = normalizeDailyPaymentSummary(next);
  dailyPaymentsByDateIso.set(dateIso, normalized);
  void persistDailyPaymentsToDisk();
  saveDailyPaymentToDb(normalized).catch((err: unknown) => {
    console.error('Error persistiendo cobro diario en DB:', err);
  });
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

const isPersistenceDebugAllowed = (_req: express.Request): boolean => true;

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

const normalizeWorkerEmail = (value: string | null | undefined): string =>
  `${value ?? ''}`.trim().toLowerCase();

const isAssignableWorkerUser = (user: AppUser | undefined): boolean => {
  if (!user) {
    return false;
  }

  const role = getEffectiveUserRole(user);
  return role === 'admin' || role === 'superadmin';
};

const listAssignableWorkerEmails = (): string[] => {
  seedAuthUsers();

  return Array.from(usersByEmail.values())
    .filter((user) => isAssignableWorkerUser(user))
    .map((user) => normalizeWorkerEmail(user.email))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
};

const getMaxConcurrentReservationsForSlot = (): number =>
  Math.max(1, listAssignableWorkerEmails().length);

const buildAdminMagicLinkEmailHtml = (magicLink: string): string => {
  const safeLink = escapeHtml(magicLink);

  return `
    <div style="background:#fcf3ea;padding:24px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#3b2f2a;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;background:#fff9f4;border-radius:16px;overflow:hidden;border:1px solid #e8d8c9;">
        <tr>
          <td style="background:linear-gradient(135deg,#c97b63 0%,#d9a441 100%);padding:24px;">
            <p style="margin:0 0 6px;color:#fff6ee;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Arena Studio</p>
            <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.25;">Acceso temporal gestión</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Has solicitado acceso al panel de gestión.</p>
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

app.post('/api/cliente/registro', async (req, res) => {
  const nombre = `${req.body?.nombre ?? ''}`.trim();
  const apellidos = `${req.body?.apellidos ?? ''}`.trim();
  const fechaNacimientoRaw = `${req.body?.fechaNacimiento ?? ''}`.trim();
  const fechaNacimiento = normalizeBirthDateIso(req.body?.fechaNacimiento);
  const telefono = `${req.body?.telefono ?? ''}`.trim();
  const email = `${req.body?.email ?? ''}`.trim().toLowerCase();
  const password = `${req.body?.password ?? ''}`.trim();

  if (isFutureBirthDateIso(fechaNacimientoRaw)) {
    return res.status(400).json({
      ok: false,
      error: 'La fecha de nacimiento no puede ser posterior a hoy.',
    });
  }

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
    await saveClientCardToDb(normalizedCard);
    clientCardsById.set(card.id, normalizedCard);
    void persistClientCardsToDisk();

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
    await saveClientCardToDb(client);

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

app.get('/api/cliente/citas', async (req, res) => {
  seedAuthUsers();
  const session = getClientSession(req.headers.cookie);

  if (!session.isAuthenticated || !session.card) {
    return res
      .status(401)
      .json({ ok: false, error: 'Debes iniciar sesión para ver tu historial.' });
  }

  const normalizePhone = (value: string): string => `${value}`.replace(/\D/g, '');
  const clientCard = session.card;
  const cardEmail = `${clientCard.email ?? ''}`.trim().toLowerCase();
  const cardPhone = normalizePhone(clientCard.phone ?? '');

  try {
    const reservations = await listReservationsForAdmin();
    const nowMs = Date.now();

    const citas = reservations
      .filter((reservation) => reservation.adminStatus !== 'rejected')
      .filter((reservation) => {
        const parsedMeta = parseReservationMetaFromComments(reservation.additionalComments);
        const linkedClientId = parsedMeta.meta?.linkedClientId;

        if (linkedClientId && linkedClientId === clientCard.id) {
          return true;
        }

        const reservationEmail = `${reservation.customerEmail ?? ''}`.trim().toLowerCase();
        const reservationPhone = normalizePhone(reservation.customerPhone ?? '');

        if (cardEmail && reservationEmail && reservationEmail === cardEmail) {
          return true;
        }

        if (cardPhone && reservationPhone && reservationPhone === cardPhone) {
          return true;
        }

        return false;
      })
      .map((reservation) => {
        const parsedMeta = parseReservationMetaFromComments(reservation.additionalComments);
        const metaSummary = parsedMeta.meta ? getReservationMetaSummary(parsedMeta.meta) : null;
        const startMs = getReservationStartMs(reservation.dateIso, reservation.startTime);

        return {
          id: reservation.id,
          dateIso: reservation.dateIso,
          startTime: reservation.startTime,
          endTime: reservation.endTime,
          appointmentTypeName: metaSummary?.appointmentTypeName || reservation.appointmentTypeName,
          isUpcoming: startMs !== null ? startMs >= nowMs : false,
          adminStatus: reservation.adminStatus,
          createdAtIso: reservation.createdAtIso,
        };
      })
      .sort((left, right) => {
        const leftMs = getReservationStartMs(left.dateIso, left.startTime) ?? 0;
        const rightMs = getReservationStartMs(right.dateIso, right.startTime) ?? 0;
        return rightMs - leftMs;
      });

    return res.status(200).json({
      ok: true,
      client: {
        id: clientCard.id,
        fullName: clientCard.fullName,
        email: clientCard.email,
      },
      citas,
    });
  } catch (error) {
    console.error('Error listando citas de cliente:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo cargar el historial de citas.' });
  }
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
    const availableSlots = await getAvailableSlotsForDate(
      alert.dateIso,
      durationMinutes,
      getMaxConcurrentReservationsForSlot(),
    );
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

app.get('/api/health', (_req, res) => {
  return res.status(200).json({
    ok: true,
    status: notificationsDegradedMode ? 'degraded' : 'healthy',
    notificationsMode: notificationsDegradedMode ? 'degraded' : 'normal',
    startedAtIso: serverStartedAtIso,
    nowIso: new Date().toISOString(),
  });
});

app.get('/api/admin/debug/persistencia', async (req, res) => {
  seedAuthUsers();

  if (!isPersistenceDebugAllowed(req)) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const pool = getDatabasePoolForIntegrations();

  if (!pool) {
    return res.status(500).json({
      ok: false,
      error: 'La conexión a base de datos no está disponible en este entorno.',
      dbTarget: getDatabaseTargetLabel(),
      nodeEnv: process.env['NODE_ENV'] ?? 'undefined',
      fallbackFlag: process.env['ALLOW_MEMORY_RESERVAS_FALLBACK'] === 'true',
    });
  }

  try {
    const [usersCount, cardsCount, stockCount, cierresCount, dailyCount, latestStock] =
      await Promise.all([
        pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM app_users'),
        pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM client_cards'),
        pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM stock_products'),
        pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM cierre_caja_entries'),
        pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM daily_payment_summaries'),
        pool.query<{
          id: string;
          product_name: string;
          brand: string;
          quantity: number;
          price: string;
          created_at: string;
        }>(
          `
          SELECT id, product_name, brand, quantity, price, created_at
          FROM stock_products
          ORDER BY created_at DESC
          LIMIT 10
          `,
        ),
      ]);

    return res.status(200).json({
      ok: true,
      dbTarget: getDatabaseTargetLabel(),
      nodeEnv: process.env['NODE_ENV'] ?? 'undefined',
      fallbackFlag: process.env['ALLOW_MEMORY_RESERVAS_FALLBACK'] === 'true',
      counts: {
        appUsers: usersCount.rows[0]?.n ?? 0,
        clientCards: cardsCount.rows[0]?.n ?? 0,
        stockProducts: stockCount.rows[0]?.n ?? 0,
        cierresCaja: cierresCount.rows[0]?.n ?? 0,
        dailyPaymentSummaries: dailyCount.rows[0]?.n ?? 0,
      },
      latestStockProducts: latestStock.rows.map((row) => ({
        id: row.id,
        productName: row.product_name,
        brand: row.brand,
        quantity: Number(row.quantity) || 0,
        price: Number(row.price) || 0,
        createdAtIso: new Date(row.created_at).toISOString(),
      })),
    });
  } catch (error) {
    console.error('[debug/persistencia] Error leyendo estado de DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo leer el estado de persistencia en DB.',
      detail: error instanceof Error ? error.message : 'Error desconocido',
      dbTarget: getDatabaseTargetLabel(),
      nodeEnv: process.env['NODE_ENV'] ?? 'undefined',
    });
  }
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

app.get('/api/admin/almacen/sales', (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const sales = Array.from(stockSalesById.values())
    .map((sale) => normalizeStockSale(sale))
    .sort((a, b) => b.soldAtIso.localeCompare(a.soldAtIso));

  return res.status(200).json({ ok: true, sales });
});

app.post('/api/admin/almacen', async (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const productName = `${req.body?.productName ?? ''}`.trim();
  const brand = `${req.body?.brand ?? ''}`.trim();
  const color = `${req.body?.color ?? ''}`.trim();
  const quantity = Number(req.body?.quantity ?? NaN);
  const priceRaw = `${req.body?.price ?? ''}`.trim().replace(',', '.');
  const price = priceRaw === '' ? 0 : Number(priceRaw);
  const isSellable = Boolean(req.body?.isSellable);

  if (!productName || !brand) {
    return res.status(400).json({
      ok: false,
      error: 'Nombre del producto y marca son obligatorios.',
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

  try {
    await saveStockProductToDb(product);
  } catch (error) {
    console.error('Error persistiendo producto de almacén en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo guardar el producto en base de datos. Intenta de nuevo.',
    });
  }

  stockProductsById.set(product.id, product);
  void persistStockProductsToDisk();
  console.log(`[persistencia] stock guardado en DB id=${product.id}`);

  return res.status(200).json({ ok: true, product });
});

app.patch('/api/admin/almacen/:id', async (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const id = `${req.params['id'] ?? ''}`.trim();
  const productName = `${req.body?.productName ?? ''}`.trim();
  const priceRaw = `${req.body?.price ?? ''}`.trim().replace(',', '.');
  const price = priceRaw === '' ? 0 : Number(priceRaw);
  const sellableRaw = req.body?.isSellable;
  const isSellable =
    typeof sellableRaw === 'string'
      ? ['1', 'true', 'yes', 'si', 'sí'].includes(sellableRaw.trim().toLowerCase())
      : Boolean(sellableRaw);

  if (!id) {
    return res.status(400).json({ ok: false, error: 'ID de producto inválido.' });
  }

  if (!productName) {
    return res.status(400).json({ ok: false, error: 'El título del producto es obligatorio.' });
  }

  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({
      ok: false,
      error: 'El precio debe ser un número válido igual o mayor que 0.',
    });
  }

  const product = stockProductsById.get(id);

  if (!product) {
    return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
  }

  const updated = normalizeStockProduct({
    ...product,
    productName,
    price,
    isSellable,
  });

  try {
    await saveStockProductToDb(updated);
  } catch (error) {
    console.error('Error persistiendo edición de stock en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo actualizar el producto en base de datos. Intenta de nuevo.',
    });
  }

  stockProductsById.set(id, updated);
  void persistStockProductsToDisk();

  return res.status(200).json({ ok: true, product: normalizeStockProduct(updated) });
});

// ── Cierre de caja ─────────────────────────────────────────────────────────

app.patch('/api/admin/almacen/:id/quantity', async (req, res) => {
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

  try {
    await saveStockProductToDb(updated);
  } catch (error) {
    console.error('Error persistiendo actualización de stock en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo actualizar el stock en base de datos. Intenta de nuevo.',
    });
  }

  stockProductsById.set(id, updated);
  void persistStockProductsToDisk();
  await triggerLowStockNotificationIfNeeded(updated, product.quantity);

  return res.status(200).json({ ok: true, product: normalizeStockProduct(updated) });
});

app.post('/api/admin/almacen/:id/sell', async (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const id = `${req.params['id'] ?? ''}`.trim();
  const units = Number(req.body?.units ?? NaN);
  const paymentMethod = `${req.body?.paymentMethod ?? ''}`.trim();

  if (!id) {
    return res.status(400).json({ ok: false, error: 'ID de producto inválido.' });
  }

  if (!Number.isInteger(units) || units <= 0) {
    return res
      .status(400)
      .json({ ok: false, error: 'Las unidades deben ser un entero mayor que 0.' });
  }

  if (!['efectivo', 'tarjeta', 'bizum'].includes(paymentMethod)) {
    return res.status(400).json({
      ok: false,
      error: 'Método de pago debe ser "efectivo", "tarjeta" o "bizum".',
    });
  }

  const product = stockProductsById.get(id);

  if (!product) {
    return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
  }

  if (!product.isSellable) {
    return res.status(400).json({ ok: false, error: 'Este producto no está marcado para vender.' });
  }

  if (product.quantity < units) {
    return res.status(400).json({ ok: false, error: 'No hay suficiente stock para esta venta.' });
  }

  const totalAmount = Number((product.price * units).toFixed(2));
  const updated = normalizeStockProduct({
    ...product,
    quantity: product.quantity - units,
  });

  try {
    await saveStockProductToDb(updated);
  } catch (error) {
    console.error('Error persistiendo venta de producto en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo registrar la venta en base de datos. Intenta de nuevo.',
    });
  }

  stockProductsById.set(id, updated);
  void persistStockProductsToDisk();
  await triggerLowStockNotificationIfNeeded(updated, product.quantity);

  const sale = normalizeStockSale({
    id: buildStockSaleId(),
    productId: updated.id,
    productName: updated.productName,
    soldUnits: units,
    unitPrice: updated.price,
    totalAmount,
    paymentMethod: paymentMethod as 'efectivo' | 'tarjeta' | 'bizum',
    soldByEmail: session.email,
    soldAtIso: new Date().toISOString(),
  });
  stockSalesById.set(sale.id, sale);
  void persistStockSalesToDisk();

  const todayIso = new Date().toISOString().slice(0, 10);
  addPaymentToDailySummary(
    todayIso,
    paymentMethod as 'efectivo' | 'tarjeta' | 'bizum',
    totalAmount,
    {
      operationType: 'stock_sale',
      concept: `Venta stock: ${updated.productName} (${units} ud.)`,
      performedByEmail: session.email,
    },
  );

  return res.status(200).json({
    ok: true,
    product: normalizeStockProduct(updated),
    soldUnits: units,
    totalAmount,
    paymentMethod,
  });
});

app.delete('/api/admin/almacen/:id', async (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const id = `${req.params['id'] ?? ''}`.trim();

  if (!id) {
    return res.status(400).json({ ok: false, error: 'ID de producto inválido.' });
  }

  const product = stockProductsById.get(id);

  if (!product) {
    return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
  }

  try {
    await deleteStockProductFromDb(id);
  } catch (error) {
    console.error('Error eliminando producto de stock en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo eliminar el producto en base de datos. Intenta de nuevo.',
    });
  }

  stockProductsById.delete(id);
  void persistStockProductsToDisk();

  return res.status(200).json({ ok: true, id });
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
  const latestCierreToday = getLatestCierreForDate(todayIso);

  if (latestCierreToday) {
    return res.status(200).json({
      ok: true,
      today: null,
      alreadyClosed: true,
      cierre: latestCierreToday,
    });
  }

  const today = dailyPaymentsByDateIso.get(todayIso) ?? {
    dateIso: todayIso,
    efectivo: 0,
    tarjeta: 0,
    bizum: 0,
    total: 0,
    updatedAtIso: '',
    operationDetails: [],
  };

  return res.status(200).json({
    ok: true,
    today: normalizeDailyPaymentSummary(today),
    alreadyClosed: false,
  });
});

app.post('/api/admin/cierre-caja', async (req, res) => {
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
    const existingCierre = getLatestCierreForDate(fechaIso);

    if (existingCierre) {
      return res.status(409).json({
        ok: false,
        error:
          'Ya existe un cierre registrado para hoy. Revisa el historial para editarlo o anularlo.',
      });
    }

    const dailySummary = dailyPaymentsByDateIso.get(fechaIso);
    const operationDetails = normalizePaymentOperationDetails(dailySummary?.operationDetails ?? []);

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
      operationDetails,
    });

    try {
      await saveCierreCajaToDb(cierre);
    } catch (error) {
      console.error('Error persistiendo cierre de caja en DB:', error);
      return res.status(500).json({
        ok: false,
        error: 'No se pudo guardar el cierre en base de datos. Intenta de nuevo.',
      });
    }

    cierreCajaById.set(cierre.id, cierre);
    void persistCierreCajaToDisk();
    console.log(`[persistencia] cierre guardado en DB id=${cierre.id}`);

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

app.patch('/api/admin/cierre-caja/:id', async (req, res) => {
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

  try {
    await saveCierreCajaToDb(updated);
  } catch (error) {
    console.error('Error persistiendo actualización de cierre en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo actualizar el cierre en base de datos. Intenta de nuevo.',
    });
  }

  cierreCajaById.set(id, updated);
  void persistCierreCajaToDisk();

  return res.status(200).json({ ok: true, cierre: updated });
});

app.delete('/api/admin/cierre-caja/:id', async (req, res) => {
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

  try {
    await deleteCierreCajaFromDb(id);
  } catch (error) {
    console.error('Error eliminando cierre de caja en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo eliminar el cierre en base de datos. Intenta de nuevo.',
    });
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

app.post('/api/admin/clientes', async (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const fullName = `${req.body?.fullName ?? ''}`.trim();
  const email = `${req.body?.email ?? ''}`.trim().toLowerCase();
  const phone = `${req.body?.phone ?? ''}`.trim();
  const birthDateRaw = `${req.body?.birthDateIso ?? ''}`.trim();
  const birthDateIso = normalizeBirthDateIso(req.body?.birthDateIso);
  const notes = `${req.body?.notes ?? ''}`.trim().slice(0, 500);

  if (isFutureBirthDateIso(birthDateRaw)) {
    return res.status(400).json({
      ok: false,
      error: 'La fecha de nacimiento no puede ser posterior a hoy.',
    });
  }

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

  try {
    await saveClientCardToDb(normalizedCard);
  } catch (error) {
    console.error('Error persistiendo ficha de cliente en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo guardar la ficha en base de datos. Intenta de nuevo.',
    });
  }

  clientCardsById.set(card.id, normalizedCard);
  void persistClientCardsToDisk();
  console.log(`[persistencia] ficha guardada en DB id=${normalizedCard.id}`);

  return res.status(200).json({ ok: true, card: normalizedCard });
});

app.patch('/api/admin/clientes/:id', async (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const id = `${req.params['id'] ?? ''}`.trim();
  const fullName = `${req.body?.fullName ?? ''}`.trim();
  const email = `${req.body?.email ?? ''}`.trim().toLowerCase();
  const phone = `${req.body?.phone ?? ''}`.trim();
  const birthDateRaw = `${req.body?.birthDateIso ?? ''}`.trim();
  const birthDateIso = normalizeBirthDateIso(req.body?.birthDateIso);
  const notes = `${req.body?.notes ?? ''}`.trim().slice(0, 500);

  if (isFutureBirthDateIso(birthDateRaw)) {
    return res.status(400).json({
      ok: false,
      error: 'La fecha de nacimiento no puede ser posterior a hoy.',
    });
  }

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

  try {
    await saveClientCardToDb(nextCard);
  } catch (error) {
    console.error('Error persistiendo actualización de ficha de cliente en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo actualizar la ficha en base de datos. Intenta de nuevo.',
    });
  }

  clientCardsById.set(id, nextCard);
  void persistClientCardsToDisk();

  return res.status(200).json({ ok: true, card: nextCard });
});

app.delete('/api/admin/clientes/:id', async (req, res) => {
  seedAuthUsers();
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const id = `${req.params['id'] ?? ''}`.trim();

  if (!id) {
    return res.status(400).json({ ok: false, error: 'ID de clienta inválido.' });
  }

  const card = clientCardsById.get(id);

  if (!card) {
    return res.status(404).json({ ok: false, error: 'Ficha de clienta no encontrada.' });
  }

  const normalizePhone = (value: string): string => `${value}`.replace(/\D/g, '');
  const cardEmail = `${card.email ?? ''}`.trim().toLowerCase();
  const cardPhone = normalizePhone(card.phone ?? '');

  let deletedReservations = 0;

  try {
    const reservations = await listReservationsForAdmin();
    const linkedReservations = reservations.filter((reservation) => {
      const reservationEmail = `${reservation.customerEmail ?? ''}`.trim().toLowerCase();
      const reservationPhone = normalizePhone(reservation.customerPhone ?? '');

      if (cardEmail && reservationEmail && reservationEmail === cardEmail) {
        return true;
      }

      if (cardPhone && reservationPhone && reservationPhone === cardPhone) {
        return true;
      }

      return false;
    });

    for (const reservation of linkedReservations) {
      await deleteReservationById(reservation.id);
      await notifyFreedSlotAlerts({
        dateIso: reservation.dateIso,
        startTime: reservation.startTime,
        endTime: reservation.endTime,
        appointmentTypeName: reservation.appointmentTypeName,
      });
      deletedReservations += 1;
    }

    await deleteClientCardFromDb(id);
  } catch (error) {
    console.error('Error eliminando clienta y reservas asociadas:', error);
    return res.status(500).json({
      ok: false,
      error:
        'No se pudo eliminar la clienta y sus reservas asociadas en base de datos. Intenta de nuevo.',
    });
  }

  clientCardsById.delete(id);
  void persistClientCardsToDisk();

  return res.status(200).json({ ok: true, deletedReservations });
});

app.post('/api/admin/clientes/:id/packs', async (req, res) => {
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

  try {
    await saveClientCardToDb(nextCard);
  } catch (error) {
    console.error('Error persistiendo tratamiento en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo guardar el tratamiento en base de datos. Intenta de nuevo.',
    });
  }

  clientCardsById.set(card.id, nextCard);
  void persistClientCardsToDisk();

  return res.status(200).json({ ok: true, card: nextCard });
});

app.patch('/api/admin/clientes/:clientId/packs/:treatmentId/payment', async (req, res) => {
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

  try {
    await saveClientCardToDb(updatedCard);
  } catch (error) {
    console.error('Error persistiendo pago de tratamiento en DB:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo guardar el cobro en base de datos. Intenta de nuevo.',
    });
  }

  clientCardsById.set(clientId, updatedCard);
  void persistClientCardsToDisk();
  const todayIso = new Date().toISOString().slice(0, 10);
  addPaymentToDailySummary(
    todayIso,
    paymentMethod as 'efectivo' | 'tarjeta' | 'bizum',
    Number(priceEuro.toFixed(2)),
    {
      operationType: 'client_pack_payment',
      concept: `Pack: ${updatedTreatment.name}`,
      performedByEmail: session.email,
    },
  );

  return res.status(200).json({ ok: true, card: updatedCard });
});

app.get('/api/admin/empleados', (req, res) => {
  seedAuthUsers();
  const session = getAuthSession(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  if (session.role !== 'superadmin') {
    const users = listUsersForSuperadmin().filter((user) => user.role === 'admin');
    return res.status(200).json({ ok: true, users });
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
  const paymentAmountEuroRaw = Number(req.body?.priceEuro ?? NaN);
  const splitPaymentsRaw = Array.isArray(req.body?.splitPayments) ? req.body.splitPayments : [];
  const paidItemIdsRaw = Array.isArray(req.body?.paidItemIds)
    ? req.body.paidItemIds.map((item: unknown) => `${item ?? ''}`.trim()).filter(Boolean)
    : [];

  if (!reservationId) {
    return res.status(400).json({ ok: false, error: 'ID de reserva inválido.' });
  }

  try {
    const reservations = await listReservationsForAdmin();
    const reservation = reservations.find((item) => item.id === reservationId);

    if (!reservation) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    const parsedMeta = parseReservationMetaFromComments(reservation.additionalComments);
    const meta = parsedMeta.meta;
    const metaSummary = meta ? getReservationMetaSummary(meta) : null;
    const resolvedPriceEuro = Number(
      (metaSummary?.totalAmountEuro ?? getPackPriceByName(reservation.appointmentTypeName)).toFixed(
        2,
      ),
    );
    const availablePaymentItems = meta
      ? [
          ...meta.services.map((item, index) => ({
            id: `svc-${index}`,
            label: item.name,
            amount: Number((item.unitPriceEuro * item.quantity).toFixed(2)),
          })),
          ...meta.stock.map((item, index) => ({
            id: `stk-${index}`,
            label: `${item.productName} x${item.quantity}`,
            amount: Number((item.unitPriceEuro * item.quantity).toFixed(2)),
          })),
        ]
      : [
          {
            id: 'svc-main',
            label: reservation.appointmentTypeName,
            amount: Number(resolvedPriceEuro.toFixed(2)),
          },
        ];
    const selectedItems =
      paidItemIdsRaw.length > 0
        ? availablePaymentItems.filter((item) => paidItemIdsRaw.includes(item.id))
        : availablePaymentItems;
    const selectedItemsAmount = selectedItems.reduce((acc, item) => acc + item.amount, 0);
    const splitPayments: Array<{ method: 'efectivo' | 'tarjeta' | 'bizum'; amount: number }> =
      splitPaymentsRaw
        .map(
          (entry: unknown): { method: 'efectivo' | 'tarjeta' | 'bizum'; amount: number } | null => {
            if (!entry || typeof entry !== 'object') {
              return null;
            }

            const method = `${(entry as { method?: string }).method ?? ''}`.trim();
            const amountRaw = Number((entry as { amount?: number }).amount ?? NaN);
            const normalizedMethod =
              method === 'efectivo' || method === 'tarjeta' || method === 'bizum' ? method : null;
            const normalizedAmount =
              Number.isFinite(amountRaw) && amountRaw >= 0 ? Number(amountRaw.toFixed(2)) : null;

            return normalizedMethod && normalizedAmount !== null
              ? { method: normalizedMethod, amount: normalizedAmount }
              : null;
          },
        )
        .filter(
          (
            entry: { method: 'efectivo' | 'tarjeta' | 'bizum'; amount: number } | null,
          ): entry is { method: 'efectivo' | 'tarjeta' | 'bizum'; amount: number } => !!entry,
        );

    const paymentAmountEuro =
      Number.isFinite(paymentAmountEuroRaw) && paymentAmountEuroRaw >= 0
        ? Number(paymentAmountEuroRaw.toFixed(2))
        : Number(selectedItemsAmount.toFixed(2));
    const splitAmountEuro = splitPayments.reduce(
      (acc: number, item: { method: 'efectivo' | 'tarjeta' | 'bizum'; amount: number }) =>
        acc + item.amount,
      0,
    );
    const combinedPaymentAmountEuro =
      splitPayments.length > 0 ? Number(splitAmountEuro.toFixed(2)) : paymentAmountEuro;
    const signalAmountEuro = Math.max(0, Number(reservation.signalAmountEuro ?? 0));
    const finalChargeEuro = Math.max(
      0,
      Number((combinedPaymentAmountEuro - signalAmountEuro).toFixed(2)),
    );
    const shouldAccumulate =
      paymentReceived &&
      !reservation.paymentReceived &&
      ((paymentMethod && ['efectivo', 'tarjeta', 'bizum'].includes(paymentMethod)) ||
        splitPayments.length > 0);

    if (splitPayments.length > 0 && Math.abs(splitAmountEuro - paymentAmountEuro) > 0.01) {
      return res
        .status(400)
        .json({
          ok: false,
          error: 'La suma del cobro combinado debe coincidir con el total a cobrar.',
        });
    }

    if (shouldAccumulate && meta?.stock?.length) {
      const stockUpdate = await applyReservationStockOutput(meta);

      if (!stockUpdate.ok) {
        return res.status(409).json({ ok: false, error: stockUpdate.error });
      }
    }

    const resolvedPaymentMethod =
      splitPayments.length > 0
        ? splitPayments[0].method
        : paymentMethod === 'efectivo' || paymentMethod === 'tarjeta' || paymentMethod === 'bizum'
          ? paymentMethod
          : undefined;

    const updated = await updateReservationPaymentReceived(reservationId, paymentReceived, {
      paymentMethod: resolvedPaymentMethod,
      paymentAmountEuro: combinedPaymentAmountEuro,
    });

    if (!updated.ok) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    if (shouldAccumulate && finalChargeEuro > 0) {
      const todayIso = new Date().toISOString().slice(0, 10);
      const signalPaymentMethodLabel =
        reservation.signalPaymentMethod === 'efectivo'
          ? 'efectivo'
          : reservation.signalPaymentMethod === 'tarjeta'
            ? 'tarjeta'
            : reservation.signalPaymentMethod === 'bizum'
              ? 'bizum'
              : null;
      const signalDateLabel = reservation.signalReceivedAtIso
        ? new Date(reservation.signalReceivedAtIso).toISOString().slice(0, 10)
        : null;
      const signalInfoSuffix =
        signalAmountEuro > 0
          ? ` · Señal previa: ${signalAmountEuro.toFixed(2)} €${signalPaymentMethodLabel ? ` (${signalPaymentMethodLabel})` : ''}${signalDateLabel ? ` cobrada el ${signalDateLabel}` : ''}`
          : '';
      const paidItemsSuffix =
        selectedItems.length > 0
          ? ` · Conceptos: ${selectedItems.map((item) => item.label).join(', ')}`
          : '';

      if (splitPayments.length > 0) {
        splitPayments.forEach(
          (entry: { method: 'efectivo' | 'tarjeta' | 'bizum'; amount: number }) => {
            addPaymentToDailySummary(todayIso, entry.method, entry.amount, {
              operationType: 'reservation_payment',
              concept: `Pago final cita: ${reservation.customerName} · ${reservation.appointmentTypeName} · ${reservation.dateIso} ${reservation.startTime}${signalInfoSuffix}${paidItemsSuffix} · ${entry.method}`,
              performedByEmail: session.email,
            });
          },
        );
      } else if (
        paymentMethod === 'efectivo' ||
        paymentMethod === 'tarjeta' ||
        paymentMethod === 'bizum'
      ) {
        addPaymentToDailySummary(
          todayIso,
          paymentMethod as 'efectivo' | 'tarjeta' | 'bizum',
          finalChargeEuro,
          {
            operationType: 'reservation_payment',
            concept: `Pago final cita: ${reservation.customerName} · ${reservation.appointmentTypeName} · ${reservation.dateIso} ${reservation.startTime}${signalInfoSuffix}${paidItemsSuffix}`,
            performedByEmail: session.email,
          },
        );
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error actualizando pago de reserva:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo actualizar el pago.' });
  }
});

app.patch('/api/admin/reservas/:id/stock-line', async (req, res) => {
  const session = getAuthSession(req.headers.cookie);
  const superadminSession = isSuperadminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const reservationId = `${req.params['id'] ?? ''}`.trim();
  const productId = `${req.body?.productId ?? ''}`.trim();
  const clientCardId = `${req.body?.clientCardId ?? ''}`.trim();
  const quantity = Math.max(1, Math.floor(Number(req.body?.quantity ?? 1) || 1));

  if (!reservationId) {
    return res.status(400).json({ ok: false, error: 'ID de reserva inválido.' });
  }

  if (!productId) {
    return res.status(400).json({ ok: false, error: 'Selecciona un producto de stock.' });
  }

  try {
    const reservations = await listReservationsForAdmin();
    const reservation = reservations.find((item) => item.id === reservationId);

    if (!reservation) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    if (reservation.adminStatus === 'rejected') {
      return res
        .status(409)
        .json({ ok: false, error: 'No se puede editar una reserva cancelada.' });
    }

    const product = stockProductsById.get(productId);

    if (!product) {
      return res.status(404).json({ ok: false, error: 'Producto no encontrado en almacén.' });
    }

    if (!product.isSellable) {
      return res
        .status(409)
        .json({ ok: false, error: 'El producto seleccionado no está habilitado para venta.' });
    }

    if (product.quantity < quantity) {
      return res.status(409).json({
        ok: false,
        error: `No hay stock suficiente de ${product.productName}. Disponible: ${product.quantity}.`,
      });
    }

    const parsed = parseReservationMetaFromComments(reservation.additionalComments);
    const fallbackMeta = buildDefaultReservationMeta({
      appointmentTypeName: reservation.appointmentTypeName,
      durationMinutes: reservation.durationMinutes,
      requiresReservationSignal: requiresReservationSignalByName(reservation.appointmentTypeName),
      linkedClientId: clientCardId || undefined,
    });
    const baseMeta = parsed.meta ?? fallbackMeta;
    const nextStock = [...baseMeta.stock];
    const existingStockIndex = nextStock.findIndex((item) => item.productId === product.id);

    if (existingStockIndex >= 0) {
      const currentItem = nextStock[existingStockIndex];
      nextStock[existingStockIndex] = {
        ...currentItem,
        quantity: currentItem.quantity + quantity,
        unitPriceEuro: Math.max(0, Number(product.price || currentItem.unitPriceEuro || 0)),
      };
    } else {
      nextStock.push({
        id: `stk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        productId: product.id,
        productName: product.productName,
        quantity,
        unitPriceEuro: Math.max(0, Number(product.price || 0)),
      });
    }

    const updatedMeta: ReservationMetaPayload = {
      version: 1,
      linkedClientId: clientCardId || baseMeta.linkedClientId,
      services: baseMeta.services,
      stock: nextStock,
    };

    const updatedProduct = normalizeStockProduct({
      ...product,
      quantity: product.quantity - quantity,
    });

    try {
      await saveStockProductToDb(updatedProduct);
    } catch (error) {
      console.error('Error persistiendo stock tras añadir producto a reserva:', error);
      return res.status(500).json({
        ok: false,
        error: 'No se pudo actualizar el stock del almacén. Intenta de nuevo.',
      });
    }

    stockProductsById.set(product.id, updatedProduct);
    void persistStockProductsToDisk();
    await triggerLowStockNotificationIfNeeded(updatedProduct, product.quantity);

    const summary = getReservationMetaSummary(updatedMeta);
    const additionalComments = composeReservationCommentsWithMeta(
      parsed.plainComments,
      updatedMeta,
    );

    const updated = await updateReservationDetailsByAdmin(reservationId, {
      appointmentTypeName: summary.appointmentTypeName || reservation.appointmentTypeName,
      customerName: reservation.customerName,
      customerPhone: reservation.customerPhone,
      customerEmail: reservation.customerEmail,
      additionalComments,
    });

    if (!updated.ok) {
      if (updated.reason === 'not-found') {
        return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
      }

      return res.status(409).json({
        ok: false,
        error: 'No se pudo actualizar la reserva con el producto seleccionado.',
      });
    }

    await tryNormalizeLegacyReservationSchedule(
      {
        id: reservation.id,
        dateIso: reservation.dateIso,
        startTime: reservation.startTime,
        endTime: reservation.endTime,
        durationMinutes: reservation.durationMinutes,
      },
      {
        appointmentTypeName: summary.appointmentTypeName || reservation.appointmentTypeName,
        customerName: reservation.customerName,
        customerPhone: reservation.customerPhone,
        customerEmail: reservation.customerEmail,
        additionalComments,
      },
      {
        allowClosedSchedule: superadminSession.isSuperadmin,
        maxConcurrentReservations: getMaxConcurrentReservationsForSlot(),
      },
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error añadiendo producto de stock a reserva:', error);
    return res
      .status(500)
      .json({ ok: false, error: 'No se pudo añadir el producto a la reserva.' });
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
  const normalizedStartTime = normalizeReservationStartTimeForComparison(startTime);
  const durationMinutes = Number(req.body?.durationMinutes ?? NaN);
  const appointmentTypeName = `${req.body?.appointmentTypeName ?? ''}`.trim();
  const customerName = `${req.body?.customerName ?? ''}`.trim();
  const customerPhone = `${req.body?.customerPhone ?? ''}`.trim();
  const customerEmail = `${req.body?.customerEmail ?? ''}`.trim().toLowerCase();
  const hasAdditionalComments = Object.prototype.hasOwnProperty.call(
    req.body ?? {},
    'additionalComments',
  );
  const additionalComments = hasAdditionalComments
    ? `${req.body?.additionalComments ?? ''}`.trim().slice(0, 500)
    : undefined;

  if (!reservationId) {
    return res.status(400).json({ ok: false, error: 'ID de reserva inválido.' });
  }

  if (
    !dateIso ||
    !normalizedStartTime ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0 ||
    !appointmentTypeName ||
    !customerName ||
    !customerPhone
  ) {
    return res.status(400).json({ ok: false, error: 'Faltan datos para modificar la reserva.' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    return res.status(400).json({ ok: false, error: 'Fecha inválida. Usa formato YYYY-MM-DD.' });
  }

  if (!/^\d{2}:\d{2}$/.test(normalizedStartTime)) {
    return res.status(400).json({ ok: false, error: 'Hora inválida. Usa formato HH:mm.' });
  }

  if (customerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) {
    return res.status(400).json({ ok: false, error: 'Email de cliente inválido.' });
  }

  try {
    const reservations = await listReservationsForAdmin();
    const currentReservation = reservations.find((item) => item.id === reservationId);

    if (!currentReservation) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    const parsedCurrentMeta = parseReservationMetaFromComments(
      currentReservation.additionalComments,
    );
    const currentLinkedClientId = parsedCurrentMeta.meta?.linkedClientId ?? undefined;
    const incomingMeta =
      req.body && Object.prototype.hasOwnProperty.call(req.body, 'reservationMeta')
        ? sanitizeReservationMetaFromRequest(req.body?.reservationMeta, {
            appointmentTypeName,
            durationMinutes,
            requiresReservationSignal: Boolean(req.body?.requiresReservationSignal),
            linkedClientId: currentLinkedClientId,
          })
        : (parsedCurrentMeta.meta ??
          buildDefaultReservationMeta({
            appointmentTypeName: currentReservation.appointmentTypeName,
            durationMinutes: currentReservation.durationMinutes,
            requiresReservationSignal: requiresReservationSignalByName(
              currentReservation.appointmentTypeName,
            ),
            linkedClientId: currentLinkedClientId,
          }));

    let additionalCommentsWithMeta = additionalComments;

    if (hasAdditionalComments || req.body?.reservationMeta !== undefined) {
      additionalCommentsWithMeta = composeReservationCommentsWithMeta(
        additionalComments ?? parsedCurrentMeta.plainComments,
        incomingMeta,
      );
    }

    const currentComparableStartTime = normalizeReservationStartTimeForComparison(
      currentReservation.startTime,
    );
    const currentDurationFromRange = getDurationFromTimeRange(
      currentReservation.startTime,
      currentReservation.endTime,
    );
    const currentComparableDurationMinutes =
      currentDurationFromRange ?? currentReservation.durationMinutes;

    const isScheduleChange =
      currentReservation.dateIso !== dateIso ||
      currentComparableStartTime !== normalizedStartTime ||
      currentComparableDurationMinutes !== durationMinutes;

    if (!isScheduleChange) {
      const updatedDetails = await updateReservationDetailsByAdmin(reservationId, {
        appointmentTypeName,
        customerName,
        customerPhone,
        customerEmail,
        additionalComments: additionalCommentsWithMeta,
      });

      if (!updatedDetails.ok) {
        return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
      }

      await tryNormalizeLegacyReservationSchedule(
        {
          id: currentReservation.id,
          dateIso: currentReservation.dateIso,
          startTime: currentReservation.startTime,
          endTime: currentReservation.endTime,
          durationMinutes: currentReservation.durationMinutes,
        },
        {
          appointmentTypeName,
          customerName,
          customerPhone,
          customerEmail,
          additionalComments: additionalCommentsWithMeta,
        },
        {
          allowClosedSchedule: superadminSession.isSuperadmin,
          maxConcurrentReservations: getMaxConcurrentReservationsForSlot(),
        },
      );

      return res.status(200).json({ ok: true });
    }

    const updated = await updateReservationByAdmin(
      reservationId,
      {
        dateIso,
        startTime: normalizedStartTime,
        durationMinutes,
        appointmentTypeName,
        customerName,
        customerPhone,
        customerEmail,
        additionalComments: additionalCommentsWithMeta,
      },
      {
        allowClosedSchedule: superadminSession.isSuperadmin,
        maxConcurrentReservations: getMaxConcurrentReservationsForSlot(),
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
  const session = getAuthSession(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const currentUser = session.email ? usersByEmail.get(session.email) : null;
  const isSuperadmin = session.role === 'superadmin';
  const canCreateManualReservation =
    isSuperadmin || Boolean(currentUser?.permissions?.includes('agenda_gestionar'));

  if (!canCreateManualReservation) {
    return res.status(403).json({
      ok: false,
      error: 'No tienes permisos para crear citas manuales en agenda.',
    });
  }

  const canAssignReservationToWorker =
    isSuperadmin || Boolean(currentUser?.permissions?.includes('citas_asignar'));

  const dateIso = `${req.body?.dateIso ?? ''}`.trim();
  const time = `${req.body?.time ?? ''}`.trim();
  const durationMinutes = Number(req.body?.durationMinutes ?? NaN);
  const appointmentTypeName = `${req.body?.appointmentTypeName ?? ''}`.trim();
  const customerName = `${req.body?.customerName ?? ''}`.trim();
  const customerPhone = `${req.body?.customerPhone ?? ''}`.trim();
  const customerEmail = `${req.body?.customerEmail ?? ''}`.trim().toLowerCase();
  const createdByEmailRaw = `${req.body?.createdByEmail ?? ''}`.trim().toLowerCase();
  const requiresReservationSignal = Boolean(req.body?.requiresReservationSignal);
  const linkedClientId = `${req.body?.clientCardId ?? ''}`.trim();
  const additionalCommentsPlain = `${req.body?.additionalComments ?? ''}`.trim();

  if (
    !dateIso ||
    !time ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0 ||
    !appointmentTypeName ||
    !customerName ||
    !customerPhone
  ) {
    return res.status(400).json({ ok: false, error: 'Faltan datos para crear la reserva.' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    return res.status(400).json({ ok: false, error: 'Fecha inválida. Usa formato YYYY-MM-DD.' });
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ ok: false, error: 'Hora inválida. Usa formato HH:mm.' });
  }

  if (customerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) {
    return res.status(400).json({ ok: false, error: 'Email de cliente inválido.' });
  }

  if (createdByEmailRaw && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(createdByEmailRaw)) {
    return res.status(400).json({ ok: false, error: 'Email de trabajadora inválido.' });
  }

  const createdByEmail =
    canAssignReservationToWorker && createdByEmailRaw ? createdByEmailRaw : session.email;

  const reservationMeta = sanitizeReservationMetaFromRequest(req.body?.reservationMeta, {
    appointmentTypeName,
    durationMinutes,
    requiresReservationSignal,
    linkedClientId: linkedClientId || undefined,
  });
  const reservationMetaSummary = getReservationMetaSummary(reservationMeta);
  const resolvedDurationMinutes = Math.max(
    30,
    reservationMetaSummary.durationMinutes || durationMinutes,
  );
  const resolvedAppointmentTypeName =
    reservationMetaSummary.appointmentTypeName || appointmentTypeName;
  const shouldRequireReservationSignal =
    requiresReservationSignal ||
    reservationMetaSummary.requiresReservationSignal ||
    requiresReservationSignalByName(resolvedAppointmentTypeName);
  const additionalComments = composeReservationCommentsWithMeta(additionalCommentsPlain, {
    ...reservationMeta,
    linkedClientId: linkedClientId || reservationMeta.linkedClientId,
  });

  if (linkedClientId && !clientCardsById.has(linkedClientId)) {
    return res.status(400).json({ ok: false, error: 'La clienta seleccionada no existe.' });
  }

  if (createdByEmail) {
    const assigneeUser = usersByEmail.get(createdByEmail);

    if (!isAssignableWorkerUser(assigneeUser)) {
      return res.status(400).json({
        ok: false,
        error: 'La trabajadora asignada no existe o no es válida.',
      });
    }
  }

  try {
    const created = await createReservationWithSlots(
      {
        dateIso,
        time,
        durationMinutes: resolvedDurationMinutes,
        customerEmail,
        customerName,
        customerPhone,
        appointmentTypeName: resolvedAppointmentTypeName,
        additionalComments,
        createdByEmail,
        requiresReservationSignal: shouldRequireReservationSignal,
      },
      {
        allowClosedSchedule: isSuperadmin,
        maxConcurrentReservations: getMaxConcurrentReservationsForSlot(),
      },
    );

    if (!created.ok) {
      return res.status(409).json({
        ok: false,
        error: isSuperadmin
          ? 'No se pudo crear la reserva porque ya existe un conflicto con otra cita o bloqueo manual.'
          : 'No se pudo crear la reserva porque ese horario está cerrado o ya no está disponible.',
      });
    }

    if (!shouldRequireReservationSignal) {
      await updateReservationAdminStatus(created.reservationId, 'accepted');
    }

    let emailSent = false;
    let emailError: string | undefined;

    try {
      const apiKey = process.env['RESEND_API_KEY'];

      if (!apiKey) {
        throw new Error('RESEND_API_KEY no configurada en el servidor.');
      }

      if (apiKey.includes('xxxxxxxx')) {
        throw new Error(
          'RESEND_API_KEY tiene un valor de ejemplo. Configura la key real de Resend.',
        );
      }

      const fromEmail = process.env['RESEND_FROM_EMAIL'] ?? 'onboarding@resend.dev';
      const isValidEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail);

      if (fromEmail === 'reservas@tu-dominio.com') {
        throw new Error(
          'RESEND_FROM_EMAIL tiene un valor de ejemplo. Usa un remitente verificado en Resend.',
        );
      }

      if (!isValidEmail) {
        throw new Error(
          'RESEND_FROM_EMAIL no es válido. Debe ser un email real verificado en Resend.',
        );
      }

      if (customerEmail) {
        const provisionalHoldHours = shouldRequireReservationSignal
          ? getProvisionalReservationHoursByName(resolvedAppointmentTypeName) || 48
          : 0;

        const subject = `Confirmación de cita - ${resolvedAppointmentTypeName} (${dateIso} ${time})`;
        const html = buildReservationEmailHtml({
          customerName,
          appointmentTypeName: resolvedAppointmentTypeName,
          provisionalHoldHours,
          dateIso,
          time,
          establishmentAddress: 'C. de Castilla, 4, 28320 Pinto, Madrid',
          establishmentPhone: '919521611',
          bizumPhone: '614716238',
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

        emailSent = true;
      }
    } catch (sendEmailError) {
      emailError =
        sendEmailError instanceof Error
          ? sendEmailError.message
          : 'No se pudo enviar el email de confirmación.';
      console.error('Error enviando email en reserva creada desde agenda admin:', sendEmailError);
    }

    return res.status(200).json({
      ok: true,
      reservationId: created.reservationId,
      emailSent,
      ...(emailError ? { emailError } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo crear la reserva.';

    if (message.includes('La hora seleccionada no es válida.')) {
      return res.status(400).json({ ok: false, error: message });
    }

    console.error('Error creando reserva manual admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo crear la reserva.' });
  }
});

app.post('/api/admin/reservas/:id/senal', async (req, res) => {
  seedAuthUsers();
  const session = getAuthSession(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const reservationId = `${req.params['id'] ?? ''}`.trim();
  const paymentMethod = `${req.body?.paymentMethod ?? ''}`.trim() as
    | 'efectivo'
    | 'tarjeta'
    | 'bizum';
  const amount = Number(req.body?.amount ?? 20);

  if (!reservationId) {
    return res.status(400).json({ ok: false, error: 'ID de reserva inválido.' });
  }

  if (!['efectivo', 'tarjeta', 'bizum'].includes(paymentMethod)) {
    return res
      .status(400)
      .json({ ok: false, error: 'Método de pago inválido. Usa efectivo, tarjeta o bizum.' });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ ok: false, error: 'Importe de señal inválido.' });
  }

  const reservations = await listReservationsForAdmin();
  const reservation = reservations.find((r) => r.id === reservationId);

  if (!reservation) {
    return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const signalRegistered = await registerReservationSignalPayment(reservationId, {
    amountEuro: Number(amount.toFixed(2)),
    paymentMethod,
    receivedAtIso: new Date().toISOString(),
    registeredByEmail: session.email,
  });

  if (!signalRegistered.ok) {
    if (signalRegistered.reason === 'not-found') {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    return res.status(200).json({
      ok: true,
      alreadyRecorded: true,
    });
  }

  const concept = `Señal cita: ${reservation.customerName} · ${reservation.appointmentTypeName} · ${reservation.dateIso} ${reservation.startTime}`;

  addPaymentToDailySummary(todayIso, paymentMethod, amount, {
    operationType: 'reservation_payment',
    concept,
    performedByEmail: session.email ?? '',
  });

  return res.status(200).json({ ok: true });
});

app.patch('/api/admin/reservas/:id/assign', async (req, res) => {
  const session = getAuthSession(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const currentUser = session.email ? usersByEmail.get(session.email) : null;
  const canAssignReservations =
    session.role === 'superadmin' || Boolean(currentUser?.permissions?.includes('citas_asignar'));

  if (!canAssignReservations) {
    return res.status(403).json({ ok: false, error: 'No tienes permisos para asignar citas.' });
  }

  const reservationId = `${req.params['id'] ?? ''}`.trim();
  const assigneeEmail = normalizeWorkerEmail(req.body?.assigneeEmail);

  if (!reservationId || !assigneeEmail) {
    return res.status(400).json({ ok: false, error: 'Debes indicar la cita y la trabajadora.' });
  }

  const assigneeUser = usersByEmail.get(assigneeEmail);

  if (!isAssignableWorkerUser(assigneeUser)) {
    return res.status(400).json({ ok: false, error: 'La trabajadora seleccionada no es válida.' });
  }

  try {
    const updated = await assignReservationToWorker(reservationId, assigneeEmail);

    if (!updated.ok) {
      if (updated.reason === 'not-found') {
        return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
      }

      return res.status(409).json({
        ok: false,
        error: 'La trabajadora seleccionada ya tiene otra cita en esa franja.',
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error asignando reserva a trabajadora:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo asignar la cita.' });
  }
});

app.patch('/api/admin/reservas/:id/status', async (req, res) => {
  const session = getAuthSession(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const currentUser = session.email ? usersByEmail.get(session.email) : null;
  const canManageReservations =
    session.role === 'superadmin' ||
    Boolean(currentUser?.permissions?.includes('reservas_gestionar'));

  if (!canManageReservations) {
    return res
      .status(403)
      .json({ ok: false, error: 'No tienes permisos para confirmar o cancelar reservas.' });
  }

  const reservationId = `${req.params['id'] ?? ''}`;
  const status = `${req.body?.status ?? ''}` as AdminReservationStatus;
  const requestedAssigneeEmail = normalizeWorkerEmail(req.body?.assigneeEmail);
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

    const maxConcurrentReservations = getMaxConcurrentReservationsForSlot();
    const currentAssigneeEmail = normalizeWorkerEmail(reservation.createdByEmail);
    const targetAssigneeEmail = requestedAssigneeEmail || currentAssigneeEmail;

    if (status === 'accepted' && !targetAssigneeEmail) {
      return res.status(409).json({
        ok: false,
        error: 'Antes de confirmar, debes asignar esta cita a una trabajadora.',
      });
    }

    if (status === 'accepted' && targetAssigneeEmail) {
      const assigneeUser = usersByEmail.get(targetAssigneeEmail);

      if (!isAssignableWorkerUser(assigneeUser)) {
        return res.status(400).json({
          ok: false,
          error: 'La trabajadora asignada no existe o no tiene rol válido.',
        });
      }

      const assigningAnotherWorker =
        Boolean(requestedAssigneeEmail) &&
        requestedAssigneeEmail !== normalizeWorkerEmail(session.email);

      const canAssignToOthers =
        session.role === 'superadmin' ||
        Boolean(currentUser?.permissions?.includes('citas_asignar'));

      if (assigningAnotherWorker && !canAssignToOthers) {
        return res.status(403).json({
          ok: false,
          error: 'No tienes permisos para asignar citas a otras trabajadoras.',
        });
      }
    }

    const updated = await updateReservationAdminStatus(reservationId, status, {
      maxConcurrentReservations,
      assigneeEmail: status === 'accepted' ? targetAssigneeEmail : undefined,
    });

    if (!updated.ok) {
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
        await createNotificationAndBroadcast({
          type: 'reserva_confirmada',
          title: `Reserva confirmada: ${reservation.appointmentTypeName}`,
          message: `Reserva de ${reservation.customerName} confirmada para ${reservation.dateIso} a las ${reservation.startTime}`,
          relatedId: reservationId,
          actionUrl: `/admin/reservas?id=${reservationId}`,
        });
      } catch (notifError) {
        console.error('Error creating confirmation notification:', notifError);
      }

      await notifyAcceptedReservation({
        customerEmail: reservation.customerEmail,
        customerName: reservation.customerName,
        customerPhone: reservation.customerPhone,
        appointmentTypeName: reservation.appointmentTypeName,
        dateIso: reservation.dateIso,
        startTime: reservation.startTime,
      });
    } else if (status === 'rejected') {
      try {
        await createNotificationAndBroadcast({
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
    const slots = await getAvailableSlotsForDate(
      dateIso,
      durationMinutes,
      getMaxConcurrentReservationsForSlot(),
    );

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
      await createNotificationAndBroadcast({
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
  const shouldRequireReservationSignal =
    Boolean(requiresReservationSignal) ||
    requiresReservationSignalByName(`${appointmentTypeName ?? ''}`);
  const provisionalHoldHours = shouldRequireReservationSignal
    ? getProvisionalReservationHoursByName(`${appointmentTypeName ?? ''}`) || 48
    : 0;

  try {
    const created = await createReservationWithSlots(
      {
        dateIso,
        time,
        durationMinutes: Number(durationMinutes),
        customerEmail,
        customerName,
        customerPhone,
        appointmentTypeName,
        requiresReservationSignal: shouldRequireReservationSignal,
      },
      {
        maxConcurrentReservations: getMaxConcurrentReservationsForSlot(),
      },
    );

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
      await createNotificationAndBroadcast({
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
      appointmentTypeName,
      provisionalHoldHours,
      dateIso,
      time,
      establishmentAddress,
      establishmentPhone,
      bizumPhone: '614716238',
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

// ============================================================================
// API Endpoints: Notificaciones (Solo para admin/superadmin)
// Deben registrarse antes del catch-all de Angular.
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
 * GET /api/notifications/stream - SSE para refrescar el badge de notificaciones
 */
app.get('/api/notifications/stream', (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`retry: 10000\n\n`);

  notificationStreamClients.add(res);

  req.on('close', () => {
    notificationStreamClients.delete(res);
  });

  return;
});

/**
 * POST /api/notifications - Crea una nueva notificación
 */
app.post('/api/notifications', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const { type, title, message, relatedId, actionUrl } = req.body ?? {};

  if (!type || !title || !message) {
    return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios.' });
  }

  try {
    const notification = await createNotificationAndBroadcast({
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
    broadcastNotificationsRefresh();
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
    broadcastNotificationsRefresh();
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
    broadcastNotificationsRefresh();
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
    broadcastNotificationsRefresh();
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error clearing read notifications:', error);
    return res.status(500).json({ ok: false, error: 'Error al eliminar notificaciones leídas.' });
  }
});

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

const initializeFromDb = async (): Promise<void> => {
  let dbUsersCount = 0;
  let dbCardsCount = 0;
  let dbStockProductsCount = 0;
  let dbCierresCount = 0;
  let dbDailyPaymentsCount = 0;

  console.log(`[persistencia] objetivo_db=${getDatabaseTargetLabel()}`);

  try {
    const integrationsPool = getDatabasePoolForIntegrations();
    if (integrationsPool) {
      setNotificationsPool(integrationsPool);
      await initializeNotificationsSchema(integrationsPool);
      notificationsDegradedMode = false;
    } else {
      notificationsDegradedMode = true;
      console.warn('Sistema de notificaciones sin pool de DB. Modo degradado activo.');
    }
  } catch (error) {
    console.error('Error inicializando notificaciones sobre PostgreSQL:', error);
    notificationsDegradedMode = true;
    console.warn(
      'Continuando en modo degradado: sistema de notificaciones no disponible temporalmente.',
    );
  }

  try {
    const [dbUsers, dbCards, dbStockProducts, dbCierres, dbDailyPayments] = await Promise.all([
      loadAllUsersFromDb(),
      loadAllClientCardsFromDb(),
      loadAllStockProductsFromDb(),
      loadAllCierresFromDb(),
      loadAllDailyPaymentsFromDb(),
    ]);

    dbUsersCount = dbUsers.length;
    dbCardsCount = dbCards.length;
    dbStockProductsCount = dbStockProducts.length;
    dbCierresCount = dbCierres.length;
    dbDailyPaymentsCount = dbDailyPayments.length;

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
        permissions: normalizeEmployeePermissions(dbUser.permissions),
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

    for (const dbProduct of dbStockProducts) {
      const product: StockProductItem = {
        id: dbProduct.id,
        productName: dbProduct.productName,
        brand: dbProduct.brand,
        quantity: dbProduct.quantity,
        price: dbProduct.price,
        color: dbProduct.color,
        isSellable: dbProduct.isSellable,
        createdAtIso: dbProduct.createdAtIso,
        createdByEmail: dbProduct.createdByEmail,
      };
      stockProductsById.set(product.id, normalizeStockProduct(product));
    }

    for (const dbCierre of dbCierres) {
      const cierre: CierreCajaItem = {
        id: dbCierre.id,
        fechaIso: dbCierre.fechaIso,
        efectivo: dbCierre.efectivo,
        tarjeta: dbCierre.tarjeta,
        bizum: dbCierre.bizum,
        total: dbCierre.total,
        notas: dbCierre.notas,
        registradoPorEmail: dbCierre.registradoPorEmail,
        createdAtIso: dbCierre.createdAtIso,
        enviadoAlServicioFiscal: dbCierre.enviadoAlServicioFiscal,
        idServicioFiscal: dbCierre.idServicioFiscal,
        operationDetails: normalizePaymentOperationDetails(dbCierre.operationDetails),
      };
      cierreCajaById.set(cierre.id, normalizeCierre(cierre));
    }

    for (const dbDailyPayment of dbDailyPayments) {
      const summary: DailyPaymentSummaryItem = {
        dateIso: dbDailyPayment.dateIso,
        efectivo: dbDailyPayment.efectivo,
        tarjeta: dbDailyPayment.tarjeta,
        bizum: dbDailyPayment.bizum,
        total: dbDailyPayment.total,
        updatedAtIso: dbDailyPayment.updatedAtIso,
        operationDetails: normalizePaymentOperationDetails(dbDailyPayment.operationDetails),
      };
      dailyPaymentsByDateIso.set(summary.dateIso, normalizeDailyPaymentSummary(summary));
    }

    if (
      dbUsers.length > 0 ||
      dbCards.length > 0 ||
      dbStockProducts.length > 0 ||
      dbCierres.length > 0 ||
      dbDailyPayments.length > 0
    ) {
      console.log(
        `DB: ${dbUsers.length} usuario(s), ${dbCards.length} ficha(s), ${dbStockProducts.length} producto(s), ${dbCierres.length} cierre(s) y ${dbDailyPayments.length} acumulado(s) diarios cargados.`,
      );
    }
  } catch (error) {
    console.warn('No se pudo cargar datos desde DB en arranque. Modo memoria activo.', error);
  }

  const diskUsers = await loadUsersFromDisk();
  const diskCards = await loadClientCardsFromDisk();
  const diskStockProducts = await loadStockProductsFromDisk();
  const diskStockSales = await loadStockSalesFromDisk();
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

  for (const sale of diskStockSales) {
    if (!stockSalesById.has(sale.id)) {
      stockSalesById.set(sale.id, normalizeStockSale(sale));
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
    diskStockSales.length > 0 ||
    diskCierres.length > 0 ||
    diskDailyPayments.length > 0
  ) {
    console.log(
      `DISK: ${diskUsers.length} usuario(s), ${diskCards.length} ficha(s) de cliente, ${diskStockProducts.length} producto(s) de almacén, ${diskStockSales.length} venta(s) de stock, ${diskCierres.length} cierre(s) y ${diskDailyPayments.length} acumulado(s) diario(s) de cobros cargados.`,
    );
  }

  syncAdminOwnerEmailFromUsers();

  if (dbUsersCount === 0 && usersByEmail.size > 0) {
    void persistUsersToDisk();
  }

  if (dbCardsCount === 0 && clientCardsById.size > 0) {
    void persistClientCardsToDisk();
  }

  if (dbStockProductsCount === 0 && stockProductsById.size > 0) {
    void persistStockProductsToDisk();
  }

  if (dbCierresCount === 0 && cierreCajaById.size > 0) {
    void persistCierreCajaToDisk();
  }

  if (dbDailyPaymentsCount === 0 && dailyPaymentsByDateIso.size > 0) {
    void persistDailyPaymentsToDisk();
  }

  if (stockProductsById.size > 0) {
    void persistStockProductsToDisk();
  }

  if (stockSalesById.size > 0) {
    void persistStockSalesToDisk();
  }

  if (cierreCajaById.size > 0) {
    void persistCierreCajaToDisk();
  }

  if (dailyPaymentsByDateIso.size > 0) {
    void persistDailyPaymentsToDisk();
  }
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const initializeFromDbWithRetry = async (
  maxAttempts: number,
  retryDelayMs: number,
): Promise<void> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await initializeFromDb();

      if (attempt > 1) {
        console.log(
          `[persistencia] inicializacion completada en intento ${attempt}/${maxAttempts}`,
        );
      }

      return;
    } catch (error) {
      lastError = error;
      console.error(
        `[persistencia] fallo de inicializacion intento ${attempt}/${maxAttempts}:`,
        error,
      );

      if (attempt < maxAttempts) {
        await wait(retryDelayMs);
      }
    }
  }

  throw lastError ?? new Error('Fallo desconocido al inicializar persistencia.');
};

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
  const allowMemoryFallback = process.env['ALLOW_MEMORY_RESERVAS_FALLBACK'] === 'true';
  const initMaxAttemptsRaw = Number(process.env['DB_INIT_MAX_ATTEMPTS'] ?? '3');
  const initRetryDelayMsRaw = Number(process.env['DB_INIT_RETRY_DELAY_MS'] ?? '1500');
  const initMaxAttempts =
    Number.isFinite(initMaxAttemptsRaw) && initMaxAttemptsRaw > 0
      ? Math.trunc(initMaxAttemptsRaw)
      : 3;
  const initRetryDelayMs =
    Number.isFinite(initRetryDelayMsRaw) && initRetryDelayMsRaw >= 0
      ? Math.trunc(initRetryDelayMsRaw)
      : 1500;

  console.log(
    `[persistencia] fallback_memoria=${allowMemoryFallback ? 'activo' : 'desactivado'} | node_env=${process.env['NODE_ENV'] ?? 'undefined'}`,
  );

  const startServer = (): void => {
    seedAuthUsers();
    startReservationReminderScheduler();
    app.listen(port, (error) => {
      if (error) {
        throw error;
      }

      console.log(`Node Express server listening on http://localhost:${port}`);
    });
  };

  initializeFromDbWithRetry(initMaxAttempts, initRetryDelayMs)
    .then(() => {
      startServer();
    })
    .catch((error) => {
      console.error('Error en inicialización desde DB:', error);

      if (!allowMemoryFallback) {
        console.error(
          'Abortando arranque para evitar inconsistencias de persistencia. Define ALLOW_MEMORY_RESERVAS_FALLBACK=true solo para desarrollo temporal.',
        );
        return;
      }

      console.warn('Continuando con fallback de memoria por configuración explícita.');
      startServer();
    });
}

export const reqHandler = createNodeRequestHandler(app);
