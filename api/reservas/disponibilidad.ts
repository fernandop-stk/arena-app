import { getAvailableSlotsForDate } from '../../src/shared/reservas-db';

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const dateIso = `${req.query?.dateIso ?? ''}`;
  const durationMinutes = Number(req.query?.durationMinutes);

  if (!dateIso || Number.isNaN(durationMinutes)) {
    res.status(400).json({ ok: false, error: 'Parámetros inválidos para disponibilidad.' });
    return;
  }

  try {
    const slots = await getAvailableSlotsForDate(dateIso, durationMinutes);
    res.status(200).json({ ok: true, slots });
  } catch (error) {
    console.error('Error consultando disponibilidad (Vercel):', error);
    res.status(500).json({ ok: false, error: 'No se pudo consultar la disponibilidad.' });
  }
}
