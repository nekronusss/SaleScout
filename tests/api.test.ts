import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../server/app.js';
import products from '../data/products.json';
import expected from '../data/expected.json';

describe('POST /reprice', () => {
  it('returns fixture results in the original order', async () => {
    const response = await request(app).post('/reprice').send(products).expect(200);
    expect(response.body).toEqual(expected);
  });

  it('accepts an empty array', async () => {
    const response = await request(app).post('/reprice').send([]).expect(200);
    expect(response.body).toEqual([]);
  });

  it.each(['{}', 'null', '42', '"text"'])('rejects a non-array body: %s', async (body) => {
    await request(app).post('/reprice').set('Content-Type', 'application/json').send(body).expect(400);
  });

  it('rejects missing bodies', async () => {
    await request(app).post('/reprice').expect(400);
  });

  it('returns JSON for malformed JSON', async () => {
    const response = await request(app).post('/reprice').set('Content-Type', 'application/json').send('[broken').expect(400);
    expect(response.body).toHaveProperty('error');
  });

  it.each([
    { step: -1 }, { myPrice: '100' }, { minPrice: 0.5 }, { maxPrice: 0 },
    { competitors: null }, { competitors: [{ seller: 'A', price: 10, inStock: 'true' }] },
    { competitors: [{ seller: 'A', price: -1, inStock: false }] },
    { sku: null }, { name: 12 }, { step: null },
  ])('rejects invalid product fields: %j', async (fields) => {
    await request(app).post('/reprice').send([{ ...products[0], ...fields }]).expect(400);
  });

  it('identifies the invalid array item', async () => {
    const response = await request(app).post('/reprice').send([products[0], null]).expect(400);
    expect(response.body.error).toContain('1');
  });

  it('rejects numbers that overflow to infinity when parsed', async () => {
    const body = JSON.stringify([products[0]]).replace('399990', '1e400');
    await request(app).post('/reprice').set('Content-Type', 'application/json').send(body).expect(400);
  });

  it('returns 413 when the request exceeds the size limit', async () => {
    const response = await request(app).post('/reprice').send([{ ...products[0], name: 'x'.repeat(1024 * 1024) }]).expect(413);
    expect(response.body).toHaveProperty('error');
  });

  it('preserves duplicate SKUs as separate results', async () => {
    const response = await request(app).post('/reprice').send([products[0], products[0]]).expect(200);
    expect(response.body).toEqual([expected[0], expected[0]]);
  });
});
