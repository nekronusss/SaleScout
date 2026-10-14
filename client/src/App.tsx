import { useEffect, useRef, useState, type FormEvent } from "react";
import sampleProducts from "../../data/products.json";
import type { PriceResult, Product, Reason } from "../../src/types";
import { isProduct } from "../../src/validation";
import { ProductForm } from "./ProductForm";
import { Icon } from "./Icon";
import { api, ApiError, type User, type Providers } from "./api";
import { OAuthButtons } from "./OAuthButtons";

interface Catalog {
  products: Product[];
  version: number;
}
const reasonLabels: Record<Reason, string> = {
  UNDERCUT: "Конкурентная цена",
  AT_MIN: "Нижняя граница",
  AT_MAX: "Верхняя граница",
  NO_COMPETITORS: "Нет конкурентов",
};
const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const formatPrice = (price: number) => `${money.format(price)} ₸`;

async function reprice(
  products: Product[],
  signal: AbortSignal,
): Promise<PriceResult[]> {
  const response = await fetch("/reprice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(products),
    signal,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Сервер вернул ошибку ${response.status}.`;
    throw new Error(message);
  }
  return response.json() as Promise<PriceResult[]>;
}

export function App({
  user,
  onLogout,
  providers = { google: false, apple: false },
  feedback = "",
}: {
  user: User;
  onLogout: () => void;
  providers?: Providers;
  feedback?: string;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [results, setResults] = useState<PriceResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState<Reason | "">("");
  const [editor, setEditor] = useState<{ index: number | null } | null>(null);
  const [json, setJson] = useState("");
  const [importError, setImportError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const importRef = useRef<HTMLDetailsElement>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);

  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (editor === null) addButtonRef.current?.focus();
  }, [editor]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Catalog>("/api/products", { signal: controller.signal })
      .then((catalog) => {
        if (controller.signal.aborted) return;
        setProducts(catalog.products);
        setVersion(catalog.version);
        setReady(true);
        setConflict(false);
        setResults(null);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Не удалось загрузить товары.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  async function updateProducts(
    next: Product[],
    message: string,
  ): Promise<boolean> {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const catalog = await api<Catalog>("/api/products", {
        method: "PUT",
        body: { products: next, version },
      });
      setProducts(catalog.products);
      setVersion(catalog.version);
      setResults(null);
      setNotice(message);
      setSearch("");
      setReason("");
      setConflict(false);
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось сохранить товары.",
      );
      setConflict(cause instanceof ApiError && cause.status === 409);
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function saveProduct(product: Product) {
    const index = editor?.index;
    const next =
      index === null || index === undefined
        ? [...products, product]
        : products.map((item, i) => (i === index ? product : item));
    if (
      await updateProducts(
        next,
        index === null
          ? "Товар добавлен. Теперь можно рассчитать цены."
          : "Изменения сохранены. Пересчитайте цены.",
      )
    )
      setEditor(null);
  }

  async function calculate() {
    if (products.length === 0) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await reprice(products, controller.signal);
      if (!controller.signal.aborted) setResults(next);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof TypeError
            ? "Не удалось связаться с сервером. Проверьте соединение и попробуйте ещё раз."
            : cause instanceof Error
              ? cause.message
              : "Не удалось рассчитать цены.",
        );
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }

  async function submitJson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let input: unknown;
    try {
      input = JSON.parse(json);
    } catch {
      setImportError("Некорректный JSON. Проверьте кавычки, запятые и скобки.");
      return;
    }
    if (!Array.isArray(input) || !input.every(isProduct)) {
      setImportError(
        "Ожидается массив товаров с корректными ценами, границами и списком конкурентов.",
      );
      return;
    }
    if (
      !(await updateProducts(
        [...products, ...input],
        `Импортировано товаров: ${input.length}.`,
      ))
    )
      return;
    setImportError("");
    setJson("");
    if (importRef.current) importRef.current.open = false;
  }

  function exportProducts() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(products, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "salescout-products.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function logout() {
    setLoading(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      onLogout();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выйти.");
    } finally {
      setLoading(false);
    }
  }

  async function requestPassword() {
    setLoading(true);
    setError("");
    try {
      await api("/api/auth/request-reset", {
        method: "POST",
        body: { email: user.email },
      });
      setNotice(
        "Ссылка для установки пароля отправлена на почту вашего аккаунта.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось отправить письмо.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function deleteAccount(event: FormEvent) {
    event.preventDefault();
    if (!deleteConfirmed) return;
    setLoading(true);
    setError("");
    try {
      await api("/api/account", {
        method: "DELETE",
        body: { password: deletePassword },
      });
      onLogout();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось удалить аккаунт.",
      );
    } finally {
      setLoading(false);
    }
  }

  const rows = products.map((product, index) => ({
    product,
    result: results?.[index],
    index,
  }));
  const query = search.trim().toLocaleLowerCase("ru");
  const visibleRows = rows.filter(
    ({ product, result }) =>
      (!reason || result?.reason === reason) &&
      `${product.sku} ${product.name}`.toLocaleLowerCase("ru").includes(query),
  );
  const changed = results?.filter(
    (row) => row.newPrice !== row.oldPrice,
  ).length;
  const atLimit = results?.filter(
    (row) => row.reason === "AT_MIN" || row.reason === "AT_MAX",
  ).length;
  const inStock = products.reduce(
    (total, product) =>
      total + product.competitors.filter((item) => item.inStock).length,
    0,
  );
  const busy = loading || editor !== null || !ready;

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="/" aria-label="SaleScout — главная">
            <img src="/favicon.svg" width="32" height="32" alt="" />
            SaleScout
          </a>
          <span className="header-divider" />
          <span className="workspace-name">Каталог</span>
          <div className="account-header">
            <span className="avatar">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="account-name">{user.name}</span>
            <button
              className="text-button"
              disabled={loading || editor !== null}
              onClick={() => void logout()}
            >
              Выйти
            </button>
          </div>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <h1>Каталог товаров</h1>
            <p className="intro">Цены и условия пересчёта</p>
          </div>
          <div className="actions page-actions">
            <button
              ref={addButtonRef}
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setEditor({ index: null });
                setNotice("");
              }}
            >
              <Icon name="plus" />
              Добавить товар
            </button>
            <button
              className="button primary"
              disabled={busy || products.length === 0}
              onClick={() => void calculate()}
            >
              {loading ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <Icon name="arrow" />
              )}
              {loading ? "Подождите…" : "Рассчитать цены"}
            </button>
          </div>
        </div>

        <div className="catalog-summary" aria-label="Обзор товаров">
          <span>
            Товаров: <strong>{products.length}</strong>
          </span>
          <span>
            Предложений в наличии: <strong>{inStock}</strong>
          </span>
          {results && (
            <>
              <span>
                <strong>{changed}</strong> цен к изменению
              </span>
              <span>
                <strong>{atLimit}</strong> на границе диапазона
              </span>
            </>
          )}
        </div>
        {feedback && (
          <div className="banner warning" role="status">
            {feedback}
          </div>
        )}

        {error && (
          <div className="banner error" role="alert">
            {error}
            {results && " Показаны результаты предыдущего расчёта."}
            {(!ready || conflict) && (
              <div>
                <button
                  className="button secondary"
                  disabled={loading || editor !== null}
                  onClick={() => setReload((value) => value + 1)}
                >
                  Обновить список
                </button>
                {editor && <p>Сначала закройте форму редактирования.</p>}
              </div>
            )}
          </div>
        )}
        <div className="announcement" role="status">
          {notice && (
            <div className="banner success">
              <Icon name="check" />
              {notice}
            </div>
          )}
        </div>

        {editor && (
          <ProductForm
            product={
              editor.index === null ? null : (products[editor.index] ?? null)
            }
            onSave={saveProduct}
            onCancel={() => setEditor(null)}
            saving={loading}
          />
        )}

        <section
          className="panel results-panel"
          aria-labelledby="results-heading"
          aria-busy={loading}
        >
          <div className="panel-heading">
            <div>
              <h2 id="results-heading">
                Товары <span className="count">{products.length}</span>
              </h2>
            </div>
            <span
              className={`calculation-status ${results ? "ready" : ""}`}
              aria-live="polite"
            >
              <span className="status-dot" />
              {loading
                ? "Обновление…"
                : error
                  ? "Действие не завершено"
                  : results
                    ? "Цены рассчитаны"
                    : "Ожидает расчёта"}
            </span>
          </div>
          {products.length > 0 && (
            <div className="toolbar">
              <label className="search-box">
                <Icon name="search" />
                <input
                  aria-label="Поиск по названию или SKU"
                  placeholder="Поиск по названию или SKU"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <select
                aria-label="Фильтр по причине"
                value={reason}
                disabled={!results}
                onChange={(event) =>
                  setReason(event.target.value as Reason | "")
                }
              >
                <option value="">Все причины</option>
                {Object.entries(reasonLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {products.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <Icon name="box" />
              </div>
              <h3>Начните с первого товара</h3>
              <p>
                Укажите текущую цену, допустимый диапазон и предложения
                конкурентов. Остальное посчитаем мы.
              </p>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => setEditor({ index: null })}
              >
                <Icon name="plus" />
                Добавить первый товар
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  updateProducts(
                    sampleProducts,
                    "Пример загружен. Нажмите «Рассчитать цены».",
                  )
                }
              >
                Или загрузить пример
              </button>
            </div>
          ) : (
            <>
              <div
                className="table-scroll"
                tabIndex={0}
                aria-label="Таблица товаров"
              >
                <table>
                  <caption className="sr-only">
                    Товары, текущие и рассчитанные цены
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Товар</th>
                      <th scope="col" className="numeric">
                        Текущая цена
                      </th>
                      <th scope="col" className="numeric">
                        Новая цена
                      </th>
                      <th scope="col" className="numeric">
                        Изменение
                      </th>
                      <th scope="col">Результат</th>
                      <th scope="col">
                        <span className="sr-only">Действия</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(({ product, result, index }) => {
                      const delta = result
                        ? result.newPrice - result.oldPrice
                        : null;
                      return (
                        <tr key={index}>
                          <td>
                            <div className="product-name">{product.name}</div>
                            <div className="sku">{product.sku}</div>
                            <div className="price-range">
                              {formatPrice(product.minPrice)} –{" "}
                              {formatPrice(product.maxPrice)}
                            </div>
                          </td>
                          <td className="numeric old-price">
                            {formatPrice(product.myPrice)}
                          </td>
                          <td className="numeric new-price">
                            {result ? (
                              formatPrice(result.newPrice)
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td
                            className={`numeric delta ${delta !== null && delta < 0 ? "decreased" : ""}`}
                          >
                            {delta === null || delta === 0
                              ? "—"
                              : `${delta > 0 ? "+" : "−"}${formatPrice(Math.abs(delta))}`}
                          </td>
                          <td>
                            {result ? (
                              <span
                                className={`reason reason-${result.reason}`}
                                title={result.reason}
                              >
                                {reasonLabels[result.reason]}
                              </span>
                            ) : (
                              <span className="muted pending-label">
                                Не рассчитано
                              </span>
                            )}
                          </td>
                          <td>
                            <div className="row-actions">
                              <button
                                className="icon-button"
                                disabled={busy}
                                aria-label={`Редактировать ${product.name}`}
                                onClick={() => {
                                  setEditor({ index });
                                  setNotice("");
                                }}
                              >
                                <Icon name="edit" />
                              </button>
                              <button
                                className="icon-button danger"
                                disabled={busy}
                                aria-label={`Удалить ${product.name}`}
                                onClick={() =>
                                  updateProducts(
                                    products.filter((_, i) => i !== index),
                                    "Товар удалён. Список обновлён.",
                                  )
                                }
                              >
                                <Icon name="trash" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {visibleRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="empty-search">
                          Ничего не найдено. Измените поиск или фильтр.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="table-footer">
                <span>
                  Показано {visibleRows.length} из {products.length}
                </span>
                <span>Все цены в тенге · ₸</span>
              </div>
            </>
          )}
        </section>

        <p className="calculation-note">
          Расчёт не меняет цены в Kaspi.kz. Данные конкурентов вводятся вручную.
        </p>

        <details ref={importRef} className="panel import-panel">
          <summary>
            <span>
              Импортировать товары <small>Для готового списка в JSON</small>
            </span>
            <Icon name="chevron" />
          </summary>
          <form onSubmit={submitJson}>
            <p className="section-hint">
              Товары из массива Product[] будут добавлены к текущему списку.
            </p>
            <label htmlFor="products-json" className="import-label">
              Данные товаров
            </label>
            <textarea
              id="products-json"
              value={json}
              onChange={(event) => {
                setJson(event.target.value);
                setImportError("");
              }}
              placeholder={
                '[ { "sku": "SKU-001", "name": "Название товара", … } ]'
              }
              spellCheck={false}
              disabled={busy}
              aria-invalid={Boolean(importError)}
              aria-describedby={importError ? "import-error" : undefined}
            />
            {importError && (
              <p className="field-error" id="import-error" role="alert">
                {importError}
              </p>
            )}
            <button
              className="button secondary"
              type="submit"
              disabled={busy || !json.trim()}
            >
              <Icon name="plus" />
              Импортировать JSON
            </button>
          </form>
        </details>
        <details className="panel account-panel">
          <summary>
            <span>
              Аккаунт и данные <small>{user.email}</small>
            </span>
            <Icon name="chevron" />
          </summary>
          <div className="account-settings">
            <p>
              Ваш каталог хранится на сервере и доступен только в вашем
              аккаунте.
            </p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={exportProducts}
            >
              Скачать товары в JSON
            </button>
            <section className="account-connections">
              <h3>Способы входа</h3>
              <OAuthButtons
                providers={providers}
                linked={user.linkedProviders}
                connect
                disabled={busy}
              />
              {user.hasPassword === false && (
                <div className="password-setup">
                  <p>
                    Вы вошли через внешний аккаунт. Установите пароль для входа
                    по почте и подтверждения удаления аккаунта.
                  </p>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void requestPassword()}
                  >
                    Установить пароль по почте
                  </button>
                </div>
              )}
            </section>
            <details className="delete-account">
              <summary>Удалить аккаунт</summary>
              <form onSubmit={(event) => void deleteAccount(event)}>
                <p>
                  Аккаунт и все товары будут удалены без возможности
                  восстановления. Перед удалением можно скачать каталог.
                </p>
                <label className="field">
                  Текущий пароль
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    maxLength={128}
                    disabled={busy}
                    value={deletePassword}
                    onChange={(event) => setDeletePassword(event.target.value)}
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={deleteConfirmed}
                    disabled={busy}
                    onChange={(event) =>
                      setDeleteConfirmed(event.target.checked)
                    }
                  />
                  Я понимаю, что аккаунт и товары будут удалены
                </label>
                <button
                  className="button danger-button"
                  disabled={
                    busy || !deleteConfirmed || user.hasPassword === false
                  }
                >
                  Удалить аккаунт и товары
                </button>
              </form>
            </details>
          </div>
        </details>
        <footer className="page-footer">
          <span>SaleScout</span>
          <span>Товары сохраняются после добавления и редактирования.</span>
        </footer>
      </main>
    </div>
  );
}
