import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { RouterLink } from '@angular/router';
import { CitasService } from './citas.service';

@Component({
  selector: 'app-citas',
  imports: [RouterLink],
  templateUrl: './citas.html',
  styleUrl: './citas.scss',
})
export class CitasComponent {
  protected readonly citasService = inject(CitasService);
  private readonly route = inject(ActivatedRoute);

  protected readonly salonName = this.citasService.getSalonName();
  protected readonly headline = this.citasService.getHeadline();
  protected readonly description = this.citasService.getDescription();
  protected readonly buttonLabel = this.citasService.getPrimaryButtonLabel();
  protected readonly appointmentTypes = this.citasService.getAppointmentTypes();
  protected readonly preInvitadaAppointmentTypes = this.appointmentTypes.filter(
    (appointment) => appointment.id < 8,
  );
  protected readonly invitadaOptions = this.appointmentTypes.filter(
    (appointment) => appointment.id >= 8 && appointment.id <= 10,
  );
  protected readonly postInvitadaAppointmentTypes = this.appointmentTypes.filter(
    (appointment) => appointment.id > 10,
  );
  protected readonly selectedAppointmentTypeId = signal(
    this.citasService.getSelectedTypeFromQuery(
      this.route.snapshot.queryParamMap.get('tipo'),
      this.appointmentTypes,
    ),
  );
  protected readonly isInvitadaExpanded = signal(false);
  protected readonly isInvitadaSelected = computed(() =>
    this.invitadaOptions.some((option) => option.id === this.selectedAppointmentTypeId()),
  );

  protected selectAppointment(id: number): void {
    this.selectedAppointmentTypeId.set(id);
  }

  protected toggleInvitadaOptions(): void {
    this.isInvitadaExpanded.update((value) => !value);
  }
}
