import { describe, expect, it } from 'vitest';
import { findBlockedPeriodForSlot } from './reservas-db';

describe('findBlockedPeriodForSlot', () => {
  it('devuelve el bloqueo manual que cubre el slot seleccionado', () => {
    const blockedPeriods = [
      { id: 'b1', dateIso: '2026-09-02', startTime: '10:00', endTime: '12:00', reason: 'Reunión', createdAtIso: '2026-09-01T08:00:00.000Z' },
      { id: 'b2', dateIso: '2026-09-02', startTime: '15:00', endTime: '16:00', reason: 'Llamada', createdAtIso: '2026-09-01T08:00:00.000Z' },
    ];

    expect(findBlockedPeriodForSlot(blockedPeriods, '2026-09-02', '10:30')).toMatchObject({ id: 'b1' });
    expect(findBlockedPeriodForSlot(blockedPeriods, '2026-09-02', '15:30')).toMatchObject({ id: 'b2' });
    expect(findBlockedPeriodForSlot(blockedPeriods, '2026-09-02', '12:30')).toBeNull();
  });
});
