import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

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
  relatedId?: string;
  actionUrl?: string;
}

export interface NotificationPayload {
  type: NotificationType;
  title: string;
  message: string;
  relatedId?: string;
  actionUrl?: string;
}

let notificationsPool: Pool | null = null;
let notificationsSchemaReady = false;
const notificationsMemory = new Map<string, Notification>();
const NOTIFICATIONS_CACHE_FILE = path.join(process.cwd(), '.dev-notifications-cache.json');

export function setNotificationsPool(pool: Pool) {
  notificationsPool = pool;
}

export function getNotificationsPool(): Pool | null {
  return notificationsPool;
}

const getUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

/**
 * Inicializa el esquema de notificaciones en PostgreSQL
 */
export async function initializeNotificationsSchema(pool: Pool): Promise<void> {
  if (notificationsSchemaReady) return;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id VARCHAR(36) PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        related_id VARCHAR(36),
        action_url VARCHAR(500)
      );

      CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
      CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
    `);
    notificationsSchemaReady = true;
  } catch (error) {
    console.error('Error initializing notifications schema:', error);
  }
}

/**
 * Carga notificaciones desde el archivo de caché (modo desarrollo)
 */
function loadNotificationsFromCache(): void {
  try {
    if (fs.existsSync(NOTIFICATIONS_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(NOTIFICATIONS_CACHE_FILE, 'utf-8'));
      notificationsMemory.clear();
      data.forEach((notification: Notification) => {
        notificationsMemory.set(notification.id, notification);
      });
    }
  } catch (error) {
    console.error('Error loading notifications cache:', error);
  }
}

/**
 * Guarda notificaciones en el archivo de caché (modo desarrollo)
 */
function saveNotificationsToCache(): void {
  try {
    const notifications = Array.from(notificationsMemory.values());
    fs.writeFileSync(NOTIFICATIONS_CACHE_FILE, JSON.stringify(notifications, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving notifications cache:', error);
  }
}

/**
 * Convierte resultado de PostgreSQL a Notification
 */
function rowToNotification(row: any): Notification {
  return {
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    message: row.message,
    read: row.read,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    relatedId: row.related_id || undefined,
    actionUrl: row.action_url || undefined,
  };
}

/**
 * Crea una nueva notificación
 */
export async function createNotification(payload: NotificationPayload): Promise<Notification> {
  const id = getUUID();
  const createdAt = new Date().toISOString();

  const notification: Notification = {
    id,
    type: payload.type,
    title: payload.title,
    message: payload.message,
    read: false,
    createdAt,
    relatedId: payload.relatedId,
    actionUrl: payload.actionUrl,
  };

  if (notificationsPool) {
    try {
      await notificationsPool.query(
        `INSERT INTO notifications (id, type, title, message, read, created_at, related_id, action_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          notification.type,
          notification.title,
          notification.message,
          false,
          createdAt,
          payload.relatedId || null,
          payload.actionUrl || null,
        ],
      );
    } catch (error) {
      console.error('Error creating notification in DB:', error);
    }
  } else {
    // Memory mode
    loadNotificationsFromCache();
    notificationsMemory.set(id, notification);
    saveNotificationsToCache();
  }

  return notification;
}

/**
 * Obtiene todas las notificaciones, ordenadas por más recientes primero
 */
export async function getAllNotifications(): Promise<Notification[]> {
  if (notificationsPool) {
    try {
      const result = await notificationsPool.query(
        'SELECT * FROM notifications ORDER BY created_at DESC',
      );
      return result.rows.map(rowToNotification);
    } catch (error) {
      console.error('Error fetching notifications from DB:', error);
      return [];
    }
  } else {
    // Memory mode
    loadNotificationsFromCache();
    const notifications = Array.from(notificationsMemory.values());
    notifications.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return notifications;
  }
}

/**
 * Obtiene las notificaciones no leídas
 */
export async function getUnreadNotifications(): Promise<Notification[]> {
  if (notificationsPool) {
    try {
      const result = await notificationsPool.query(
        'SELECT * FROM notifications WHERE read = FALSE ORDER BY created_at DESC',
      );
      return result.rows.map(rowToNotification);
    } catch (error) {
      console.error('Error fetching unread notifications from DB:', error);
      return [];
    }
  } else {
    // Memory mode
    loadNotificationsFromCache();
    const notifications = Array.from(notificationsMemory.values()).filter((n) => !n.read);
    notifications.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return notifications;
  }
}

/**
 * Marca una notificación como leída
 */
export async function markNotificationAsRead(notificationId: string): Promise<void> {
  if (notificationsPool) {
    try {
      await notificationsPool.query('UPDATE notifications SET read = TRUE WHERE id = $1', [
        notificationId,
      ]);
    } catch (error) {
      console.error('Error marking notification as read in DB:', error);
    }
  } else {
    // Memory mode
    loadNotificationsFromCache();
    const notification = notificationsMemory.get(notificationId);
    if (notification) {
      notification.read = true;
      notificationsMemory.set(notificationId, notification);
      saveNotificationsToCache();
    }
  }
}

/**
 * Marca todas las notificaciones como leídas
 */
export async function markAllNotificationsAsRead(): Promise<void> {
  if (notificationsPool) {
    try {
      await notificationsPool.query('UPDATE notifications SET read = TRUE');
    } catch (error) {
      console.error('Error marking all notifications as read in DB:', error);
    }
  } else {
    // Memory mode
    loadNotificationsFromCache();
    notificationsMemory.forEach((notification) => {
      notification.read = true;
    });
    saveNotificationsToCache();
  }
}

/**
 * Elimina una notificación
 */
export async function deleteNotification(notificationId: string): Promise<void> {
  if (notificationsPool) {
    try {
      await notificationsPool.query('DELETE FROM notifications WHERE id = $1', [notificationId]);
    } catch (error) {
      console.error('Error deleting notification from DB:', error);
    }
  } else {
    // Memory mode
    loadNotificationsFromCache();
    notificationsMemory.delete(notificationId);
    saveNotificationsToCache();
  }
}

/**
 * Elimina todas las notificaciones leídas
 */
export async function clearReadNotifications(): Promise<void> {
  if (notificationsPool) {
    try {
      await notificationsPool.query('DELETE FROM notifications WHERE read = TRUE');
    } catch (error) {
      console.error('Error clearing read notifications from DB:', error);
    }
  } else {
    // Memory mode
    loadNotificationsFromCache();
    Array.from(notificationsMemory.keys()).forEach((id) => {
      const notification = notificationsMemory.get(id);
      if (notification && notification.read) {
        notificationsMemory.delete(id);
      }
    });
    saveNotificationsToCache();
  }
}

/**
 * Elimina todas las notificaciones
 */
export async function clearAllNotifications(): Promise<void> {
  if (notificationsPool) {
    try {
      await notificationsPool.query('DELETE FROM notifications');
    } catch (error) {
      console.error('Error clearing all notifications from DB:', error);
    }
  } else {
    // Memory mode
    notificationsMemory.clear();
    saveNotificationsToCache();
  }
}
