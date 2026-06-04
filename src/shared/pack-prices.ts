export const PACK_PRICE_BY_NAME: Record<string, number> = {
  'Pack Corte': 40,
  'Pack Peinado': 40,
  'Pack Corte y Peinado': 60,
  'Pack Color': 70,
  'Pack Color Plus': 90,
  'Pack Ilumina': 140,
  'Pack Full Color': 180,
  'Pack Invitada': 40,
  'Pack Novia': 300,
  'Brushing Plus': 10,
  'Blindaje de Color': 10,
  'Tratamiento Exprés': 15,
  'Tratamiento Personalizado': 25,
  'Nutrición Extrema': 40,
  'Tratamiento Reconstructor': 40,
  'Bono “Recupera tu Melena”': 180,
  'Opción 1': 40,
  'Opción 2': 60,
  'Opción 3': 80,
};

export const PROVISIONAL_RESERVATION_HOURS = 48;

const SIGNAL_REQUIRED_PACKS = new Set(['Pack Ilumina', 'Pack Full Color']);

export const requiresReservationSignalByName = (name: string): boolean => {
  return SIGNAL_REQUIRED_PACKS.has(name);
};

export const getProvisionalReservationHoursByName = (name: string): number => {
  return requiresReservationSignalByName(name) ? PROVISIONAL_RESERVATION_HOURS : 0;
};

export const getPackPriceByName = (name: string): number => {
  return PACK_PRICE_BY_NAME[name] ?? 0;
};
