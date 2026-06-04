import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

type RecuperacionStep = 'solicitud' | 'resetear';

@Component({
  selector: 'app-recuperar-contraseña',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './recuperar-contraseña.html',
  styleUrl: './recuperar-contraseña.scss',
})
export class RecuperarContraseñaComponent {
  private readonly uppercaseRegex = /[A-Z]/;
  private readonly specialCharRegex = /[^A-Za-z0-9]/;

  private readonly formBuilder = inject(FormBuilder);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly currentStep = signal<RecuperacionStep>('solicitud');
  protected readonly token = signal(this.route.snapshot.queryParams['token'] ?? '');

  protected readonly solicitudForm = this.formBuilder.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly resetForm = this.formBuilder.group(
    {
      password: [
        '',
        [Validators.required, Validators.minLength(8), this.passwordComplexityValidator()],
      ],
      confirmPassword: ['', [Validators.required]],
    },
    { validators: [this.passwordMatchValidator()] },
  );

  protected readonly isSubmitting = signal(false);
  protected readonly message = signal('');
  protected readonly errorMessage = signal('');
  protected readonly showPassword = signal(false);
  protected readonly showConfirmPassword = signal(false);

  constructor() {
    if (this.token()) {
      this.currentStep.set('resetear');
    }
  }

  protected togglePasswordVisibility(): void {
    this.showPassword.update((value) => !value);
  }

  protected toggleConfirmPasswordVisibility(): void {
    this.showConfirmPassword.update((value) => !value);
  }

  protected getPasswordStrengthLevel(): number {
    const password = this.resetForm.get('password')?.value ?? '';
    return this.calculatePasswordStrength(password);
  }

  protected getPasswordStrengthLabel(): string {
    const level = this.getPasswordStrengthLevel();

    if (level <= 1) {
      return 'Fortaleza: baja';
    }

    if (level === 2 || level === 3) {
      return 'Fortaleza: media';
    }

    return 'Fortaleza: alta';
  }

  protected passwordRuleOk(rule: 'length' | 'uppercase' | 'special'): boolean {
    const password = this.resetForm.get('password')?.value ?? '';

    switch (rule) {
      case 'length':
        return password.length >= 8;
      case 'uppercase':
        return this.uppercaseRegex.test(password);
      case 'special':
        return this.specialCharRegex.test(password);
    }
  }

  protected calculatePasswordStrength(password: string): number {
    let strength = 0;

    if (password.length >= 8) {
      strength += 1;
    }

    if (this.uppercaseRegex.test(password)) {
      strength += 1;
    }

    if (this.specialCharRegex.test(password)) {
      strength += 1;
    }

    return strength;
  }

  protected hasPasswordMismatch(): boolean {
    const confirmPassword = this.resetForm.get('confirmPassword');
    return Boolean(confirmPassword?.touched && this.resetForm.hasError('passwordMismatch'));
  }

  protected handleSolicitud(): void {
    if (this.solicitudForm.invalid || this.isSubmitting()) {
      return;
    }

    this.isSubmitting.set(true);
    this.errorMessage.set('');
    this.message.set('');

    const email = this.solicitudForm.get('email')?.value?.trim().toLowerCase();

    this.http
      .post<{ ok: boolean; error?: string }>('/api/cliente/solicitar-recuperacion', { email })
      .subscribe({
        next: (response) => {
          if (response.ok) {
            this.message.set(
              'Te hemos enviado un enlace de recuperación a tu email. Revisa tu bandeja de entrada o spam.',
            );
            this.solicitudForm.reset();
            setTimeout(() => {
              this.router.navigate(['/acceso']);
            }, 4000);
          } else {
            this.errorMessage.set(response.error ?? 'Error desconocido.');
            this.isSubmitting.set(false);
          }
        },
        error: (err: unknown) => {
          const errorMessage = (err as any)?.error?.error ?? 'Error de conexión. Intenta de nuevo.';
          this.errorMessage.set(errorMessage);
          this.isSubmitting.set(false);
        },
      });
  }

  protected handleReset(): void {
    if (this.resetForm.invalid || this.isSubmitting() || !this.token()) {
      return;
    }

    this.isSubmitting.set(true);
    this.errorMessage.set('');
    this.message.set('');

    const resetData = {
      token: this.token(),
      password: this.resetForm.get('password')?.value,
    };

    this.http
      .post<{ ok: boolean; error?: string }>('/api/cliente/resetear-contraseña', resetData)
      .subscribe({
        next: (response) => {
          if (response.ok) {
            this.message.set('¡Contraseña actualizada exitosamente! Redirigiendo a acceso...');
            setTimeout(() => {
              this.router.navigate(['/acceso']);
            }, 2000);
          } else {
            this.errorMessage.set(response.error ?? 'Error desconocido.');
            this.isSubmitting.set(false);
          }
        },
        error: (err: unknown) => {
          const errorMessage = (err as any)?.error?.error ?? 'Error de conexión. Intenta de nuevo.';
          this.errorMessage.set(errorMessage);
          this.isSubmitting.set(false);
        },
      });
  }

  private passwordMatchValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const password = control.get('password');
      const confirmPassword = control.get('confirmPassword');

      if (!password || !confirmPassword) {
        return null;
      }

      return password.value === confirmPassword.value ? null : { passwordMismatch: true };
    };
  }

  private passwordComplexityValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;

      if (!value) {
        return null;
      }

      const hasUppercase = this.uppercaseRegex.test(value);
      const hasSpecial = this.specialCharRegex.test(value);

      if (!hasUppercase || !hasSpecial) {
        return { passwordComplexity: true };
      }

      return null;
    };
  }
}
