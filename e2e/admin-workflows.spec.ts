import { test, expect, Page } from '@playwright/test';
import { loginAsAdmin, waitForAngularReady } from './helpers';

const SUPERADMIN_EMAIL = 'ferperezsanchez@gmail.com';
const SUPERADMIN_PASSWORD = 'Hair-studio';

type AdminReservationItem = {
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
};

async function loginSuperadmin(page: Page): Promise<void> {
  await loginAsAdmin(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });
  await waitForAngularReady(page);
}

async function openAdminModule(page: Page, moduleName: string): Promise<void> {
  const backToPanel = page.getByRole('button', { name: /Volver al panel/i });
  if (
    await backToPanel
      .last()
      .isVisible()
      .catch(() => false)
  ) {
    await backToPanel.last().click();
    await waitForAngularReady(page);
  }

  await page
    .locator('.admin-panel--container__module-card')
    .filter({ hasText: moduleName })
    .first()
    .click();
  await waitForAngularReady(page);
}

async function getReservations(page: Page): Promise<AdminReservationItem[]> {
  const response = await page.request.get('/api/admin/reservas');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    ok: boolean;
    reservations?: AdminReservationItem[];
  };
  expect(body.ok).toBeTruthy();
  return body.reservations ?? [];
}

async function createClientViaUi(page: Page, uniqueSuffix: string): Promise<string> {
  const fullName = `Cliente E2E ${uniqueSuffix}`;
  const email = `cliente.e2e.${uniqueSuffix}@example.com`;

  await openAdminModule(page, 'Ficha de cliente');
  await page.getByRole('button', { name: 'Crear cliente' }).click();
  await page.getByLabel('Nombre completo').fill(fullName);
  await page.getByLabel('Email').first().fill(email);
  await page.getByLabel('Teléfono').first().fill('600123123');
  await page.getByLabel('Fecha de nacimiento').first().fill('1990-01-01');
  await page.getByLabel('Observaciones (opcional)').fill('Cliente creado por E2E');
  await page.getByRole('button', { name: 'Crear ficha de cliente' }).click();
  await expect(page.locator('text=Ficha de cliente creada correctamente.')).toBeVisible({
    timeout: 10_000,
  });

  return fullName;
}

async function payClientTreatmentByMethod(
  page: Page,
  clientName: string,
  treatmentName: string,
  methodLabel: 'Efectivo' | 'Tarjeta' | 'Bizum',
): Promise<void> {
  await openAdminModule(page, 'Ficha de cliente');
  await page.getByRole('button', { name: 'Listado resumido' }).click();

  const clientRow = page
    .locator('.client-summary-list__row')
    .filter({ hasText: clientName })
    .first();
  await expect(clientRow).toBeVisible({ timeout: 10_000 });
  await clientRow.getByRole('button', { name: 'Ver ficha' }).click();

  await page.getByRole('combobox', { name: 'Tratamiento' }).selectOption(treatmentName);
  await page.getByRole('button', { name: 'Añadir tratamiento' }).click();

  await page.getByRole('button', { name: /Cobrar pago/i }).click();
  await expect(page.locator('.payment-flow__row').first()).toBeVisible({ timeout: 10_000 });
  await page.locator('.payment-flow__row').first().click();

  await page.getByRole('button', { name: new RegExp(methodLabel, 'i') }).click();
  await page.getByRole('button', { name: /Confirmar pago/i }).click();

  await expect(page.locator('.payment-flow__backdrop')).toHaveCount(0, { timeout: 10_000 });
  await page.goto('/admin');
  await waitForAngularReady(page);
}

async function seedPaidTreatmentForStats(page: Page, uniqueSuffix: string): Promise<void> {
  const email = `stats.e2e.${uniqueSuffix}@example.com`;
  const createClientResponse = await page.request.post('/api/admin/clientes', {
    data: {
      fullName: `Cliente Stats ${uniqueSuffix}`,
      email,
      phone: '600123456',
      birthDateIso: '1991-01-01',
      notes: 'Seed stats e2e',
    },
  });
  expect(createClientResponse.ok()).toBeTruthy();

  const createClientBody = (await createClientResponse.json()) as {
    ok: boolean;
    card?: { id: string };
  };
  expect(createClientBody.ok).toBeTruthy();

  const clientId = createClientBody.card?.id;
  expect(clientId).toBeTruthy();

  const addTreatmentResponse = await page.request.post(`/api/admin/clientes/${clientId}/packs`, {
    data: {
      name: 'Pack Color',
      note: 'Seed tratamiento stats',
    },
  });
  expect(addTreatmentResponse.ok()).toBeTruthy();

  const addTreatmentBody = (await addTreatmentResponse.json()) as {
    ok: boolean;
    card?: { treatments?: Array<{ id: string }> };
  };
  expect(addTreatmentBody.ok).toBeTruthy();

  const treatmentId = addTreatmentBody.card?.treatments?.[0]?.id;
  expect(treatmentId).toBeTruthy();

  const payResponse = await page.request.patch(
    `/api/admin/clientes/${clientId}/packs/${treatmentId}/payment`,
    {
      data: {
        priceEuro: 54,
        paymentMethod: 'tarjeta',
      },
    },
  );
  expect(payResponse.ok()).toBeTruthy();

  const payBody = (await payResponse.json()) as { ok: boolean };
  expect(payBody.ok).toBeTruthy();
}

async function seedCierreForStats(page: Page, uniqueSuffix: string): Promise<void> {
  const cierreResponse = await page.request.post('/api/admin/cierre-caja', {
    data: {
      efectivo: 18,
      tarjeta: 37,
      bizum: 25,
      notas: `Seed cierre stats ${uniqueSuffix}`,
    },
  });
  expect(cierreResponse.ok()).toBeTruthy();

  const cierreBody = (await cierreResponse.json()) as { ok: boolean };
  expect(cierreBody.ok).toBeTruthy();
}

test.describe('Admin workflows pendientes (almacen, reservas, cobros, cierre)', () => {
  test.beforeEach(async ({ page }) => {
    await loginSuperadmin(page);
  });

  test('Almacen: anadir producto y ajustar cantidad (+/-)', async ({ page }) => {
    const uid = Date.now().toString().slice(-6);
    const productName = `E2E Producto ${uid}`;

    await openAdminModule(page, 'Almacén');
    await expect(page.getByRole('heading', { name: 'Almacén' })).toBeVisible();

    await page.getByLabel('Nombre del producto').fill(productName);
    await page.getByLabel('Marca').fill('Arena Test');
    await page.getByLabel('Cantidad').fill('3');
    await page.getByLabel('Precio').fill('12.5');
    await page.getByLabel('Color').fill('Test');
    await page.getByRole('button', { name: 'Guardar producto' }).click();

    await expect(page.locator('text=Producto añadido correctamente.')).toBeVisible();

    await page.getByRole('button', { name: 'Ver stock' }).click();
    const row = page
      .locator('.admin-panel--container__reservation')
      .filter({ hasText: productName })
      .first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    const qty = row.locator('.admin-panel--container__stock-qty-value');
    await expect(qty).toHaveText('3');

    await row.locator('button[title="Restar 1"]').click();
    await expect(qty).toHaveText('2');

    await row.locator('button[title="Sumar 1"]').click();
    await expect(qty).toHaveText('3');
  });

  test('Reservas: reprogramar y cambiar duracion por API admin', async ({ page }) => {
    const reservations = await getReservations(page);
    test.skip(reservations.length === 0, 'No hay reservas disponibles para reprogramar.');

    const target =
      reservations.find((reservation) => reservation.startTime === '10:00') ?? reservations[0];

    const rebookDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const updateResponse = await page.request.patch(`/api/admin/reservas/${target.id}`, {
      data: {
        dateIso: rebookDate,
        startTime: '09:00',
        durationMinutes: 90,
        appointmentTypeName: target.appointmentTypeName,
        customerName: target.customerName,
        customerPhone: target.customerPhone,
        customerEmail: target.customerEmail,
      },
    });

    expect(updateResponse.ok()).toBeTruthy();
    const updateBody = (await updateResponse.json()) as { ok: boolean; error?: string };
    expect(updateBody.ok).toBeTruthy();
  });

  test('Reservas: acceso a re-reserva y rechazo por API admin', async ({ page }) => {
    await openAdminModule(page, 'Reservas');
    await expect(page).toHaveURL(/\/reservas/, { timeout: 10_000 });

    await page.goto('/admin');
    await waitForAngularReady(page);

    const reservations = await getReservations(page);
    test.skip(reservations.length === 0, 'No hay reservas para rechazar.');

    const target = reservations[0];
    const rejectResponse = await page.request.patch(`/api/admin/reservas/${target.id}/status`, {
      data: { status: 'rejected' },
    });

    expect(rejectResponse.ok()).toBeTruthy();
    const rejectBody = (await rejectResponse.json()) as { ok: boolean; error?: string };
    expect(rejectBody.ok).toBeTruthy();
  });

  test('Reservas: quitar reserva por API admin', async ({ page }) => {
    const reservations = await getReservations(page);
    test.skip(reservations.length === 0, 'No hay reservas para eliminar.');

    const target = reservations[0];
    const deleteResponse = await page.request.delete(`/api/admin/reservas/${target.id}`);
    expect(deleteResponse.ok()).toBeTruthy();

    const deleteBody = (await deleteResponse.json()) as { ok: boolean };
    expect(deleteBody.ok).toBeTruthy();

    const after = await getReservations(page);
    expect(after.some((reservation) => reservation.id === target.id)).toBeFalsy();
  });

  test('Cobros: registrar efectivo, tarjeta y bizum; y cierre de caja', async ({ page }) => {
    const uidBase = Date.now().toString().slice(-8);

    const clientEfectivo = await createClientViaUi(page, `${uidBase}e`);
    const clientTarjeta = await createClientViaUi(page, `${uidBase}t`);
    const clientBizum = await createClientViaUi(page, `${uidBase}b`);

    await payClientTreatmentByMethod(page, clientEfectivo, 'Pack Corte', 'Efectivo');
    await payClientTreatmentByMethod(page, clientTarjeta, 'Pack Color', 'Tarjeta');
    await payClientTreatmentByMethod(page, clientBizum, 'Pack Peinado', 'Bizum');

    await openAdminModule(page, 'Cierre de caja');
    await expect(page.getByRole('heading', { name: 'Cierre de caja' })).toBeVisible();

    await expect(page.locator('text=💵 Efectivo').first()).toBeVisible();
    await expect(page.locator('text=💳 Tarjeta').first()).toBeVisible();
    await expect(page.locator('text=📱 Bizum').first()).toBeVisible();

    await page.locator('#cierreEfectivo').fill('10');
    await page.locator('#cierreTarjeta').fill('20');
    await page.locator('#cierreBizum').fill('30');
    await page.locator('#cierreNotas').fill('Cierre E2E completo');
    await page.getByRole('button', { name: 'Registrar cierre' }).click();

    await expect(page.locator('text=Cierre registrado correctamente.')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('.admin-panel--container__table tbody tr').first()).toBeVisible();

    await page.locator('select').first().selectOption('semana');
    await page.locator('select').nth(1).selectOption('digital');
    await expect(page.locator('text=Vista · Tarjeta + Bizum')).toBeVisible();
  });

  test('Estadisticas: renderiza graficas de barras y tarta en packs y cierre', async ({ page }) => {
    const uid = Date.now().toString().slice(-8);

    await seedPaidTreatmentForStats(page, uid);
    await seedCierreForStats(page, uid);

    await openAdminModule(page, 'Cierre de caja');
    await expect(page.getByRole('heading', { name: 'Cierre de caja' })).toBeVisible();

    const cierreStatsCard = page
      .locator('.admin-panel--container__section')
      .filter({ hasText: 'Estadísticas de caja' })
      .first();
    await expect(cierreStatsCard).toBeVisible();
    await expect(
      cierreStatsCard.locator('.admin-panel--container__client-bar-chart').first(),
    ).toBeVisible();
    await expect(
      cierreStatsCard.locator('.admin-panel--container__client-column-bar').first(),
    ).toBeVisible();
    await expect(
      cierreStatsCard.locator('.admin-panel--container__client-pie-chart').first(),
    ).toBeVisible();

    await page.getByRole('button', { name: /Volver al panel/i }).click();
    await waitForAngularReady(page);
    await page.getByRole('button', { name: /Estadísticas/i }).click();
    await waitForAngularReady(page);
    await expect(page.getByRole('heading', { name: 'Estadísticas de packs' })).toBeVisible();

    const distributionCard = page
      .locator('.admin-panel--container__client-chart')
      .filter({ hasText: 'Distribución de packs' })
      .first();
    const chartTypeSelect = distributionCard.locator('select').first();

    await chartTypeSelect.selectOption('bar');
    await expect(
      distributionCard.locator('.admin-panel--container__client-bar-chart'),
    ).toBeVisible();

    await chartTypeSelect.selectOption('pie');
    await expect(
      distributionCard.locator('.admin-panel--container__client-pie-chart'),
    ).toBeVisible();

    const timelineCard = page
      .locator('.admin-panel--container__client-chart')
      .filter({ hasText: 'Evolución temporal de packs' })
      .first();
    await expect(timelineCard.locator('.admin-panel--container__client-bar-chart')).toBeVisible();
    await expect(
      timelineCard.locator('.admin-panel--container__client-column-bar').first(),
    ).toBeVisible();
  });
});
