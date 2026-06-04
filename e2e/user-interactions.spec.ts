import { expect, test, type Page } from '@playwright/test';

type ClientSessionResponse = {
  ok: boolean;
  isAuthenticated: boolean;
  client: {
    id: string;
    fullName: string;
    email: string;
    phone: string;
  } | null;
};

async function loginClientViaApi(page: Page, email: string, password: string): Promise<void> {
  const loginResponse = await page.request.post('/api/cliente/login', {
    data: {
      identity: email,
      password,
    },
  });

  expect(loginResponse.ok()).toBeTruthy();
  const body = (await loginResponse.json()) as { ok: boolean; error?: string };
  expect(body.ok).toBeTruthy();
}

test.describe('Interaccion usuario: alta, login, alertas y reservas', () => {
  test('alta de usuario cliente + login en area cliente + logout', async ({ page }) => {
    const uid = Date.now().toString();
    const email = `cliente.alta.${uid}@example.com`;
    const password = 'Cliente-123!';

    await page.goto('/cliente/registro');
    await page.getByLabel('Nombre').fill('Cliente');
    await page.getByLabel('Apellidos').fill(`E2E ${uid.slice(-4)}`);
    await page.getByLabel('Número de teléfono').fill('600111222');
    await page.getByLabel('Fecha de nacimiento').fill('1995-03-10');
    await page.getByLabel('Email').fill(email);
    await page.locator('input[formControlName="password"]').fill(password);
    await page.locator('input[formControlName="confirmPassword"]').fill(password);
    await page.getByRole('button', { name: 'Crear cuenta' }).click();

    await expect(page.getByText('¡Registro completado! Redirigiendo a acceso...')).toBeVisible({
      timeout: 10_000,
    });

    await loginClientViaApi(page, email, password);

    const sessionResponse = await page.request.get('/api/cliente/session');
    expect(sessionResponse.ok()).toBeTruthy();
    const sessionBody = (await sessionResponse.json()) as ClientSessionResponse;
    expect(sessionBody.ok).toBeTruthy();

    const logoutResponse = await page.request.post('/api/cliente/logout', { data: {} });
    expect(logoutResponse.ok()).toBeTruthy();
  });

  test('usuario crea alerta avisame y la elimina desde area cliente', async ({ page }) => {
    const uid = Date.now().toString();
    const email = `cliente.alerta.${uid}@example.com`;
    const password = 'Cliente-123!';

    const registerResponse = await page.request.post('/api/cliente/registro', {
      data: {
        nombre: 'Cliente',
        apellidos: `Alerta ${uid.slice(-4)}`,
        fechaNacimiento: '1998-02-15',
        telefono: '600222333',
        email,
        password,
      },
    });
    expect(registerResponse.ok()).toBeTruthy();

    await loginClientViaApi(page, email, password);

    const dateIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const createAlertResponse = await page.request.post('/api/cliente/alertas', {
      data: {
        dateIso,
        startTime: '10:00',
        endTime: '11:00',
        appointmentTypeName: 'Pack Corte',
      },
    });
    expect(createAlertResponse.ok()).toBeTruthy();

    const createAlertBody = (await createAlertResponse.json()) as {
      ok: boolean;
      alert?: { id: string };
      error?: string;
    };
    expect(createAlertBody.ok).toBeTruthy();

    const listAlertsResponse = await page.request.get('/api/cliente/alertas');
    expect(listAlertsResponse.ok()).toBeTruthy();
    const listAlertsBody = (await listAlertsResponse.json()) as {
      ok: boolean;
      alerts?: Array<{ id: string }>;
    };
    expect(listAlertsBody.ok).toBeTruthy();
    expect(
      listAlertsBody.alerts?.some((alert) => alert.id === createAlertBody.alert?.id),
    ).toBeTruthy();

    const deleteAlertResponse = await page.request.delete(
      `/api/cliente/alertas/${encodeURIComponent(createAlertBody.alert?.id ?? '')}`,
    );
    expect(deleteAlertResponse.ok()).toBeTruthy();

    const afterDeleteResponse = await page.request.get('/api/cliente/alertas');
    expect(afterDeleteResponse.ok()).toBeTruthy();
    const afterDeleteBody = (await afterDeleteResponse.json()) as {
      ok: boolean;
      alerts?: Array<{ id: string }>;
    };
    expect(afterDeleteBody.ok).toBeTruthy();
    expect(
      afterDeleteBody.alerts?.some((alert) => alert.id === createAlertBody.alert?.id),
    ).toBeFalsy();
  });

  test('interaccion de reserva: seleccion de pack y llegada a calendario', async ({ page }) => {
    await page.goto('/reservas');
    await expect(page.locator('.citas--container__card').first()).toBeVisible({ timeout: 10_000 });

    await page.locator('.citas--container__card').first().click();
    await page.locator('.citas--container__button--primary').first().click();

    await expect(page).toHaveURL(/\/reservas\/calendario/, { timeout: 10_000 });
    await expect(page.locator('button[aria-label="Paso 1: Servicio"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Paso 2: Día"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Paso 3: Hora"]')).toBeVisible();
  });
});
