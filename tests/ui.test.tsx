// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../client/src/App';
import products from '../data/products.json';
import expected from '../data/expected.json';

const fetchMock = vi.fn<typeof fetch>();
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(respond(expected));
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

async function openApp() {
  render(<App />);
  await screen.findByText('APL-15-128');
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Расчёт завершён'));
}

describe('React repricing page', () => {
  it('posts products and renders server prices with names', async () => {
    await openApp();
    expect(fetchMock).toHaveBeenCalledWith('/reprice', expect.objectContaining({
      method: 'POST', body: JSON.stringify(products),
    }));
    const row = screen.getByText('APL-15-128').closest('tr');
    expect(row?.textContent).toContain('Apple iPhone 15');
    expect(row?.textContent?.replace(/\s/g, '')).toContain('384980₸');
    expect(screen.getAllByRole('row')).toHaveLength(6);
  });

  it('filters by SKU and reason, with an empty search state', async () => {
    await openApp();
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск по названию или SKU' }), { target: { value: 'dys' } });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('DYS-V8')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'AT_MAX' } });
    expect(screen.getByText(/Ничего не найдено/)).toBeTruthy();
  });

  it('submits JSON, shows an empty array, and restores sample data', async () => {
    await openApp();
    fetchMock.mockResolvedValueOnce(respond([]));
    fireEvent.change(screen.getByLabelText('Данные товаров'), { target: { value: '[]' } });
    fireEvent.submit(screen.getByLabelText('Данные товаров').closest('form')!);
    await screen.findByText(/Товаров пока нет/);
    expect(fetchMock).toHaveBeenLastCalledWith('/reprice', expect.objectContaining({ body: '[]' }));
    fetchMock.mockResolvedValueOnce(respond(expected));
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть пример', hidden: true }));
    await screen.findByText('APL-15-128');
  });

  it('rejects malformed JSON without sending it', async () => {
    await openApp();
    fireEvent.change(screen.getByLabelText('Данные товаров'), { target: { value: '{broken' } });
    fireEvent.submit(screen.getByLabelText('Данные товаров').closest('form')!);
    expect(screen.getByRole('alert').textContent).toContain('Некорректный JSON');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('displays API validation errors and retains the previous successful table', async () => {
    await openApp();
    fetchMock.mockResolvedValueOnce(respond({ error: 'Тело запроса должно быть массивом товаров.' }, 400));
    fireEvent.change(screen.getByLabelText('Данные товаров'), { target: { value: '{}' } });
    fireEvent.submit(screen.getByLabelText('Данные товаров').closest('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('массивом товаров');
    expect(alert.textContent).toContain('предыдущий успешный расчёт');
    expect(screen.getByText('APL-15-128')).toBeTruthy();
  });

  it('reports network failures and allows retry', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('Проверьте, что сервер запущен');
    fetchMock.mockResolvedValueOnce(respond(expected));
    fireEvent.click(screen.getByRole('button', { name: /Пересчитать цены/ }));
    await screen.findByText('APL-15-128');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps duplicate SKU names associated by array order', async () => {
    await openApp();
    const input = [{ ...products[0], name: 'Первый' }, { ...products[0], name: 'Второй' }];
    fetchMock.mockResolvedValueOnce(respond([expected[0], expected[0]]));
    fireEvent.change(screen.getByLabelText('Данные товаров'), { target: { value: JSON.stringify(input) } });
    fireEvent.submit(screen.getByLabelText('Данные товаров').closest('form')!);
    await screen.findByText('Первый');
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Первый')).toBeTruthy();
    expect(within(rows[1]!).getByText('Второй')).toBeTruthy();
  });
});
