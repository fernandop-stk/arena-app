import { Component, inject, signal } from '@angular/core';
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
  protected readonly selectedAppointmentTypeId = signal(
    this.citasService.getSelectedTypeFromQuery(
      this.route.snapshot.queryParamMap.get('tipo'),
      this.appointmentTypes,
    ),
  );
}
