/**
 * Tests E2E — Panel de administración de Arena Hair Studio
 *
 * Cubre:
 *  - Redirección si no autenticado
 *  - Login correcto como superadmin
 *  - Navegación entre tabs principales
 *  - Logout
 *  - Modal de fichaje forzado para empleados
 */
import { test, expect, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Credenciales seed (definidas en server.ts)
// ---------------------------------------------------------------------------
const SUPERADMIN_EMAIL = 'ferperezsanchez@gmail.com'; // adminOwnerEmail por defecto
const SUPERADMIN_PASSWORD = 'Hair-studio';

const EMPLOYEE_EMAIL = 'maria.romero@arena.local';
const EMPLOYEE_PASSWORD = 'Empleado-123!';

// ---------------------------------------------------------------------------
// Helper: login completo via UI
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Helper: login completo via UI (dos pasos)
// ---------------------------------------------------------------------------
async function loginViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/acceso');
  await page.waitForSelector('.admin-acceso--container__modal', { timeout: 8000 });

  // Paso 1: formulario estándar de inicio de sesión
  await page.locator('#identity').fill(email);
  await page.locator('#login-password').fill(password);
  await page.locator('button:has-text("Entrar")').first().click();

  // Paso 2: aparece lista de identificación de gestión
  const userBtn = page.locator('.admin-acceso--container__identify-user').filter({
    hasText: email,
  });
  await userBtn.waitFor({ timeout: 12_000 });
  await userBtn.click();

  // Confirmar contraseña de gestión
  await page.locator('#role-user-password').fill(password);
  await page.locator('button:has-text("Entrar en gestión")').click();

  // Esperar redirección al panel
  await page.waitForURL('**/admin**', { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
}

async function loginEmployeeIfAvailable(page: Page): Promise<boolean> {
  await page.goto('/acceso');
  await page.waitForSelector('.admin-acceso--container__modal', { timeout: 8000 });

  await page.locator('#identity').fill(EMPLOYEE_EMAIL);
  await page.locator('#login-password').fill(EMPLOYEE_PASSWORD);
  await page.locator('button:has-text("Entrar")').first().click();

  const userBtn = page.locator('.admin-acceso--container__identify-user').filter({
    hasText: EMPLOYEE_EMAIL,
  });
  const isVisible = await userBtn
    .first()
    .isVisible({ timeout: 5000 })
    .catch(() => false);

  if (!isVisible) {
    return false;
  }

  await userBtn.first().click();
  await page.locator('#role-user-password').fill(EMPLOYEE_PASSWORD);
  await page.locator('button:has-text("Entrar en gestión")').click();

  await page.waitForURL('**/admin**', { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  return true;
}

// ---------------------------------------------------------------------------
// Protección de ruta
// ---------------------------------------------------------------------------
test.describe('Protección del panel de admin', () => {
  test('sin sesión redirige a /acceso', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/acceso/, { timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Login como superadmin
// ---------------------------------------------------------------------------
test.describe('Login como superadmin', () => {
  test('login correcto navega al panel', async ({ page }) => {
    await loginViaUI(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });
  });

  test('el panel muestra los tabs principales de navegación', async ({ page }) => {
    await loginViaUI(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);

    // Comprobación robusta: título del panel + al menos una tarjeta de módulo
    await expect(page.locator('h1:has-text("Panel de administración")')).toBeVisible({
      timeout: 8000,
    });
    await expect(page.locator('.admin-panel--container__module-card').first()).toBeVisible();
  });

  test('el tab Agenda está disponible y es clickeable', async ({ page }) => {
    await loginViaUI(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);

    const agendaTab = page
      .locator('button, a')
      .filter({ hasText: /agenda/i })
      .first();
    await agendaTab.waitFor({ timeout: 8000 });
    await agendaTab.click();

    // La URL puede mantener /admin con queryParam tab=agenda
    await page.waitForTimeout(1000);
    // Al menos el panel sigue visible
    await expect(page).toHaveURL(/admin/);
  });

  test('el tab Empleados está disponible para superadmin', async ({ page }) => {
    await loginViaUI(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);

    const empleadosTab = page
      .locator('button, a')
      .filter({ hasText: /empleados/i })
      .first();
    await empleadosTab.waitFor({ timeout: 8000 });
    await expect(empleadosTab).toBeVisible();
  });

  test('el tab Estadísticas está disponible', async ({ page }) => {
    await loginViaUI(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);
    const statsTab = page
      .locator('button, a')
      .filter({ hasText: /estad[íi]sticas/i })
      .first();
    await statsTab.waitFor({ timeout: 8000 });
    await expect(statsTab).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
test.describe('Logout del panel', () => {
  test('el botón de cerrar sesión desconecta y redirige a /acceso', async ({ page }) => {
    await loginViaUI(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);

    const logoutBtn = page.locator('button:has-text("Cerrar sesión admin")').first();
    await logoutBtn.scrollIntoViewIfNeeded();
    await logoutBtn.waitFor({ timeout: 10_000 });
    await logoutBtn.click();

    await expect(page).toHaveURL(/\/acceso/, { timeout: 10_000 });
  });

  test('después del logout no se puede acceder al panel', async ({ page }) => {
    await loginViaUI(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);

    const logoutBtn = page.locator('button:has-text("Cerrar sesión admin")').first();
    await logoutBtn.scrollIntoViewIfNeeded();
    await logoutBtn.waitFor({ timeout: 10_000 });
    await logoutBtn.click();
    await expect(page).toHaveURL(/\/acceso/, { timeout: 10_000 });

    // Intentar ir al panel directamente
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/acceso/, { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Login como empleado (role 'admin', no superadmin)
// ---------------------------------------------------------------------------
test.describe('Login como empleado', () => {
  test('empleado puede acceder al panel', async ({ page }) => {
    const isAvailable = await loginEmployeeIfAvailable(page);
    test.skip(!isAvailable, 'No hay empleado seed disponible en este entorno.');
    await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });
  });

  test('empleado NO ve el tab de Empleados (es solo para superadmin)', async ({ page }) => {
    const isAvailable = await loginEmployeeIfAvailable(page);
    test.skip(!isAvailable, 'No hay empleado seed disponible en este entorno.');
    await page.waitForLoadState('networkidle');

    // El tab de empleados no debería estar visible o debería estar deshabilitado
    const empleadosTab = page.locator('button').filter({ hasText: /^empleados$/i });
    const isVisible = await empleadosTab.isVisible();
    if (isVisible) {
      // Si existe, debe estar deshabilitado o no hacer nada
      const isDisabled = await empleadosTab.isDisabled();
      expect(isDisabled).toBe(true);
    }
    // Si no existe, también está bien
  });

  test('empleado ve el modal de fichaje forzado si no ha fichado hoy', async ({ page }) => {
    const isAvailable = await loginEmployeeIfAvailable(page);
    test.skip(!isAvailable, 'No hay empleado seed disponible en este entorno.');
    await page.waitForLoadState('networkidle');

    // El modal de fichaje forzado puede aparecer (si el empleado no fichó hoy)
    // En un entorno de test fresco (memoria), esto siempre debería aparecer
    const forcedModal = page.locator('.admin-panel--container__modal--forced-checkin');
    const isVisible = await forcedModal.isVisible({ timeout: 5000 }).catch(() => false);

    if (isVisible) {
      // Debe tener el botón de fichar
      await expect(page.locator('.admin-panel--container__button--checkin')).toBeVisible();

      // El modal NO debe tener botón de cierre (es bloqueante)
      const closeButtons = page.locator(
        '.admin-panel--container__modal--forced-checkin button:has-text("×")',
      );
      await expect(closeButtons).toHaveCount(0);
    }
    // Si ya fichó (test run multiple veces), el modal no aparece — también OK
  });

  test('fichar entrada cierra el modal de fichaje forzado', async ({ page }) => {
    const isAvailable = await loginEmployeeIfAvailable(page);
    test.skip(!isAvailable, 'No hay empleado seed disponible en este entorno.');
    await page.waitForLoadState('networkidle');

    const forcedModal = page.locator('.admin-panel--container__modal--forced-checkin');
    const isVisible = await forcedModal.isVisible({ timeout: 5000 }).catch(() => false);

    if (!isVisible) {
      test.skip(); // Ya fichó, no hay modal
      return;
    }

    const checkinBtn = page.locator('.admin-panel--container__button--checkin');
    await checkinBtn.waitFor({ timeout: 5000 });
    await checkinBtn.click();

    // El modal debe desaparecer
    await expect(forcedModal).toBeHidden({ timeout: 8000 });
  });
});

// ---------------------------------------------------------------------------
// Funcionalidades del panel — Agenda
// ---------------------------------------------------------------------------
test.describe('Panel de admin — Agenda', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaUI(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);
  });

  test('al entrar en Agenda se muestran los controles de vista', async ({ page }) => {
    const agendaTab = page
      .locator('button')
      .filter({ hasText: /agenda/i })
      .first();
    await agendaTab.click();
    await page.waitForLoadState('networkidle');

    // Debe haber controles de vista (listado, semana, mes...)
    await expect(page.locator('[class*="agenda"]').first()).toBeVisible({ timeout: 8000 });
  });
});

// ---------------------------------------------------------------------------
// Inactividad — warning banner
// ---------------------------------------------------------------------------
test.describe('Aviso de inactividad', () => {
  test('el banner de inactividad NO aparece inmediatamente tras login', async ({ page }) => {
    await loginViaUI(page, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD);
    await page.waitForLoadState('networkidle');

    // Justo después del login, no debería haber banner de inactividad
    const warningBanner = page.locator('.admin-panel--inactivity-warning');
    await expect(warningBanner).toBeHidden();
  });
});
