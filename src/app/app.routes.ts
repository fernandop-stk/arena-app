import { Routes } from '@angular/router';
import { AdminAccesoComponent } from './admin-acceso/admin-acceso';
import { AdminPanelComponent } from './admin-panel/admin-panel';
import { adminRoleGuard } from './admin-role.guard';
import { DondeEstamosComponent } from './donde-estamos/donde-estamos';
import { CitasComponent } from './citas/citas';
import { ClienteAreaComponent } from './cliente-area/cliente-area';
import { ClienteRegistroComponent } from './cliente-registro/cliente-registro';
import { HistoriaComponent } from './historia/historia';
import { InicioComponent } from './inicio/inicio';
import { ReservaCalendarioComponent } from './reserva-calendario/reserva-calendario';
import { ReservaFormularioComponent } from './reserva-formulario/reserva-formulario';
import { TratamientosComponent } from './tratamientos/tratamientos';

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
    component: AdminAccesoComponent,
  },
  {
    path: 'registro',
    component: AdminAccesoComponent,
  },
  {
    path: 'cliente/registro',
    component: ClienteRegistroComponent,
  },
  {
    path: 'cliente/area',
    component: ClienteAreaComponent,
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
    component: AdminPanelComponent,
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
