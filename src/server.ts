import 'dotenv/config';
import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Resend } from 'resend';
import {
  AdminReservationStatus,
  createBlockedPeriodForAdmin,
  createReservationWithSlots,
  deleteBlockedPeriodForAdmin,
  deleteReservationById,
  getAvailableSlotsForDate,
  listBlockedPeriodsForAdmin,
  listReservationsForAdmin,
  updateReservationAdminStatus,
  updateReservationPaymentReceived,
} from './shared/reservas-db';

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
const adminOwnerEmail =
  process.env['ADMIN_OWNER_EMAIL']?.trim().toLowerCase() ?? 'ferperezsanchez@gmail.com';
const adminMagicSecret = process.env['ADMIN_MAGIC_SECRET'] ?? process.env['RESEND_API_KEY'] ?? '';
const adminCookieName = 'arena_admin_session';
const authCookieName = 'arena_auth_session';
const authSessionSecret =
  process.env['AUTH_SESSION_SECRET']?.trim() || adminMagicSecret.trim() || 'arena-dev-auth-secret';
const adminEmployeeEmails = new Set(
  (process.env['ADMIN_EMPLOYEE_EMAILS'] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

type AppUserRole = 'superadmin' | 'admin' | 'client';

interface AppUser {
  id: string;
  email: string;
  username: string;
  usernameLower: string;
  passwordHash: string;
  role: AppUserRole;
  createdAtIso: string;
}

interface AppSession {
  isAuthenticated: boolean;
  isAdmin: boolean;
  email: string;
  username: string;
  role: AppUserRole | '';
}

const usersByEmail = new Map<string, AppUser>();
const usersByUsername = new Map<string, AppUser>();
let authSeeded = false;

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
};

const seedAuthUsers = (): void => {
  if (authSeeded) {
    return;
  }

  authSeeded = true;

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
  });
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
        return {
          isAuthenticated: true,
          isAdmin: user.role === 'admin' || user.role === 'superadmin',
          email: user.email,
          username: user.username,
          role: user.role,
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

  return res.status(200).json({
    ok: true,
    isAuthenticated: session.isAuthenticated,
    isAdmin: session.isAdmin,
    email: session.email,
    username: session.username,
    role: session.role,
  });
});

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearAuthCookies());

  return res.status(200).json({ ok: true });
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
    const sendResult = await resend.emails.send({
      from: fromEmail,
      to: email,
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

app.get('/api/admin/reservas', async (req, res) => {
  const session = isAdminRequest(req.headers.cookie);

  if (!session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  try {
    const reservations = await listReservationsForAdmin();
    return res.status(200).json({ ok: true, reservations });
  } catch (error) {
    console.error('Error listando reservas admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron listar las reservas.' });
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
          error: 'Rango horario inválido. Usa tramos de 30 min entre 09:00 y 20:00.',
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

  if (!reservationId) {
    return res.status(400).json({ ok: false, error: 'ID de reserva inválido.' });
  }

  try {
    const updated = await updateReservationPaymentReceived(reservationId, paymentReceived);

    if (!updated.ok) {
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error actualizando pago de reserva:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo actualizar el pago.' });
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
    const updated = await updateReservationAdminStatus(reservationId, status);

    if (!updated.ok) {
      if (updated.reason === 'payment-required') {
        return res.status(409).json({
          ok: false,
          error: 'No puedes aceptar/rechazar sin marcar pago recibido.',
        });
      }

      return res.status(404).json({ ok: false, error: 'Reserva no encontrada.' });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error actualizando estado de reserva:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo actualizar el estado.' });
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
    dateIso,
    time,
    durationMinutes,
    establishmentAddress,
    establishmentPhone,
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
      return res.status(409).json({
        ok: false,
        error: 'Esa hora ya no está disponible. Elige otra.',
      });
    }

    reservationId = created.reservationId;

    const subject = `Confirmación de cita - ${appointmentTypeName} (${dateIso} ${time})`;
    const html = buildReservationEmailHtml({
      customerName,
      customerPhone,
      appointmentTypeName,
      dateIso,
      time,
      establishmentAddress,
      establishmentPhone,
    });

    const resend = new Resend(apiKey);
    const sendResult = await resend.emails.send({
      from: fromEmail,
      to: customerEmail,
      subject,
      html,
    });

    if (sendResult.error) {
      throw new Error(sendResult.error.message || 'Resend rechazó el envío del email.');
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

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
