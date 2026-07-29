import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-notification-badge',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="notification-badge-container">
      @if (notificationService.recentNotificationToast()) {
        <div class="notification-toast" role="status" aria-live="polite">
          {{ notificationService.recentNotificationToast() }}
        </div>
      }

      <button
        class="notification-badge"
        [class.has-unread]="notificationService.unreadCount() > 0"
        (click)="toggleNotificationsPanel()"
        aria-label="Notificaciones"
      >
        <span class="notification-badge__icon">🔔</span>
        @if (notificationService.unreadCount() > 0) {
          <span class="notification-badge__count">{{ notificationService.unreadCount() }}</span>
        }
      </button>

      @if (showPanel()) {
        <div class="notification-panel">
          <div class="notification-panel__header">
            <h3 class="notification-panel__title">Notificaciones</h3>
            @if (notificationService.unreadCount() > 0) {
              <button class="notification-panel__clear-btn" (click)="markAllAsRead()" type="button">
                Marcar todo como leído
              </button>
            }
          </div>

          <div class="notification-panel__list">
            @if (notificationService.notifications$().length === 0) {
              <div class="notification-panel__empty">
                <p>No hay notificaciones</p>
              </div>
            } @else {
              @for (notification of notificationService.notifications$(); track notification.id) {
                <div
                  class="notification-item"
                  [class.notification-item--unread]="!notification.read"
                >
                  <div class="notification-item__content">
                    <h4 class="notification-item__title">{{ notification.title }}</h4>
                    <p class="notification-item__message">{{ notification.message }}</p>
                    <span class="notification-item__time">
                      {{ formatTime(notification.createdAt) }}
                    </span>
                  </div>

                  <div class="notification-item__actions">
                    @if (!notification.read) {
                      <button
                        class="notification-item__action-btn"
                        (click)="markAsRead(notification.id)"
                        title="Marcar como leído"
                        type="button"
                      >
                        ✓
                      </button>
                    }
                    <button
                      class="notification-item__action-btn notification-item__action-btn--delete"
                      (click)="deleteNotification(notification.id)"
                      title="Eliminar"
                      type="button"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              }
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .notification-badge-container {
      position: relative;
      display: inline-block;
    }

    .notification-toast {
      position: absolute;
      right: 0;
      bottom: calc(100% + 10px);
      min-width: 13rem;
      max-width: 18rem;
      padding: 0.65rem 0.85rem;
      border-radius: 999px;
      background: linear-gradient(135deg, #c97b63 0%, #d9a441 100%);
      color: #fff;
      font-size: 0.82rem;
      font-weight: 700;
      line-height: 1.2;
      box-shadow: 0 10px 22px rgba(121, 92, 69, 0.18);
      z-index: 1001;
      animation: notification-toast-in 0.2s ease-out;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }

    @keyframes notification-toast-in {
      from {
        opacity: 0;
        transform: translateY(0.35rem) scale(0.98);
      }

      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .notification-badge {
      position: relative;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 24px;
      padding: 8px;
      border-radius: 50%;
      transition: background-color 0.2s ease;

      &:hover {
        background-color: rgba(0, 0, 0, 0.05);
      }

      &.has-unread {
        filter: drop-shadow(0 0 4px rgba(255, 71, 87, 0.4));
      }
    }

    .notification-badge__icon {
      display: block;
    }

    .notification-badge__count {
      position: absolute;
      top: 0;
      right: 0;
      background-color: #ff4757;
      color: white;
      border-radius: 50%;
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: bold;
      border: 2px solid white;
    }

    .notification-panel {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background-color: white;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      width: 360px;
      max-height: 500px;
      display: flex;
      flex-direction: column;
      z-index: 1000;
    }

    .notification-panel__header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px;
      border-bottom: 1px solid #f0f0f0;
    }

    .notification-panel__title {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: #333;
    }

    .notification-panel__clear-btn {
      background: none;
      border: none;
      color: #2196f3;
      cursor: pointer;
      font-size: 12px;
      text-decoration: none;
      padding: 4px 8px;

      &:hover {
        text-decoration: underline;
      }
    }

    .notification-panel__list {
      flex: 1;
      overflow-y: auto;
    }

    .notification-panel__empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100px;
      color: #999;
      font-size: 14px;
    }

    .notification-item {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 12px 16px;
      border-bottom: 1px solid #f5f5f5;
      background-color: #fafafa;

      &--unread {
        background-color: #e3f2fd;
      }

      &:hover {
        background-color: #f0f0f0;

        &--unread {
          background-color: #bbdefb;
        }
      }
    }

    .notification-item__content {
      flex: 1;
    }

    .notification-item__title {
      margin: 0 0 4px 0;
      font-size: 14px;
      font-weight: 600;
      color: #333;
    }

    .notification-item__message {
      margin: 0 0 6px 0;
      font-size: 13px;
      color: #666;
      line-height: 1.4;
    }

    .notification-item__time {
      font-size: 11px;
      color: #999;
    }

    .notification-item__actions {
      display: flex;
      gap: 6px;
      margin-left: 12px;
    }

    .notification-item__action-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 14px;
      padding: 4px 6px;
      color: #666;
      transition: color 0.2s ease;

      &:hover {
        color: #333;
      }

      &--delete:hover {
        color: #ff4757;
      }
    }
  `,
})
export class NotificationBadgeComponent implements OnInit, OnDestroy {
  readonly notificationService = inject(NotificationService);
  protected showPanel = signal(false);
  private readonly refreshStorageKey = 'arena-app:notifications:refresh';
  private readonly onStorageChange = (event: StorageEvent): void => {
    if (event.key !== this.refreshStorageKey) {
      return;
    }

    void this.notificationService.initializeNotifications();
  };

  protected toggleNotificationsPanel() {
    this.showPanel.update((current) => !current);
  }

  protected markAsRead(notificationId: string) {
    this.notificationService.markAsRead(notificationId);
  }

  protected markAllAsRead() {
    this.notificationService.markAllAsRead();
  }

  protected deleteNotification(notificationId: string) {
    this.notificationService.deleteNotification(notificationId);
  }

  protected formatTime(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Hace un momento';
    if (diffMins < 60) return `Hace ${diffMins} min`;
    if (diffHours < 24) return `Hace ${diffHours}h`;
    if (diffDays < 7) return `Hace ${diffDays}d`;

    return date.toLocaleDateString('es-ES');
  }

  ngOnInit() {
    // Inicializar notificaciones al crear el componente
    this.notificationService.initializeNotifications();
    this.notificationService.startRealtimeUpdates();
    // Poll cada 30 segundos para nuevas notificaciones
    this.notificationService.startPolling(30000);

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.onStorageChange);
    }
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.onStorageChange);
    }
  }
}
