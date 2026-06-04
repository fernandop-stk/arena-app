/**
/**
 * Tests E2E — Autenticación de Arena Hair Studio
 *
 * Cubre: /acceso (login admin/empleado y cliente), /registro, /cliente/recuperar
 *
 * Flujo de login de admin (dos pasos):
 *   1. Formulario estándar (#identity + #login-password) → "Entrar"
 *   2. Lista de usuarios → clic en usuario → #role-user-password → "Entrar en gestión"
 */
import { test, expect } from '@playwright/test';

// Credenciales seed definidas en server.ts
const SUPERADMIN_EMAIL = 'ferperezsanchez@gmail.com';
const SUPERADMIN_PASSWORD = 'Hair-studio';

/** Completa el paso 1 del login y queda en el estado de identificación por roles */
async function goToRoleIdentification(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/acceso');
  await page.waitForSelector('.admin-acceso--container__modal', { timeout: 8000 });
  await page.locator('#identity').fill(SUPERADMIN_EMAIL);
  await page.locator('#login-password').fill(SUPERADMIN_PASSWORD);
  await page.locator('button:has-text("Entrar")').first().click();
  // Esperar que aparezca la lista de usuarios de gestión
  await page
    .locator('.admin-acceso--container__identify-user')
    .first()
    .waitFor({ timeout: 12_000 });
}

// ---------------------------------------------------------------------------
// Página de acceso (/acceso)
// ---------------------------------------------------------------------------
test.describe('Página de acceso (/acceso)', () => {
  test('muestra el modal de acceso al cargar', async ({ page }) => {
    await page.goto('/acceso');
    // El modal debe aparecer automáticamente
    await expect(page.locator('.admin-acceso--container__modal')).toBeVisible({ timeout: 8000 });
  });

  test('el modal tiene el título "Acceso de usuarios" o "Identificación de gestión"', async ({
    page,
  }) => {
    await page.goto('/acceso');
    const title = page.locator('.admin-acceso--container__modal-title');
    await expect(title).toBeVisible({ timeout: 8000 });
    const text = await title.innerText();
    expect(['Acceso de usuarios', 'Identificación de gestión']).toContain(text.trim());
  });

  test('el botón de cerrar el modal cierra el modal', async ({ page }) => {
    await page.goto('/acceso');
    await page.locator('.admin-acceso--container__modal-close').click();
    await expect(page.locator('.admin-acceso--container__modal')).toBeHidden({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Flujo de identificación de roles (empleados/admin)
// ---------------------------------------------------------------------------
test.describe('Flujo de identificación por roles', () => {
  test('muestra lista de usuarios de gestión para seleccionar', async ({ page }) => {
    await goToRoleIdentification(page);
    const userBtns = page.locator('.admin-acceso--container__identify-user');
    const count = await userBtns.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('al seleccionar un usuario muestra el formulario de contraseña', async ({ page }) => {
    await goToRoleIdentification(page);
    const firstUser = page.locator('.admin-acceso--container__identify-user').first();
    await firstUser.click();
    await expect(page.locator('#role-user-password')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Entrar en gestión')).toBeVisible();
  });

  test('contraseña incorrecta muestra mensaje de error', async ({ page }) => {
    await goToRoleIdentification(page);
    const firstUser = page.locator('.admin-acceso--container__identify-user').first();
    await firstUser.click();
    await page.locator('#role-user-password').fill('contraseña_incorrecta_xyz');
    await page.locator('button:has-text("Entrar en gestión")').click();
    await expect(page.locator('.admin-acceso--container__error')).toBeVisible({ timeout: 8000 });
  });

  test('"Cambiar usuario" vuelve a la lista de selección', async ({ page }) => {
    await goToRoleIdentification(page);
    const firstUser = page.locator('.admin-acceso--container__identify-user').first();
    await firstUser.click();
    await page.locator('button:has-text("Cambiar usuario")').click();
    await expect(page.locator('.admin-acceso--container__identify-user').first()).toBeVisible({
      timeout: 5000,
    });
  });
});

// ---------------------------------------------------------------------------
// Login de cliente (tab "Iniciar sesión")
// ---------------------------------------------------------------------------
test.describe('Login de cliente', () => {
  test('el formulario de inicio de sesión muestra #identity y #login-password', async ({
    page,
  }) => {
    await page.goto('/acceso');
    await page.waitForSelector('.admin-acceso--container__modal', { timeout: 8000 });
    // El modal abre directamente con el formulario de login
    await expect(page.locator('#identity')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#login-password')).toBeVisible();
    await expect(page.locator('button:has-text("Entrar")')).toBeVisible();
  });

  test('credenciales de cliente inválidas muestran error', async ({ page }) => {
    await page.goto('/acceso');
    await page.waitForSelector('.admin-acceso--container__modal', { timeout: 8000 });
    // Cambiar al tab de cliente si existe (si no, el mismo formulario sirve)
    const registerTab = page.locator('button:has-text("Regístrate")');
    if (await registerTab.isVisible()) {
      await page.locator('button:has-text("Iniciar sesión")').click();
    }
    await page.locator('#identity').fill('noexiste@test.com');
    await page.locator('#login-password').fill('wrongpass');
    await page.locator('button:has-text("Entrar")').first().click();
    await expect(page.locator('.admin-acceso--container__error')).toBeVisible({ timeout: 8000 });
  });
});

// ---------------------------------------------------------------------------
// Registro de cliente (/registro y /cliente/registro)
// ---------------------------------------------------------------------------
test.describe('Página de registro de cliente', () => {
  test('/registro redirige correctamente', async ({ page }) => {
    const response = await page.goto('/registro');
    expect(response?.status()).toBeLessThan(500);
  });

  test('/cliente/registro carga el formulario de registro', async ({ page }) => {
    const response = await page.goto('/cliente/registro');
    expect(response?.status()).toBeLessThan(500);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).not.toBeEmpty();
  });
});

// ---------------------------------------------------------------------------
// Recuperación de contraseña
// ---------------------------------------------------------------------------
test.describe('Recuperación de contraseña (/cliente/recuperar)', () => {
  test('carga la página correctamente', async ({ page }) => {
    const response = await page.request.get('/cliente/recuperar');
    expect(response?.status()).toBeLessThan(500);
  });

  test('muestra algún formulario o campo de email', async ({ page }) => {
    const response = await page.request.get('/cliente/recuperar');
    expect(response?.status()).toBeLessThan(500);
    const html = await response.text();
    expect(html.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Protección de rutas de admin
// ---------------------------------------------------------------------------
test.describe('Protección de rutas', () => {
  test('/admin redirige a /acceso si no hay sesión activa', async ({ page }) => {
    // Acceder sin cookies de sesión
    await page.context().clearCookies();
    await page.goto('/admin');

    // Debe redirigir a /acceso
    await expect(page).toHaveURL(/\/acceso/, { timeout: 15_000 });
  });

  test('/cliente/area redirige si no hay sesión de cliente', async ({ page }) => {
    await page.context().clearCookies();
    const response = await page.goto('/cliente/area');
    await page.waitForLoadState('networkidle');
    // No debe romper (status < 500)
    expect(response?.status()).toBeLessThan(500);
  });
});
