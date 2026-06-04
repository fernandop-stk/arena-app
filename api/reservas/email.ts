import { Resend } from 'resend';
import { createReservationWithSlots, deleteReservationById } from '../../src/shared/reservas-db';

declare const process: {
  env: Record<string, string | undefined>;
};

interface ReservationEmailPayload {
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  appointmentTypeName: string;
  dateIso: string;
  time: string;
  durationMinutes: number;
  establishmentAddress: string;
  establishmentPhone: string;
}

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
  dateIso: string;
  time: string;
  establishmentAddress: string;
  establishmentPhone: string;
}): string => {
  const customerName = escapeHtml(data.customerName);
  const customerPhone = escapeHtml(data.customerPhone);
  const appointmentTypeName = escapeHtml(data.appointmentTypeName);
  const dateIso = escapeHtml(data.dateIso);
  const time = escapeHtml(data.time);
  const establishmentAddress = escapeHtml(data.establishmentAddress);
  const establishmentPhone = escapeHtml(data.establishmentPhone);

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
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Fecha</strong><br><span style="color:#7a675d;">${dateIso}</span></td>
              </tr>
              <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #e8d8c9;font-size:14px;"><strong>Hora</strong><br><span style="color:#7a675d;">${time}</span></td>
              </tr>
              <tr>
                <td style="padding:14px 16px;font-size:14px;"><strong>Teléfono de contacto</strong><br><span style="color:#7a675d;">${customerPhone}</span></td>
              </tr>
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

export const buildAlertCoveredEmailHtml = (data: {
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

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev';
  const isValidEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail);

  if (!apiKey) {
    res.status(500).json({ ok: false, error: 'RESEND_API_KEY no configurada en Vercel.' });
    return;
  }

  if (!isValidEmail) {
    res.status(500).json({
      ok: false,
      error:
        'RESEND_FROM_EMAIL no es válido. Debe ser un email real verificado en Resend (por ejemplo, reservas@tu-dominio.com).',
    });
    return;
  }

  const {
    customerEmail,
    customerName,
    customerPhone,
    appointmentTypeName,
    dateIso,
    time,
    durationMinutes,
    establishmentAddress,
    establishmentPhone,
  } = (req.body ?? {}) as ReservationEmailPayload;

  if (
    !customerEmail ||
    !customerName ||
    !customerPhone ||
    !appointmentTypeName ||
    !dateIso ||
    !time ||
    !durationMinutes
  ) {
    res.status(400).json({ ok: false, error: 'Faltan datos obligatorios para enviar el email.' });
    return;
  }

  let reservationId = '';

  try {
    const created = await createReservationWithSlots({
      dateIso,
      time,
      durationMinutes: Number(durationMinutes),
      customerEmail,
      customerName,
      customerPhone,
      appointmentTypeName,
    });

    if (!created.ok) {
      res.status(409).json({ ok: false, error: 'Esa hora ya no está disponible. Elige otra.' });
      return;
    }

    reservationId = created.reservationId;

    const resend = new Resend(apiKey);

    const html = buildReservationEmailHtml({
      customerName,
      customerPhone,
      appointmentTypeName,
      dateIso,
      time,
      establishmentAddress,
      establishmentPhone,
    });

    const sendResult = await resend.emails.send({
      from: fromEmail,
      to: customerEmail,
      subject: `Confirmación de cita - ${appointmentTypeName} (${dateIso} ${time})`,
      html,
    });

    if (sendResult.error) {
      throw new Error(sendResult.error.message || 'Resend rechazó el envío del email.');
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    if (reservationId) {
      await deleteReservationById(reservationId);
    }

    console.error('Error enviando email con Resend (Vercel):', error);
    res.status(500).json({ ok: false, error: 'No se pudo enviar el email.' });
  }
}
