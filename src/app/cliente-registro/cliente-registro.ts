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
import { Router, RouterLink } from '@angular/router';

@Component({
  selector: 'app-cliente-registro',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './cliente-registro.html',
  styleUrl: './cliente-registro.scss',
})
export class ClienteRegistroComponent {
  private readonly uppercaseRegex = /[A-Z]/;
  private readonly specialCharRegex = /[^A-Za-z0-9]/;

  private readonly formBuilder = inject(FormBuilder);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  protected readonly registerForm = this.formBuilder.group(
    {
      nombre: ['', [Validators.required, Validators.minLength(2)]],
      apellidos: ['', [Validators.required, Validators.minLength(2)]],
      fechaNacimiento: ['', [Validators.required]],
      telefono: ['', [Validators.required, Validators.pattern(/^\d{9,}$/)]],
      email: ['', [Validators.required, Validators.email]],
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

  protected togglePasswordVisibility(): void {
    this.showPassword.update((value) => !value);
  }

  protected toggleConfirmPasswordVisibility(): void {
    this.showConfirmPassword.update((value) => !value);
  }

  protected getPasswordStrengthLevel(): number {
    const password = this.registerForm.get('password')?.value ?? '';
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

  protected hasRegisterControlError(
    controlName: 'password' | 'confirmPassword',
    error: string,
  ): boolean {
    const control = this.registerForm.get(controlName);
    return Boolean(control?.touched && control?.hasError(error));
  }

  protected hasPasswordMismatch(): boolean {
    const confirmPassword = this.registerForm.get('confirmPassword');
    return Boolean(confirmPassword?.touched && this.registerForm.hasError('passwordMismatch'));
  }

  protected passwordRuleOk(rule: 'length' | 'uppercase' | 'special'): boolean {
    const password = this.registerForm.get('password')?.value ?? '';

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

  protected handleSubmit(): void {
    if (this.registerForm.invalid || this.isSubmitting()) {
      return;
    }

    this.isSubmitting.set(true);
    this.errorMessage.set('');
    this.message.set('');

    const formValue = this.registerForm.value;
    const registrationData = {
      nombre: formValue.nombre?.trim(),
      apellidos: formValue.apellidos?.trim(),
      fechaNacimiento: formValue.fechaNacimiento,
      telefono: formValue.telefono?.trim(),
      email: formValue.email?.trim().toLowerCase(),
      password: formValue.password,
    };

    this.http
      .post<{ ok: boolean; error?: string; id?: string }>('/api/cliente/registro', registrationData)
      .subscribe({
        next: (response) => {
          if (response.ok) {
            this.message.set('¡Registro completado! Redirigiendo a acceso...');
            setTimeout(() => {
              this.router.navigate(['/acceso']);
            }, 2000);
          } else {
            this.errorMessage.set(response.error ?? 'Error desconocido al registrar.');
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
