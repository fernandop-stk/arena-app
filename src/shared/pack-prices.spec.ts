import { describe, expect, it } from 'vitest';
import { getPackPriceByName, getServicePriceByName } from './pack-prices';

describe('Pack Invitada prices', () => {
  it.each([
    ['Pack Invitada · Opción 1', 40],
    ['Pack Invitada · Opción 2', 60],
    ['Pack Invitada · Opción 3', 80],
  ])('resolves the price for %s', (name, price) => {
    expect(getPackPriceByName(name)).toBe(price);
    expect(getServicePriceByName(name, false)).toBe(price);
  });
});