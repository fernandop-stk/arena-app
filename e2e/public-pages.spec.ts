/**
 * Tests E2E — Páginas públicas de Arena Hair Studio
 *
 * Cubre: Inicio (/), Packs (/packs), Conócenos (/conocenos), Dónde estamos (/donde-estamos)
 */
import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Página de inicio
// ---------------------------------------------------------------------------
test.describe('Página de inicio (/)', () => {
  test('muestra el título principal "Arena Hair Studio"', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1').first()).toContainText('Arena Hair Studio');
  });

  test('muestra tarjetas de navegación con enlace a Packs y Reservas', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.inicio--container__card-title').first()).toBeVisible();
    await expect(page.locator('a[href="/packs"], a[routerlink="/packs"]').first()).toBeVisible();
  });

  test('el enlace a Packs navega a /packs', async ({ page }) => {
    await page.goto('/');
    await page.locator('a[href="/packs"]').first().click();
    await expect(page).toHaveURL(/\/packs/);
  });

  test('el enlace a Reservas navega a /reservas', async ({ page }) => {
    await page.goto('/');
    await page.locator('a[href="/reservas"]').first().click();
    await expect(page).toHaveURL(/\/reservas/);
  });
});

// ---------------------------------------------------------------------------
// Página de packs y tratamientos
// ---------------------------------------------------------------------------
test.describe('Página de packs (/packs)', () => {
  test('muestra el título "Packs y tratamientos"', async ({ page }) => {
    await page.goto('/packs');
    await expect(page.locator('h1')).toContainText('Packs y tratamientos');
  });

  test('muestra al menos una tarjeta de pack/tratamiento', async ({ page }) => {
    await page.goto('/packs');
    await expect(page.locator('.tratamientos--container__card-title').first()).toBeVisible();
  });

  test('la página responde sin errores en consola críticos', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/packs');
    await page.waitForLoadState('networkidle');
    expect(errors.filter((e) => !e.includes('favicon'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Página conócenos
// ---------------------------------------------------------------------------
test.describe('Página conócenos (/conocenos)', () => {
  test('carga sin redirección ni error 404', async ({ page }) => {
    const response = await page.goto('/conocenos');
    expect(response?.status()).not.toBe(404);
  });

  test('muestra contenido visible de la página', async ({ page }) => {
    await page.goto('/conocenos');
    await page.waitForLoadState('networkidle');
    // Debe haber al menos un elemento con texto visible
    await expect(page.locator('main, section, article').first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Página dónde estamos
// ---------------------------------------------------------------------------
test.describe('Página dónde estamos (/donde-estamos)', () => {
  test('carga sin error 404', async ({ page }) => {
    const response = await page.goto('/donde-estamos');
    expect(response?.status()).not.toBe(404);
  });

  test('muestra contenido de localización', async ({ page }) => {
    await page.goto('/donde-estamos');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('section').first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Rutas inexistentes
// ---------------------------------------------------------------------------
test.describe('Rutas no existentes', () => {
  test('redirige a inicio en lugar de mostrar 404', async ({ page }) => {
    await page.goto('/ruta-que-no-existe-xyz');
    // Angular redirige a '' con el wildcard route
    await expect(page).toHaveURL(/\//);
    await expect(page.locator('h1').first()).toContainText('Arena Hair Studio');
  });
});
