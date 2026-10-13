import { describe, expect, it } from 'vitest';
import products from '../data/products.json';
import expected from '../data/expected.json';
import { calculatePrice } from '../src/pricing.js';
import type { Product, Reason } from '../src/types.js';

const product = (overrides: Partial<Product> = {}): Product => ({
  sku: 'TEST', name: 'Тестовый товар', myPrice: 120.75,
  minPrice: 100, maxPrice: 200, step: 10,
  competitors: [{ seller: 'Shop', price: 150, inStock: true }],
  ...overrides,
});

describe('calculatePrice', () => {
  it('matches the sample fixture in order', () => {
    expect(products.map(calculatePrice)).toEqual(expected);
  });

  it.each<[string, Partial<Product>, number, Reason]>([
    ['undercuts an available competitor', {}, 140, 'UNDERCUT'],
    ['handles an empty list', { competitors: [] }, 200, 'NO_COMPETITORS'],
    ['ignores unavailable competitors', { competitors: [{ seller: 'A', price: 0, inStock: false }] }, 200, 'NO_COMPETITORS'],
    ['clamps below minimum', { minPrice: 145 }, 145, 'AT_MIN'],
    ['clamps above maximum', { maxPrice: 130 }, 130, 'AT_MAX'],
    ['includes the minimum boundary', { minPrice: 140 }, 140, 'UNDERCUT'],
    ['includes the maximum boundary', { maxPrice: 140 }, 140, 'UNDERCUT'],
    ['allows zero step', { step: 0 }, 150, 'UNDERCUT'],
    ['floors a fractional step', { step: 0.5 }, 149, 'UNDERCUT'],
    ['handles a negative candidate', { step: 200 }, 100, 'AT_MIN'],
    ['handles zero competitor price', { minPrice: 0, step: 0, competitors: [{ seller: 'A', price: 0, inStock: true }] }, 0, 'UNDERCUT'],
    ['floors before applying bounds', { maxPrice: 149, step: 0.1 }, 149, 'UNDERCUT'],
    ['handles equal bounds at candidate', { minPrice: 140, maxPrice: 140 }, 140, 'UNDERCUT'],
    ['handles equal bounds below candidate', { minPrice: 100, maxPrice: 100 }, 100, 'AT_MAX'],
    ['handles equal bounds above candidate', { minPrice: 200, maxPrice: 200 }, 200, 'AT_MIN'],
    ['preserves no-competitor reason with equal bounds', { minPrice: 100, maxPrice: 100, competitors: [] }, 100, 'NO_COMPETITORS'],
  ])('%s', (_name, overrides, newPrice, reason) => {
    expect(calculatePrice(product(overrides))).toEqual({ sku: 'TEST', oldPrice: 120.75, newPrice, reason });
  });

  it('takes the cheapest available price, including ties', () => {
    expect(calculatePrice(product({ competitors: [
      { seller: 'Unavailable', price: 1, inStock: false },
      { seller: 'Expensive', price: 190, inStock: true },
      { seller: 'First', price: 160, inStock: true },
      { seller: 'Tie', price: 160, inStock: true },
    ] })).newPrice).toBe(150);
  });

  it('floors fractional competitor prices and steps', () => {
    expect(calculatePrice(product({ minPrice: 330000, maxPrice: 380000, step: 0.5,
      competitors: [{ seller: 'A', price: 349999.9, inStock: true }],
    })).newPrice).toBe(349999);
  });

  it.each([0, 99.25, 1000000])('myPrice %s only affects oldPrice', (myPrice) => {
    expect(calculatePrice(product({ myPrice }))).toEqual({ sku: 'TEST', oldPrice: myPrice, newPrice: 140, reason: 'UNDERCUT' });
  });

  it('does not mutate its input and is repeatable', () => {
    const input = product();
    const original = structuredClone(input);
    input.competitors.forEach(Object.freeze);
    Object.freeze(input.competitors);
    Object.freeze(input);
    expect(calculatePrice(input)).toEqual(calculatePrice(input));
    expect(input).toEqual(original);
  });

  it('supports large competitor lists without spreading into Math.min', () => {
    const competitors = Array.from({ length: 150000 }, (_, i) => ({ seller: String(i), price: 180, inStock: true }));
    expect(calculatePrice(product({ competitors })).newPrice).toBe(170);
  });
});
