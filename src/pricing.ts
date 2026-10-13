import type { PriceResult, Product } from './types.js';

/** Pure calculation: stock filter → lowest price → floor → bounds. */
export function calculatePrice(product: Product): PriceResult {
  let best = Infinity;

  for (const competitor of product.competitors) {
    if (competitor.inStock && competitor.price < best) {
      best = competitor.price;
    }
  }

  const base = { sku: product.sku, oldPrice: product.myPrice };

  if (best === Infinity) {
    return { ...base, newPrice: product.maxPrice, reason: 'NO_COMPETITORS' };
  }

  const candidate = Math.floor(best - product.step);

  if (candidate < product.minPrice) {
    return { ...base, newPrice: product.minPrice, reason: 'AT_MIN' };
  }
  if (candidate > product.maxPrice) {
    return { ...base, newPrice: product.maxPrice, reason: 'AT_MAX' };
  }

  return { ...base, newPrice: candidate, reason: 'UNDERCUT' };
}
