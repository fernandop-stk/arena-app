/**
/**
 * Utilidades compartidas para los tests E2E de Arena Hair Studio.
 *
 * El flujo de login de admin/empleado es de DOS pasos:
 *   1. Formulario inicial (#identity + #login-password) → "Entrar"
 *      → Si el usuario tiene rol admin/superadmin, aparece la lista de usuarios.
 *   2. Clic en el propio usuario → #role-user-password → "Entrar en gestión"
 *      → Navega a /admin
 */
import { Page } from '@playwright/test';

/** URL base de la aplicación */
export const BASE_URL = 'http://localhost:4200';

/**
 * Login completo de admin/empleado (dos pasos).
 */
export async function loginAsAdmin(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/acceso');

  // Paso 1: formulario de inicio de sesión estándar
  await page.waitForSelector('.admin-acceso--container__modal', { timeout: 8000 });
  await page.locator('#identity').fill(email);
  await page.locator('#login-password').fill(password);
  await page.locator('button:has-text("Entrar")').first().click();

  // Paso 2: aparece la lista de identificación de gestión
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
}

/**
 * Espera a que Angular haya hidratado el componente.
 */
export async function waitForAngularReady(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
}
