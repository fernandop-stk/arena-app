# Sistema de Notificaciones del Panel Admin

## 📋 Descripción General

Se ha implementado un **sistema de notificaciones en tiempo real** para el panel de gestión. Solo los admin y superadmin pueden ver las notificaciones, no los clientes. El sistema muestra un badge circular con el número de notificaciones no leídas (similar a Instagram).

## 🎯 Funcionalidades Implementadas

### 1. **Service de Notificaciones** (`notification.service.ts`)

- Gestiona todas las notificaciones
- Métodos principales:
  - `initializeNotifications()`: Carga notificaciones desde el servidor
  - `createNotification()`: Crea una nueva notificación
  - `markAsRead()`: Marca una notificación como leída
  - `markAllAsRead()`: Marca todas como leídas
  - `deleteNotification()`: Elimina una notificación
  - `clearRead()`: Elimina todas las leídas
  - `startPolling()`: Polling automático cada 30 segundos para nuevas notificaciones
- Reactive signals:
  - `notifications`: Array de todas las notificaciones
  - `unreadCount`: Contador de no leídas

### 2. **Componente Badge** (`notification-badge.component.ts`)

- Muestra un icono de campana (🔔) con badge rojo
- El badge muestra el número de notificaciones no leídas
- Al hacer click, abre un panel desplegable con todas las notificaciones
- El panel moestra:
  - Botón "Marcar todo como leído"
  - Lista de notificaciones con:
    - Título y mensaje
    - Timestamp relativo (ej: "Hace 5 min")
    - Botones para marcar como leído o eliminar
  - Mensaje "No hay notificaciones" si está vacío

### 3. **Backend - API Endpoints** (`server.ts`)

Se agregaron 5 endpoints de REST API para notificaciones (solo accesibles por admin):

```
GET    /api/notifications              - Obtiene todas las notificaciones
POST   /api/notifications              - Crea una notificación
PATCH  /api/notifications/:id/read     - Marca como leída
PATCH  /api/notifications/read-all     - Marca todas como leídas
DELETE /api/notifications/:id          - Elimina una notificación
DELETE /api/notifications/clear-read   - Elimina todas las leídas
```

### 4. **Database Layer** (`notifications-db.ts`)

- Soporte para PostgreSQL y modo desarrollo (archivo JSON)
- Tabla: `notifications` con columnas:
  - `id` (VARCHAR 36, PK)
  - `type` (VARCHAR 50): Tipo de notificación (nueva_reserva, cancelacion_reserva, etc.)
  - `title` (VARCHAR 255): Título visible
  - `message` (TEXT): Mensaje detallado
  - `read` (BOOLEAN): Estado de lectura
  - `created_at` (TIMESTAMPTZ): Timestamp de creación
  - `related_id` (VARCHAR 36): ID de la reserva/cliente relacionado
  - `action_url` (VARCHAR 500): URL para navegar al recurso

Funciones principales:

- `initializeNotificationsSchema()`: Crea tabla e índices
- `createNotification()`: Crea una notificación
- `getAllNotifications()`: Obtiene todas ordenadas por recientes
- `markNotificationAsRead()`: Marca como leída
- `deleteNotification()`: Elimina una
- `clearReadNotifications()`: Limpia todas las leídas

### 5. **Generación Automática de Notificaciones**

Cuando se **crea una nueva reserva**, el sistema automáticamente:

1. Crea una notificación para el admin con tipo `nueva_reserva`
2. Incluye datos de la reserva (nombre cliente, teléfono, servicio, fecha, hora)
3. Proporciona un `actionUrl` para navegable a la reserva (próximamente)
4. Si falla la creación de la notificación, no afecta la creación de la reserva

## 🔒 Seguridad

- ✅ **Solo Admin/Superadmin**: Los endpoints requieren verificación de sesión admin
- ✅ **Validación de permisos**: El middleware `isAdminRequest()` valida cada endpoint
- ✅ **No visible para clientes**: El componente badge solo se renderiza en admin panel
- ✅ **Protección de datos**: Las notificaciones se asocian a admin, no a cliente

## 📱 Interfaz de Usuario

### Header del Admin Panel

El header ahora tiene dos secciones:

- **Izquierda**: "Panel de gestión" + "Acceso activo como..."
- **Derecha**: Badge de notificaciones con contador

### Panel Desplegable

- Se abre al hacer click en el badge
- Ancho: 360px
- Altura máxima: 500px
- Scroll interno para notificaciones
- Sombra y redondeado para despegar visualmente

### Estilos

- Badge con fondo rojo (`#ff4757`) y borde blanco
- Notificaciones no leídas con fondo azul claro (`#e3f2fd`)
- Hover effects suave en todos los elementos
- Responsive (se adapta a pantallas pequeñas)

## 🔄 Flujo Completo

```
1. Cliente hace una reserva
   ↓
2. Server ejecuta createReservationWithSlots()
   ↓
3. Si éxito, se crea notificación vía createNotification()
   ↓
4. Notificación se guarda en DB (PostgreSQL o JSON)
   ↓
5. Admin abre panel y ve el badge con contador
   ↓
6. Admin hace click en badge
   ↓
7. Se abre panel con todas las notificaciones
   ↓
8. Admin puede marcar como leído, eliminar, etc.
   ↓
9. Polling cada 30s busca nuevas notificaciones
```

## 🚀 Próximas Mejoras (Opcionales)

1. **Sonido/Notificación del navegador**: Reproducir sonido cuando llega una notificación
2. **Más tipos de notificaciones**:
   - Cancelaciones de reservas
   - Reservas confirmadas
   - Pagos recibidos
   - Clientes nuevos
   - Empleados nuevos
3. **Email al admin**: Enviar email al admin cuando hay una reserva nueva
4. **WebSocket**: Cambiar de polling a WebSocket para actualizaciones en tiempo real
5. **Filtrado**: Permitir filtrar notificaciones por tipo o fecha
6. **Historial**: Guardar todas las notificaciones (actualmente se pueden limpiar)
7. **Toasts**: Mostrar pequeñas notificaciones toast al crear una nueva reserva

## 📁 Archivos Creados/Modificados

### Creados:

- `src/app/admin-panel/services/notification.service.ts` - Service
- `src/app/admin-panel/components/notification-badge/notification-badge.component.ts` - Componente
- `src/shared/notifications-db.ts` - Database layer

### Modificados:

- `src/server.ts` - Agregados endpoints y lógica de creación automática
- `src/app/admin-panel/admin-panel.ts` - Importado componente
- `src/app/admin-panel/admin-panel.html` - Agregado componente al header
- `src/app/admin-panel/admin-panel.scss` - Estilos del nuevo layout del header

## 💡 Notas Técnicas

- El servicio usa `fetch` API en lugar de HttpClient para máxima compatibilidad
- Las signals de Angular 18+ hacen el sistema reactivo sin necesidad de observables
- La caché en memoria (JSON) permite desarrollo sin PostgreSQL
- Los timestamps se guardan en ISO format para máxima portabilidad
- El UUID generado es v4 pseudo-random (válido para desarrollo)

## 🧪 Testing Manual

Para probar el sistema:

1. Ir al panel de admin
2. Ver el badge en la esquina superior derecha
3. Hacer una reserva desde el frontend
4. Ver que aparece una notificación en el badge
5. Hacer click en el badge para ver el panel
6. Probar marcar como leído, eliminar, etc.

## ✅ Checklist de Completitud

- [x] Service de notificaciones creado
- [x] Componente badge con UI similar a Instagram
- [x] Endpoints REST API seguros
- [x] Database layer con soporte dual (PostgreSQL + JSON)
- [x] Generación automática de notificaciones en reservas
- [x] Permisos verificados (solo admin/superadmin)
- [x] Sin errores TypeScript
- [x] UI responsiva
- [x] Polling automático cada 30s
- [x] Timestamps relativos ("Hace X minutos")
