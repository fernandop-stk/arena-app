# Sistema visual Arena Hair Studio

Fuente del sistema: [public/assets/info/ARENAHAIRSTUDIOIDC.pdf](../public/assets/info/ARENAHAIRSTUDIOIDC.pdf)

## Tipografías detectadas

- `Agrandir Grand` (display / titulares marca)
- `The Seasons` (titulares)
- `Neue Montreal` (texto UI)
- `Montserrat` (fallback UI)

## Paleta base aplicada

- `#806855` (primary)
- `#C3B6A3` (secondary)
- `#DAD3C8` (border / accent soft)
- `#F1F1F0` (background)

## Tokens actualizados

- [src/styles/variables/\_colors.scss](../src/styles/variables/_colors.scss)
- [src/styles/variables/\_typography.scss](../src/styles/variables/_typography.scss)
- [src/styles.scss](../src/styles.scss)

## Ajustes de UI realizados

- Shell global (header/nav/cta): [src/app/app.scss](../src/app/app.scss)
- Inicio (hero y tarjetas): [src/app/inicio/inicio.scss](../src/app/inicio/inicio.scss)
- Admin panel (títulos principales): [src/app/admin-panel/admin-panel.scss](../src/app/admin-panel/admin-panel.scss)

## Cómo revertir si no convence

1. Restaurar estos archivos desde Git.
2. O volver a la paleta previa en [src/styles/variables/\_colors.scss](../src/styles/variables/_colors.scss).
3. Quitar `@use './styles/variables/typography'` de [src/styles.scss](../src/styles.scss) si quieres volver a tipografía anterior.

## Siguiente fase recomendada

- Aplicación fina componente a componente (`citas`, `reserva-calendario`, `reserva-formulario`, `cliente-area`, `tratamientos`) para nivelar pesos tipográficos y contraste por pantalla.
