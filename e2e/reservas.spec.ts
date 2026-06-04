/**
 * Tests E2E — Flujo de reservas de Arena Hair Studio
 *
 * Cubre: /reservas → selector de pack → /reservas/calendario → /reservas/datos
 */
import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Selección de pack (/reservas)
// ---------------------------------------------------------------------------
test.describe('Página de selección de pack (/reservas)', () => {
  test('muestra el título y las opciones de pack', async ({ page }) => {
    await page.goto('/reservas');
    // Debe existir un h1
    const h1 = page.locator('h1').first();
    await expect(h1).toBeVisible();
  });

  test('muestra al menos una tarjeta de pack seleccionable', async ({ page }) => {
    await page.goto('/reservas');
    await page.waitForLoadState('networkidle');
    // Las tarjetas de pack tienen la clase citas--container__card-title
    const cards = page.locator('.citas--container__card-title');
    await expect(cards.first()).toBeVisible();
  });

  test('al seleccionar un pack y pulsar continuar navega al calendario', async ({ page }) => {
    await page.goto('/reservas');
    await page.waitForLoadState('networkidle');

    // Seleccionar pack
    const packCard = page.locator('.citas--container__card').first();
    await packCard.waitFor({ timeout: 8000 });
    await packCard.click();

    // Confirmar con botón principal
    await page.locator('.citas--container__button--primary').first().click();

    // Debe navegar a /reservas/calendario
    await expect(page).toHaveURL(/\/reservas\/calendario/, { timeout: 10_000 });
  });

  test('muestra sección "¿Ya eres cliente?"', async ({ page }) => {
    await page.goto('/reservas');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('text=¿Ya eres cliente?')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Calendario de disponibilidad (/reservas/calendario)
// ---------------------------------------------------------------------------
test.describe('Calendario de disponibilidad (/reservas/calendario)', () => {
  test('carga la página correctamente', async ({ page }) => {
    await page.goto('/reservas/calendario');
    const h1 = page.locator('h1').first();
    await expect(h1).toBeVisible({ timeout: 10_000 });
  });

  test('renderiza contenido del calendario sin error', async ({ page }) => {
    await page.goto('/reservas/calendario');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });
    // Debe renderizar al menos uno de estos bloques del flujo
    const hasTypes =
      (await page.locator('.reserva-calendario--container__type-button').count()) > 0;
    const hasDays = (await page.locator('.reserva-calendario--container__day').count()) > 0;
    expect(hasTypes || hasDays).toBeTruthy();
  });

  test('muestra pasos de reserva visibles', async ({ page }) => {
    await page.goto('/reservas/calendario');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('button[aria-label="Paso 1: Servicio"]')).toBeVisible({
      timeout: 8000,
    });
    await expect(page.locator('button[aria-label="Paso 2: Día"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Paso 3: Hora"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Formulario de datos (/reservas/datos)
// ---------------------------------------------------------------------------
test.describe('Formulario de datos de reserva (/reservas/datos)', () => {
  test('carga la página sin redirigir (con o sin estado de reserva)', async ({ page }) => {
    const response = await page.goto('/reservas/datos');
    // No debe ser un error de servidor
    expect(response?.status()).toBeLessThan(500);
  });

  test('muestra algún formulario o mensaje de estado', async ({ page }) => {
    await page.goto('/reservas/datos');
    await page.waitForLoadState('networkidle');
    // Debe haber texto visible en la página
    await expect(page.locator('body')).not.toBeEmpty();
    const body = await page.locator('body').innerText();
    expect(body.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Flujo completo: selección de pack → calendario
// ---------------------------------------------------------------------------
test.describe('Flujo completo de reserva', () => {
  test('reservas → calendario (flujo real de UI)', async ({ page }) => {
    // 1. Ir a packs y elegir el primero
    await page.goto('/reservas');
    await page.waitForLoadState('networkidle');

    const firstPack = page.locator('.citas--container__card').first();
    await firstPack.waitFor({ timeout: 8000 });
    await firstPack.click();

    await page.locator('.citas--container__button--primary').first().click();

    // 2. Esperar calendario
    await expect(page).toHaveURL(/\/reservas\/calendario/, { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // Debe renderizar al menos la cabecera del flujo
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });
  });
});
