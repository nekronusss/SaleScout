import type { Competitor, Product } from '../src/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCompetitor(value: unknown): value is Competitor {
  return isRecord(value)
    && typeof value.seller === 'string'
    && isNonNegativeNumber(value.price)
    && typeof value.inStock === 'boolean';
}

export function isProduct(value: unknown): value is Product {
  return isRecord(value)
    && typeof value.sku === 'string'
    && typeof value.name === 'string'
    && isNonNegativeNumber(value.myPrice)
    && isNonNegativeNumber(value.minPrice)
    && Number.isInteger(value.minPrice)
    && isNonNegativeNumber(value.maxPrice)
    && Number.isInteger(value.maxPrice)
    && value.minPrice <= value.maxPrice
    && isNonNegativeNumber(value.step)
    && Array.isArray(value.competitors)
    && value.competitors.every(isCompetitor);
}
