import { isPlatformServer } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { inject, PLATFORM_ID } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';

export const adminRoleGuard: CanActivateFn = () => {
  const platformId = inject(PLATFORM_ID);

  if (isPlatformServer(platformId)) {
    return true;
  }

  const http = inject(HttpClient);
  const router = inject(Router);

  return http.get<{ ok: boolean; isAdmin: boolean }>('/api/auth/session').pipe(
    map((response) => (response?.isAdmin ? true : router.createUrlTree(['/acceso']))),
    catchError(() => of(router.createUrlTree(['/acceso']))),
  );
};
