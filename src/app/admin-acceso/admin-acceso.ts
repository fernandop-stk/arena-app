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

@Component({
  selector: 'app-admin-acceso',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './admin-acceso.html',
  styleUrl: './admin-acceso.scss',
})
export class AdminAccesoComponent {
  private readonly uppercaseRegex = /[A-Z]/;
  private readonly specialCharRegex = /[^A-Za-z0-9]/;

  private readonly formBuilder = inject(FormBuilder);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly isRegisterMode = signal(this.route.snapshot.routeConfig?.path === 'registro');

  protected readonly loginForm = this.formBuilder.group({
    identity: ['', [Validators.required]],
    password: ['', [Validators.required]],
  });

  protected readonly registerForm = this.formBuilder.group(
    {
      username: ['', [Validators.required, Validators.minLength(3)]],
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
  protected readonly showLoginPassword = signal(false);
  protected readonly showRegisterPassword = signal(false);
  protected readonly showConfirmPassword = signal(false);

  protected toggleLoginPasswordVisibility(): void {
    this.showLoginPassword.update((value) => !value);
  }

  protected toggleRegisterPasswordVisibility(): void {
    this.showRegisterPassword.update((value) => !value);
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

    if (rule === 'length') {
      return password.length >= 8;
    }

    if (rule === 'uppercase') {
      return this.uppercaseRegex.test(password);
    }

    return this.specialCharRegex.test(password);
  }

  protected setMode(registerMode: boolean): void {
    this.isRegisterMode.set(registerMode);
    this.message.set('');
    this.errorMessage.set('');

    if (registerMode) {
      void this.router.navigate(['/registro']);
      return;
    }

    void this.router.navigate(['/acceso']);
  }

  protected submitLogin(): void {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    const identity = this.loginForm.get('identity')?.value ?? '';
    const password = this.loginForm.get('password')?.value ?? '';

    this.isSubmitting.set(true);
    this.errorMessage.set('');
    this.message.set('');

    this.http
      .post<{ ok: boolean; error?: string }>('/api/auth/login', {
        identity,
        password,
      })
      .subscribe({
        next: () => {
          void this.router.navigate(['/']);
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.errorMessage.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo iniciar sesión. Inténtalo de nuevo.',
          );
        },
        complete: () => {
          this.isSubmitting.set(false);
        },
      });
  }

  protected submitRegister(): void {
    if (this.registerForm.invalid) {
      this.registerForm.markAllAsTouched();
      return;
    }

    const username = this.registerForm.get('username')?.value ?? '';
    const email = this.registerForm.get('email')?.value ?? '';
    const password = this.registerForm.get('password')?.value ?? '';

    this.isSubmitting.set(true);
    this.errorMessage.set('');
    this.message.set('');

    this.http
      .post<{ ok: boolean; error?: string }>('/api/auth/register', {
        username,
        email,
        password,
      })
      .subscribe({
        next: () => {
          this.message.set(
            'Cuenta creada. Ya puedes reservar y, si corresponde, acceder al panel.',
          );
          void this.router.navigate(['/']);
        },
        error: (error) => {
          const apiError = error?.error?.error;
          this.errorMessage.set(
            typeof apiError === 'string' && apiError
              ? apiError
              : 'No se pudo crear la cuenta. Inténtalo de nuevo.',
          );
        },
        complete: () => {
          this.isSubmitting.set(false);
        },
      });
  }

  private passwordComplexityValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = `${control.value ?? ''}`;

      if (!value) {
        return null;
      }

      const hasUppercase = this.uppercaseRegex.test(value);
      const hasSpecial = this.specialCharRegex.test(value);

      if (hasUppercase && hasSpecial) {
        return null;
      }

      return {
        ...(hasUppercase ? {} : { missingUppercase: true }),
        ...(hasSpecial ? {} : { missingSpecialChar: true }),
      };
    };
  }

  private passwordMatchValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const password = control.get('password')?.value ?? '';
      const confirmPassword = control.get('confirmPassword')?.value ?? '';

      if (!password || !confirmPassword) {
        return null;
      }

      return password === confirmPassword ? null : { passwordMismatch: true };
    };
  }

  private calculatePasswordStrength(password: string): number {
    if (!password) {
      return 0;
    }

    let score = 0;

    if (password.length >= 8) score += 1;
    if (/[a-z]/.test(password)) score += 1;
    if (this.uppercaseRegex.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (this.specialCharRegex.test(password)) score += 1;

    if (score <= 1) return 1;
    if (score <= 3) return 2;
    if (score === 4) return 3;
    return 4;
  }
}
