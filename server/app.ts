import express, { type ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import { calculatePrice } from '../src/pricing.js';
import type { Product } from '../src/types.js';
import { isProduct } from './validation.js';

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.post('/reprice', (req, res) => {
  const body: unknown = req.body;
  if (!Array.isArray(body)) {
    res.status(400).json({ error: 'Тело запроса должно быть массивом товаров (Product[]).' });
    return;
  }

  const products: Product[] = [];
  for (const [index, item] of body.entries()) {
    if (!isProduct(item)) {
      res.status(400).json({ error: `Некорректный товар с индексом ${index}. Проверьте поля, диапазон цен и конкурентов.` });
      return;
    }
    products.push(item);
  }
  res.json(products.map(calculatePrice));
});

// After npm run build the API also serves the compiled React application.
app.use(express.static(fileURLToPath(new URL('../client', import.meta.url))));

const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? error.status : undefined;
  if (status === 400) {
    res.status(400).json({ error: 'Некорректный JSON в теле запроса.' });
  } else if (status === 413) {
    res.status(413).json({ error: 'Размер запроса превышает 1 МБ.' });
  } else {
    console.error(error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
  }
};
app.use(handleError);
