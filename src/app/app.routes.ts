import { Routes } from '@angular/router';
import { adminRoleGuard } from './admin-role.guard';
import { DondeEstamosComponent } from './donde-estamos/donde-estamos';
import { CitasComponent } from './citas/citas';
import { HistoriaComponent } from './historia/historia';
import { InicioComponent } from './inicio/inicio';
import { ReservaCalendarioComponent } from './reserva-calendario/reserva-calendario';
import { ReservaFormularioComponent } from './reserva-formulario/reserva-formulario';
import { TratamientosComponent } from './tratamientos/tratamientos';

// El panel admin y las pantallas de acceso se cargan bajo demanda para mantener el bundle inicial dentro del presupuesto.
const loadAdminAcceso = () =>
  import('./admin-acceso/admin-acceso').then((m) => m.AdminAccesoComponent);

export const routes: Routes = [
  {
    path: '',
    component: InicioComponent,
  },
  {
    path: 'packs',
    component: TratamientosComponent,
  },
  {
    path: 'reservas',
    component: CitasComponent,
  },
  {
    path: 'reservas/calendario',
    component: ReservaCalendarioComponent,
  },
  {
    path: 'reservas/datos',
    component: ReservaFormularioComponent,
  },
  {
    path: 'conocenos',
    component: HistoriaComponent,
  },
  {
    path: 'donde-estamos',
    component: DondeEstamosComponent,
  },
  {
    path: 'acceso',
    loadComponent: loadAdminAcceso,
  },
  {
    path: 'registro',
    loadComponent: loadAdminAcceso,
  },
  {
    path: 'cliente/registro',
    loadComponent: () =>
      import('./cliente-registro/cliente-registro').then((m) => m.ClienteRegistroComponent),
  },
  {
    path: 'cliente/area',
    loadComponent: () => import('./cliente-area/cliente-area').then((m) => m.ClienteAreaComponent),
  },
  {
    path: 'cliente/recuperar',
    loadComponent: () =>
      import('./recuperar-contrasena/recuperar-contrasena').then(
        (m) => m.RecuperarContrasenaComponent,
      ),
  },
  {
    path: 'admin/acceso',
    redirectTo: 'acceso',
  },
  {
    path: 'admin',
    loadComponent: () => import('./admin-panel/admin-panel').then((m) => m.AdminPanelComponent),
    canActivate: [adminRoleGuard],
  },
  {
    path: 'reserva',
    redirectTo: 'reservas/calendario',
  },
  {
    path: 'reserva/datos',
    redirectTo: 'reservas/datos',
  },
  {
    path: '**',
    redirectTo: '',
  },
];
