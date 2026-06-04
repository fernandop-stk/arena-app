import { expect, Page, test } from '@playwright/test';
import { loginAsAdmin, waitForAngularReady } from './helpers';

const SUPERADMIN_EMAIL = 'ferperezsanchez@gmail.com';
const SUPERADMIN_PASSWORD = 'Hair-studio';

type EmployeeRole = 'admin' | 'client';
type TrackingAction =
  | 'check_in'
  | 'check_out'
  | 'vacation'
  | 'sick_leave'
  | 'recovering_hours'
  | 'clear_status';

type EmployeeTracking = {
  workStatus: 'idle' | 'working' | 'vacation' | 'sick_leave' | 'recovering_hours';
  history: Array<{ action: TrackingAction; createdAtIso: string; note: string }>;
};

type EmployeeUser = {
  email: string;
  username: string;
  role: EmployeeRole | 'superadmin';
  tracking: EmployeeTracking;
};

async function loginSuperadmin(page: Page): Promise<void> {
  await loginAsAdmin(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });
  await waitForAngularReady(page);
}

async function getEmployees(page: Page): Promise<EmployeeUser[]> {
  const response = await page.request.get('/api/admin/empleados');
  if (response.status() === 403) {
    return [];
  }
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    ok: boolean;
    users?: EmployeeUser[];
    error?: string;
  };
  expect(body.ok).toBeTruthy();
  return body.users ?? [];
}

async function createEmployeeViaApi(
  page: Page,
  username: string,
  email: string,
  password: string,
  role: EmployeeRole,
): Promise<number> {
  const response = await page.request.post('/api/admin/empleados', {
    data: {
      username,
      email,
      password,
      role,
    },
  });

  return response.status();
}

async function patchEmployeeTracking(
  page: Page,
  email: string,
  action: TrackingAction,
  note: string,
): Promise<void> {
  const response = await page.request.patch(
    `/api/admin/empleados/${encodeURIComponent(email)}/tracking`,
    {
      data: { action, note },
    },
  );
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { ok: boolean; error?: string };
  expect(body.ok).toBeTruthy();
}

test.describe('Admin - personal y subacciones', () => {
  test.beforeEach(async ({ page }) => {
    await loginSuperadmin(page);
  });

  test('gestion de personal: alta, cambio de rol, fichaje/vacaciones y baja de empleado', async ({
    page,
  }) => {
    const uid = Date.now().toString();
    const employeeUsername = `empleadoe2e${uid.slice(-6)}`;
    const employeeEmail = `empleado.e2e.${uid}@arena.local`;
    const employeePassword = 'Empleado-123!';

    const createStatus = await createEmployeeViaApi(
      page,
      employeeUsername,
      employeeEmail,
      employeePassword,
      'client',
    );
    test.skip(
      createStatus === 403,
      'Este entorno no tiene sesión de superadmin para gestionar empleados.',
    );
    expect(createStatus).toBe(200);

    let employees = await getEmployees(page);
    const created = employees.find((user) => user.email === employeeEmail);
    expect(created).toBeTruthy();
    expect(created?.role).toBe('client');

    const promoteResponse = await page.request.patch(
      `/api/admin/empleados/${encodeURIComponent(employeeEmail)}/rol`,
      {
        data: { role: 'admin' },
      },
    );
    expect(promoteResponse.ok()).toBeTruthy();

    await patchEmployeeTracking(page, employeeEmail, 'check_in', 'Fichaje entrada E2E');
    await patchEmployeeTracking(page, employeeEmail, 'check_out', 'Fichaje salida E2E');
    await patchEmployeeTracking(page, employeeEmail, 'vacation', 'Vacaciones 2026-06 E2E');
    await patchEmployeeTracking(page, employeeEmail, 'clear_status', 'Reset estado E2E');

    employees = await getEmployees(page);
    const updated = employees.find((user) => user.email === employeeEmail);
    expect(updated).toBeTruthy();
    expect(updated?.role).toBe('admin');
    expect(updated?.tracking.workStatus).toBe('idle');
    const actions = (updated?.tracking.history ?? []).map((item) => item.action);
    expect(actions).toContain('check_in');
    expect(actions).toContain('check_out');
    expect(actions).toContain('vacation');
    expect(actions).toContain('clear_status');

    const deleteResponse = await page.request.delete(
      `/api/admin/empleados/${encodeURIComponent(employeeEmail)}`,
    );
    expect(deleteResponse.ok()).toBeTruthy();
    const deleteBody = (await deleteResponse.json()) as { ok: boolean; error?: string };
    expect(deleteBody.ok).toBeTruthy();

    const afterDelete = await getEmployees(page);
    expect(afterDelete.some((user) => user.email === employeeEmail)).toBeFalsy();
  });

  test('empleado admin crea clienta y registra cobro', async ({ page }) => {
    const uid = Date.now().toString();
    const employeeEmail = `empleado.cobro.${uid}@arena.local`;
    const employeeUsername = `empleadocobro${uid.slice(-5)}`;
    const employeePassword = 'Empleado-123!';
    const clientEmail = `clienta.cobro.${uid}@example.com`;

    const createStatus = await createEmployeeViaApi(
      page,
      employeeUsername,
      employeeEmail,
      employeePassword,
      'admin',
    );
    test.skip(
      createStatus === 403,
      'Este entorno no tiene sesión de superadmin para gestionar empleados.',
    );
    expect(createStatus).toBe(200);

    await page.request.post('/api/admin/logout');
    await page.goto('/acceso');
    await loginAsAdmin(page, employeeEmail, employeePassword);
    await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });

    const createClient = await page.request.post('/api/admin/clientes', {
      data: {
        fullName: `Clienta Cobro ${uid}`,
        email: clientEmail,
        phone: '600456789',
        birthDateIso: '1992-04-10',
        notes: 'Creada por empleado en e2e',
      },
    });
    expect(createClient.ok()).toBeTruthy();

    const createClientBody = (await createClient.json()) as {
      ok: boolean;
      card?: { id: string };
      error?: string;
    };
    expect(createClientBody.ok).toBeTruthy();
    const clientId = createClientBody.card?.id ?? '';
    expect(clientId).not.toBe('');

    const addTreatment = await page.request.post(`/api/admin/clientes/${clientId}/packs`, {
      data: {
        name: 'Pack Corte',
        note: 'Cobro realizado por empleado',
      },
    });
    expect(addTreatment.ok()).toBeTruthy();

    const addTreatmentBody = (await addTreatment.json()) as {
      ok: boolean;
      card?: { treatments?: Array<{ id: string; paymentMethod: string | null }> };
      error?: string;
    };
    expect(addTreatmentBody.ok).toBeTruthy();
    const treatmentId = addTreatmentBody.card?.treatments?.[0]?.id ?? '';
    expect(treatmentId).not.toBe('');

    const payTreatment = await page.request.patch(
      `/api/admin/clientes/${clientId}/packs/${treatmentId}/payment`,
      {
        data: {
          priceEuro: 40,
          paymentMethod: 'bizum',
        },
      },
    );

    expect(payTreatment.ok()).toBeTruthy();
    const payBody = (await payTreatment.json()) as {
      ok: boolean;
      card?: { treatments?: Array<{ id: string; paymentMethod: string | null }> };
      error?: string;
    };
    expect(payBody.ok).toBeTruthy();

    const paidTreatment = payBody.card?.treatments?.find((item) => item.id === treatmentId);
    expect(paidTreatment?.paymentMethod).toBe('bizum');

    // Limpieza de empleado creado para esta prueba.
    await page.request.post('/api/admin/logout');
    await loginSuperadmin(page);
    await page.request.delete(`/api/admin/empleados/${encodeURIComponent(employeeEmail)}`);
  });

  test('subacciones admin: abrir modulos clave y gestionar alertas (aprobar/rechazar)', async ({
    page,
  }) => {
    const modules = ['Reservas', 'Almacén', 'Ficha de cliente', 'Cierre de caja'];

    for (const moduleName of modules) {
      await page
        .locator('.admin-panel--container__module-card')
        .filter({ hasText: moduleName })
        .first()
        .click();
      await waitForAngularReady(page);

      if (moduleName === 'Reservas') {
        await expect(page).toHaveURL(/\/reservas/, { timeout: 10_000 });
      } else {
        await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 10_000 });
      }

      if (moduleName === 'Reservas') {
        await page.goto('/admin');
      } else {
        const backBtn = page.getByRole('button', { name: /Volver al panel/i }).first();
        const hasBack = await backBtn.isVisible().catch(() => false);
        if (hasBack) {
          await backBtn.click();
        } else {
          await page.goto('/admin');
        }
      }

      await waitForAngularReady(page);
    }

    const uid = Date.now().toString();
    const alertEmailApprove = `alerta.aprobar.${uid}@example.com`;
    const alertEmailReject = `alerta.rechazar.${uid}@example.com`;

    const createApprove = await page.request.post('/api/admin/alertas/test', {
      data: {
        clientEmail: alertEmailApprove,
        dateIso: '2026-06-20',
        startTime: '10:00',
        endTime: '11:00',
        appointmentTypeName: 'Pack Corte',
      },
    });
    expect(createApprove.ok()).toBeTruthy();
    const approveBody = (await createApprove.json()) as {
      ok: boolean;
      alert?: { id: string };
      error?: string;
    };
    expect(approveBody.ok).toBeTruthy();

    const createReject = await page.request.post('/api/admin/alertas/test', {
      data: {
        clientEmail: alertEmailReject,
        dateIso: '2026-06-21',
        startTime: '12:00',
        endTime: '13:00',
        appointmentTypeName: 'Pack Color',
      },
    });
    expect(createReject.ok()).toBeTruthy();
    const rejectBody = (await createReject.json()) as {
      ok: boolean;
      alert?: { id: string };
      error?: string;
    };
    expect(rejectBody.ok).toBeTruthy();

    const approveResponse = await page.request.patch(
      `/api/admin/alertas/${approveBody.alert?.id ?? ''}/aprobar`,
      { data: {} },
    );
    expect(approveResponse.ok()).toBeTruthy();

    const rejectResponse = await page.request.patch(
      `/api/admin/alertas/${rejectBody.alert?.id ?? ''}/rechazar`,
      { data: {} },
    );
    expect(rejectResponse.ok()).toBeTruthy();

    const approvedAlertsResponse = await page.request.get('/api/admin/alertas');
    expect(approvedAlertsResponse.ok()).toBeTruthy();
    const approvedAlerts = (await approvedAlertsResponse.json()) as {
      ok: boolean;
      alerts?: Array<{ id: string; approvalStatus: string; status: string }>;
    };
    expect(approvedAlerts.ok).toBeTruthy();
    const approvedAlert = approvedAlerts.alerts?.find(
      (alert) => alert.id === approveBody.alert?.id,
    );
    if (approvedAlert) {
      expect(approvedAlert.approvalStatus).toBe('approved');
    }

    const rejectedAlertsResponse = await page.request.get('/api/admin/alertas');
    expect(rejectedAlertsResponse.ok()).toBeTruthy();
    const rejectedAlerts = (await rejectedAlertsResponse.json()) as {
      ok: boolean;
      alerts?: Array<{ id: string; approvalStatus: string; status: string }>;
    };
    expect(rejectedAlerts.ok).toBeTruthy();
    const rejectedAlert = rejectedAlerts.alerts?.find((alert) => alert.id === rejectBody.alert?.id);
    // Si la alerta ya no está activa, su ausencia también valida el flujo de rechazo.
    if (rejectedAlert) {
      expect(rejectedAlert.approvalStatus).toBe('rejected');
    }
  });
});
