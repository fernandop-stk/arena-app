import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export type NotificationType =
  | 'nueva_reserva'
  | 'cancelacion_reserva'
  | 'reserva_confirmada'
  | 'reserva_expirada'
  | 'pago_recibido'
  | 'cliente_nuevo'
  | 'empleado_nuevo'
  | 'aviso_importante'
  | 'otra';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
  relatedId?: string; // ID de reserva, cliente, etc.
  actionUrl?: string; // URL para navegar al recurso relacionado
}

export interface NotificationPayload {
  type: NotificationType;
  title: string;
  message: string;
  relatedId?: string;
  actionUrl?: string;
}

@Injectable({
  providedIn: 'root',
})
export class NotificationService {
  private readonly http = inject(HttpClient);

  private notifications = signal<Notification[]>([]);
  public unreadCount = signal(0);

  /**
   * Obtiene todas las notificaciones
   */
  get notifications$() {
    return this.notifications;
  }

  /**
   * Obtiene solo las notificaciones no leídas
   */
  get unreadNotifications() {
    return this.notifications().filter((n) => !n.read);
  }

  /**
   * Inicializa el servicio cargando notificaciones desde el servidor
   */
  async initializeNotifications(): Promise<void> {
    try {
      const response = await fetch('/api/notifications');
      if (response.ok) {
        const data = await response.json();
        this.notifications.set(data.notifications || []);
        this.updateUnreadCount();
      }
    } catch (error) {
      console.error('Error loading notifications:', error);
    }
  }

  /**
   * Crea una nueva notificación localmente y la envía al servidor
   */
  async createNotification(payload: NotificationPayload): Promise<Notification | null> {
    try {
      const response = await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json();
        const newNotification = data.notification;

        // Actualizar lista local
        this.notifications.update((current) => [newNotification, ...current]);
        this.updateUnreadCount();

        return newNotification;
      }
    } catch (error) {
      console.error('Error creating notification:', error);
    }

    return null;
  }

  /**
   * Marca una notificación como leída
   */
  async markAsRead(notificationId: string): Promise<void> {
    try {
      await fetch(`/api/notifications/${notificationId}/read`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      });

      // Actualizar lista local
      this.notifications.update((current) =>
        current.map((n) => (n.id === notificationId ? { ...n, read: true } : n)),
      );
      this.updateUnreadCount();
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  }

  /**
   * Marca todas las notificaciones como leídas
   */
  async markAllAsRead(): Promise<void> {
    try {
      await fetch('/api/notifications/read-all', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      });

      // Actualizar lista local
      this.notifications.update((current) => current.map((n) => ({ ...n, read: true })));
      this.updateUnreadCount();
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
    }
  }

  /**
   * Elimina una notificación
   */
  async deleteNotification(notificationId: string): Promise<void> {
    try {
      await fetch(`/api/notifications/${notificationId}`, {
        method: 'DELETE',
      });

      // Actualizar lista local
      this.notifications.update((current) => current.filter((n) => n.id !== notificationId));
      this.updateUnreadCount();
    } catch (error) {
      console.error('Error deleting notification:', error);
    }
  }

  /**
   * Elimina todas las notificaciones leídas
   */
  async clearRead(): Promise<void> {
    try {
      await fetch('/api/notifications/clear-read', {
        method: 'DELETE',
      });

      // Actualizar lista local
      this.notifications.update((current) => current.filter((n) => !n.read));
      this.updateUnreadCount();
    } catch (error) {
      console.error('Error clearing read notifications:', error);
    }
  }

  /**
   * Actualiza el contador de notificaciones no leídas
   */
  private updateUnreadCount(): void {
    this.unreadCount.set(this.unreadNotifications.length);
  }

  /**
   * Poll para nuevas notificaciones (ejecutar periódicamente)
   */
  startPolling(intervalMs: number = 30000): void {
    setInterval(() => {
      this.initializeNotifications();
    }, intervalMs);
  }
}
