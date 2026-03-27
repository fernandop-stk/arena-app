# ArenaApp

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.1.2.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Admin access

Entra a /admin/acceso.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.

## Envío de emails con Resend

La app incluye un endpoint backend en SSR: `/api/reservas/email`.

Variables de entorno necesarias:

- `DATABASE_URL`: conexión PostgreSQL para guardar reservas y bloquear horas en producción.
- `RESEND_API_KEY`: API key de Resend.
- `RESEND_FROM_EMAIL`: remitente verificado en Resend (opcional; por defecto `onboarding@resend.dev`).

Configuración local recomendada:

- Copia [arena-app/.env.example](.env.example) a [arena-app/.env](.env).
- Rellena `DATABASE_URL`, `RESEND_API_KEY` y `RESEND_FROM_EMAIL`.
- El servidor SSR ya carga automáticamente `.env` con `dotenv`.

Ejemplo en PowerShell (temporal para la sesión):

- `$env:RESEND_API_KEY="re_xxx"`
- `$env:RESEND_FROM_EMAIL="reservas@tu-dominio.com"`

Después, compila y arranca SSR:

- `npm run build`
- `npm run serve:ssr:arena-app`

## Despliegue en Render

El proyecto ya incluye [arena-app/render.yaml](render.yaml) listo para desplegar como Web Service con SSR.

En Render, configura estas variables en el servicio:

- `DATABASE_URL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

Render usará:

- Build: `npm ci && npm run build`
- Start: `npm run serve:ssr:arena-app`

## Despliegue en Vercel

El proyecto ya incluye [arena-app/vercel.json](vercel.json) y una función serverless en [arena-app/api/reservas/email.ts](api/reservas/email.ts).

En Vercel (Project Settings → Environment Variables), define:

- `DATABASE_URL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

La app se publica como SPA estática y el envío de emails se resuelve por la función `/api/reservas/email`.

## Checklist rápido cuando no llegan correos

1. En [arena-app/.env](.env), usa valores reales (no placeholders).
2. En Resend, verifica tu dominio y configura `RESEND_FROM_EMAIL` con ese dominio.
3. Arranca con SSR (`serve:ssr`), no solo con `ng serve`.
4. Revisa en Resend el estado del envío (Delivered, Bounced, Rejected).

## Bloqueo real de horas en producción

Ahora el bloqueo de horas se persiste en PostgreSQL:

- `reservation_slots` guarda cada bloque de 30 minutos reservado.
- La clave primaria `(date_iso, slot_time)` impide doble reserva incluso con concurrencia.
- La creación de reserva se hace en transacción y, si falla el email, se elimina la reserva para liberar hueco.

## Verificar dominio en Resend

1. Resend Dashboard → Domains → Add Domain.
2. Añade los registros DNS que te pide Resend (SPF/DKIM).
3. Espera estado `Verified`.
4. Define un remitente del dominio verificado, por ejemplo `reservas@tu-dominio.com`.
5. Coloca ese email en `RESEND_FROM_EMAIL` dentro de [arena-app/.env](.env).
