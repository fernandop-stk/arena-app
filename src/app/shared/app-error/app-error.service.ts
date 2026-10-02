import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface AppErrorToast {
  id: number;
  message: string;
  detail?: string;
}

const AUTO_DISMISS_MS = 12_000;
const MAX_VISIBLE = 4;

@Injectable({ providedIn: 'root' })
export class AppErrorService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  readonly toasts = signal<AppErrorToast[]>([]);

  show(message: string, detail?: string): void {
    const normalized = `${message ?? ''}`.trim();
    if (!this.isBrowser || !normalized) {
      return;
    }

    // Evita apilar el mismo aviso si una llamada se repite (p. ej. polling).
    const existing = this.toasts().find((toast) => toast.message === normalized);
    if (existing) {
      this.restartTimer(existing.id);
      return;
    }

    const toast: AppErrorToast = { id: this.nextId++, message: normalized, detail };
    this.toasts.update((current) => [...current, toast].slice(-MAX_VISIBLE));
    this.restartTimer(toast.id);
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.toasts.update((current) => current.filter((toast) => toast.id !== id));
  }

  private restartTimer(id: number): void {
    const previous = this.timers.get(id);
    if (previous) {
      clearTimeout(previous);
    }
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), AUTO_DISMISS_MS),
    );
  }
}
