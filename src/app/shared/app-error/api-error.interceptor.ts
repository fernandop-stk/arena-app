import {
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  HttpInterceptorFn,
  HttpResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { tap, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AppErrorService } from './app-error.service';

/** Marca una petición para que sus errores no muestren el aviso global. */
export const SKIP_GLOBAL_ERROR_TOAST = new HttpContextToken<boolean>(() => false);

export const silentErrorsContext = (): HttpContext =>
  new HttpContext().set(SKIP_GLOBAL_ERROR_TOAST, true);

const FALLBACK_BY_STATUS: Record<number, string> = {
  0: 'No hay conexión con el servidor. Comprueba tu conexión e inténtalo de nuevo.',
  400: 'La petición no es válida. Revisa los datos e inténtalo de nuevo.',
  401: 'Tu sesión ha caducado o no estás autorizada. Vuelve a iniciar sesión.',
  403: 'No tienes permisos para realizar esta acción.',
  404: 'No se ha encontrado lo que buscabas.',
  409: 'La operación no se puede completar por un conflicto con los datos actuales.',
  429: 'Demasiadas peticiones seguidas. Espera un momento.',
  500: 'Error interno del servidor. Inténtalo de nuevo en unos segundos.',
  502: 'El servidor no responde. Inténtalo de nuevo en unos segundos.',
  503: 'El servicio no está disponible temporalmente.',
  504: 'El servidor ha tardado demasiado en responder.',
};

const extractServerMessage = (body: unknown): string => {
  if (!body || typeof body !== 'object') {
    return typeof body === 'string' ? body.trim() : '';
  }
  const candidate = (body as { error?: unknown; message?: unknown }).error ??
    (body as { message?: unknown }).message;
  return typeof candidate === 'string' ? candidate.trim() : '';
};

const describeRequest = (method: string, url: string, status?: number): string => {
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  return `${method} ${path}${status ? ` · HTTP ${status}` : ''}`;
};

export const apiErrorInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.includes('/api/') || req.context.get(SKIP_GLOBAL_ERROR_TOAST)) {
    return next(req);
  }

  const errors = inject(AppErrorService);

  return next(req).pipe(
    tap((event) => {
      // Algunos endpoints devuelven 200 con { ok: false, error } en lugar de un código de error.
      if (event instanceof HttpResponse) {
        const body = event.body as { ok?: unknown } | null;
        if (body && typeof body === 'object' && body.ok === false) {
          const message = extractServerMessage(body);
          if (message) {
            errors.show(message, describeRequest(req.method, req.url));
          }
        }
      }
    }),
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse) {
        const serverMessage = extractServerMessage(error.error);
        const message =
          serverMessage ||
          FALLBACK_BY_STATUS[error.status] ||
          'Se ha producido un error inesperado. Inténtalo de nuevo.';
        errors.show(message, describeRequest(req.method, req.url, error.status));
      }
      return throwError(() => error);
    }),
  );
};
