import { useEffect, useState, type FormEvent } from 'react';
import sampleProducts from '../../data/products.json';
import type { PriceResult, Product, Reason } from '../../src/types';

const reasonLabels: Record<Reason, string> = {
  UNDERCUT: 'Конкурентная цена',
  AT_MIN: 'Нижняя граница',
  AT_MAX: 'Верхняя граница',
  NO_COMPETITORS: 'Нет конкурентов',
};
const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const formatPrice = (price: number) => `${money.format(price)} ₸`;

async function reprice(products: unknown, signal?: AbortSignal): Promise<PriceResult[]> {
  const response = await fetch('/reprice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(products),
    signal,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error : `Сервер вернул ошибку ${response.status}.`;
    throw new Error(message);
  }
  return response.json() as Promise<PriceResult[]>;
}

function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return 'Не удалось связаться с API. Проверьте, что сервер запущен, и повторите запрос.';
  return error instanceof Error ? error.message : 'Не удалось пересчитать цены.';
}

export function App() {
  const [products, setProducts] = useState<Product[]>(sampleProducts);
  const [results, setResults] = useState<PriceResult[] | null>(null);
  const [json, setJson] = useState(JSON.stringify(sampleProducts, null, 2));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState<Reason | ''>('');
  const [source, setSource] = useState('Демонстрационные товары');

  useEffect(() => {
    const controller = new AbortController();
    reprice(sampleProducts, controller.signal)
      .then(setResults)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function calculate(input: unknown, sourceName: string) {
    setLoading(true);
    setError('');
    try {
      const nextResults = await reprice(input);
      // The API validates Product[] before returning a successful response.
      setProducts(input as Product[]);
      setResults(nextResults);
      setSource(sourceName);
      setSearch('');
      setReason('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  function submitJson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let input: unknown;
    try { input = JSON.parse(json); }
    catch { setError('Некорректный JSON. Проверьте кавычки, запятые и скобки.'); return; }
    void calculate(input, 'Ваши товары');
  }

  const rows = (results ?? []).map((result, index) => ({ ...result, name: products[index]?.name ?? '', index }));
  const query = search.trim().toLocaleLowerCase('ru');
  const visibleRows = rows.filter(row => (!reason || row.reason === reason)
    && `${row.sku} ${row.name}`.toLocaleLowerCase('ru').includes(query));
  const decreased = rows.filter(row => row.newPrice < row.oldPrice).length;
  const increased = rows.filter(row => row.newPrice > row.oldPrice).length;
  const unchanged = rows.filter(row => row.newPrice === row.oldPrice).length;

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="/" aria-label="SaleScout — главная">
            <img src="/favicon.svg" width="36" height="36" alt="" />
            SaleScout<span className="mini-tag">mini</span>
          </a>
          <span className="header-note">Инструменты продавца <span className="market-badge">Kaspi.kz</span></span>
        </div>
      </header>

      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">УПРАВЛЕНИЕ ЦЕНАМИ</div>
            <h1>Ваш следующий ценовой шаг.</h1>
            <p className="intro">Сравните цены с конкурентами и найдите свою — в заданных пределах.</p>
          </div>
          <button className="button primary" disabled={loading} onClick={() => void calculate(products, source)}>
            <span aria-hidden="true" className={loading ? 'spin' : ''}>↻</span>
            {loading ? 'Считаем…' : 'Пересчитать цены'}
          </button>
        </div>

        <section className="stats" aria-label="Итоги пересчёта">
          {[
            { label: 'Товаров в расчёте', value: results === null ? '—' : rows.length, hint: 'Весь загруженный ассортимент', className: '' },
            { label: 'Цена снижена', value: results === null ? '—' : decreased, hint: 'Ближе к цене конкурентов', className: 'green' },
            { label: 'Цена повышена', value: results === null ? '—' : increased, hint: 'В рамках заданного максимума', className: 'blue' },
            { label: 'Без изменений', value: results === null ? '—' : unchanged, hint: 'Текущая цена совпадает с новой', className: '' },
          ].map(stat => <div className="stat" key={stat.label}><span>{stat.label}</span><strong className={stat.className}>{stat.value}</strong><small>{stat.hint}</small></div>)}
        </section>

        {error && <div role="alert" className="error"><strong>Расчёт не выполнен.</strong> {error}{results !== null && ' Ниже показан предыдущий успешный расчёт.'}</div>}

        <section className="results-panel" aria-labelledby="results-heading" aria-busy={loading}>
          <div className="panel-heading">
            <div><h2 id="results-heading">Результат пересчёта <span className="count">{rows.length}</span></h2><p>{source}</p></div>
            <span className="status" role="status"><span className={`status-dot ${loading ? 'pending' : error ? 'failed' : ''}`} />{loading ? 'Выполняется запрос' : error ? 'Ошибка запроса' : 'Расчёт завершён'}</span>
          </div>
          <div className="toolbar">
            <label className="search-box"><span aria-hidden="true">⌕</span><input aria-label="Поиск по названию или SKU" placeholder="Поиск по названию или SKU" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <select aria-label="Фильтр по причине" value={reason} onChange={event => setReason(event.target.value as Reason | '')}>
              <option value="">Все причины</option>
              {Object.entries(reasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Старая и новая цена каждого товара, изменение и причина пересчёта</caption>
              <thead><tr><th scope="col">Товар / SKU</th><th scope="col" className="numeric">Было</th><th scope="col" className="numeric">Стало</th><th scope="col" className="numeric">Изменение</th><th scope="col">Причина</th></tr></thead>
              <tbody>
                {visibleRows.map(row => {
                  const delta = row.newPrice - row.oldPrice;
                  return <tr key={row.index}>
                    <td><div className="product-name">{row.name}</div><div className="sku">{row.sku}</div></td>
                    <td className="numeric old-price">{formatPrice(row.oldPrice)}</td>
                    <td className="numeric new-price">{formatPrice(row.newPrice)}</td>
                    <td className={`numeric delta ${delta < 0 ? 'green' : delta > 0 ? 'blue' : ''}`}>{delta === 0 ? '—' : `${delta > 0 ? '+' : '−'}${formatPrice(Math.abs(delta))}`}</td>
                    <td><span className={`reason reason-${row.reason}`}>{reasonLabels[row.reason]}</span><div className="reason-code">{row.reason}</div></td>
                  </tr>;
                })}
                {visibleRows.length === 0 && <tr><td colSpan={5} className="empty">{loading ? 'Получаем цены с сервера…' : results === null ? 'Запустите пересчёт, чтобы увидеть цены.' : rows.length === 0 ? 'Товаров пока нет. Добавьте их через JSON ниже.' : 'Ничего не найдено. Измените поиск или фильтр.'}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="table-footer"><span>Показано {visibleRows.length} из {rows.length}</span><span>Все цены в тенге · Новая цена округляется вниз</span></div>
        </section>

        <div className="info-grid">
          <section className="explainer"><span className="info-icon" aria-hidden="true">i</span><div><h3>Как выбирается цена</h3><p>Минимальная цена конкурента в наличии минус ваш шаг. Округляем вниз и ограничиваем диапазоном. Без конкурентов используем максимальную цену.</p></div></section>
          <section className="demo-note"><h3>Предварительный расчёт</h3><p>Это демо: цены рассчитываются через API. Изменения в магазин Kaspi.kz не отправляются.</p></section>
        </div>

        <details className="json-panel">
          <summary><span>Проверить свои товары <small>Вставьте массив Product[] в формате JSON</small></span><span aria-hidden="true">+</span></summary>
          <form onSubmit={submitJson}>
            <label htmlFor="products-json">Данные товаров</label>
            <textarea id="products-json" value={json} onChange={event => setJson(event.target.value)} spellCheck={false} disabled={loading} />
            <div className="json-actions"><button className="button primary" type="submit" disabled={loading}>Рассчитать JSON</button><button className="button secondary" type="button" disabled={loading} onClick={() => { setJson(JSON.stringify(sampleProducts, null, 2)); void calculate(sampleProducts, 'Демонстрационные товары'); }}>Вернуть пример</button></div>
          </form>
        </details>
        <footer className="page-footer"><span>SaleScout mini</span><span>Точная цена начинается с простых правил.</span></footer>
      </main>
    </div>
  );
}
