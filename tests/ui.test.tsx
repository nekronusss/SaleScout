// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../client/src/App";
import { Auth } from "../client/src/Auth";
import { setCsrfToken } from "../client/src/api";
import { calculatePrice } from "../src/pricing";
import products from "../data/products.json";
import type { Product } from "../src/types";
import { OAuthButtons } from "../client/src/OAuthButtons";

const user = { id: "test-user", email: "test@example.com", name: "Тест" };
const fetchMock = vi.fn<typeof fetch>();
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let catalog: Product[];
let version: number;

beforeEach(() => {
  catalog = [];
  version = 0;
  setCsrfToken("a".repeat(64));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url, options) => {
    if (url === "/api/products") {
      if (options?.method === "PUT") {
        const input = JSON.parse(String(options.body)) as {
          products: Product[];
          version: number;
        };
        expect(input.version).toBe(version);
        catalog = input.products;
        version++;
      }
      return respond({ products: catalog, version });
    }
    if (url === "/reprice")
      return respond(
        (JSON.parse(String(options?.body)) as Product[]).map(calculatePrice),
      );
    throw new Error(`Unexpected fetch: ${url}`);
  });
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openApp(seed: Product[] = []) {
  catalog = structuredClone(seed);
  const view = render(<App user={user} onLogout={vi.fn()} />);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Добавить товар",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  return view;
}
function fill(name: RegExp, value: string) {
  fireEvent.change(screen.getByRole("textbox", { name }), {
    target: { value },
  });
}
function fillProduct() {
  fill(/^Название товара/, "Мой телефон");
  fill(/^Артикул/, "MY-001");
  fill(/^Текущая цена/, "150 000,5");
  fill(/^Минимальная цена/, "100000");
  fill(/^Максимальная цена/, "200000");
  fill(/^Шаг снижения/, "0,5");
}
function submitProduct() {
  fireEvent.submit(screen.getByRole("form", { name: "Форма товара" }));
}

describe("Product workspace", () => {
  it("starts empty and does not automatically reprice sample data", async () => {
    await openApp();
    expect(screen.getByText("Начните с первого товара")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      (
        screen.getByRole("button", {
          name: "Рассчитать цены",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("creates a product through fields, adds a competitor and calculates through HTTP", async () => {
    await openApp();
    fireEvent.click(screen.getByRole("button", { name: "Добавить товар" }));
    fillProduct();
    fireEvent.click(
      screen.getByRole("button", { name: "Добавить конкурента" }),
    );
    fill(/^Продавец/, "Магазин");
    fill(/^Цена конкурента/, "149999,9");
    submitProduct();
    await screen.findByText("MY-001");
    expect(catalog[0]).toEqual({
      name: "Мой телефон",
      sku: "MY-001",
      myPrice: 150000.5,
      minPrice: 100000,
      maxPrice: 200000,
      step: 0.5,
      competitors: [{ seller: "Магазин", price: 149999.9, inStock: true }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/products",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "X-CSRF-Token": "a".repeat(64) }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать цены" }));
    await screen.findByText("Цены рассчитаны");
    const row = screen.getByText("MY-001").closest("tr");
    expect(row?.textContent?.replace(/\s/g, "")).toContain("149999₸");
    expect(row?.textContent).toContain("Конкурентная цена");
  });

  it("validates required fields and price boundaries without sending invalid data", async () => {
    await openApp();
    fireEvent.click(screen.getByRole("button", { name: "Добавить товар" }));
    submitProduct();
    expect(screen.getByRole("alert").textContent).toContain("выделенные поля");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fillProduct();
    fill(/^Максимальная цена/, "99999");
    submitProduct();
    expect(screen.getByText(/Максимальная цена не может/)).toBeTruthy();
    fill(/^Максимальная цена/, "200000,5");
    submitProduct();
    expect(screen.getByText(/Граница цены должна быть целым/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows no competitors and removes or ignores unavailable competitors", async () => {
    await openApp();
    fireEvent.click(screen.getByRole("button", { name: "Добавить товар" }));
    fillProduct();
    fireEvent.click(
      screen.getByRole("button", { name: "Добавить конкурента" }),
    );
    fill(/^Продавец/, "Нет в наличии");
    fill(/^Цена конкурента/, "1");
    fireEvent.click(screen.getByRole("checkbox", { name: "В наличии" }));
    submitProduct();
    await screen.findByText("MY-001");
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать цены" }));
    await screen.findByText("Цены рассчитаны");
    expect(screen.getByTitle("NO_COMPETITORS")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Редактировать Мой телефон" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Удалить конкурента 1" }),
    );
    submitProduct();
    await waitFor(() => expect(catalog[0]?.competitors).toEqual([]));
  });

  it("edits and deletes the correct duplicate SKU, invalidating old results", async () => {
    const input = [
      { ...products[0]!, name: "Первый" },
      { ...products[0]!, name: "Второй" },
    ];
    await openApp(input);
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать цены" }));
    await screen.findByText("Цены рассчитаны");
    fireEvent.click(
      screen.getByRole("button", { name: "Редактировать Второй" }),
    );
    fill(/^Название товара/, "Изменённый");
    submitProduct();
    await screen.findByText("Изменённый");
    expect(screen.queryByText("Цены рассчитаны")).toBeNull();
    expect(catalog[0]?.name).toBe("Первый");
    fireEvent.click(screen.getByRole("button", { name: "Удалить Первый" }));
    await waitFor(() => expect(catalog).toHaveLength(1));
    expect(catalog[0]?.name).toBe("Изменённый");
  });

  it("cancels edits without changing server data", async () => {
    await openApp(products);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Редактировать ${products[0]!.name}`,
      }),
    );
    fill(/^Название товара/, "Несохранённое");
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(catalog).toEqual(products);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the form and original catalog when saving fails", async () => {
    await openApp();
    fireEvent.click(screen.getByRole("button", { name: "Добавить товар" }));
    fillProduct();
    fetchMock.mockResolvedValueOnce(
      respond(
        { error: "Список изменён в другой вкладке.", code: "CONFLICT" },
        409,
      ),
    );
    submitProduct();
    await screen.findByRole("alert");
    expect(screen.getByRole("form", { name: "Форма товара" })).toBeTruthy();
    expect(
      (
        screen.getByRole("textbox", {
          name: /^Название товара/,
        }) as HTMLInputElement
      ).value,
    ).toBe("Мой телефон");
    expect(catalog).toEqual([]);
  });

  it("filters server results and reports empty searches", async () => {
    await openApp(products);
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать цены" }));
    await screen.findByText("Цены рассчитаны");
    fill(/Поиск по названию/, "dys");
    expect(screen.getAllByRole("row")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "AT_MAX" },
    });
    expect(screen.getByText(/Ничего не найдено/)).toBeTruthy();
  });

  it("appends valid JSON imports and rejects invalid input", async () => {
    await openApp([products[0]!]);
    const input = screen.getByLabelText("Данные товаров");
    fireEvent.change(input, { target: { value: "{broken" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByRole("alert").textContent).toContain(
      "Некорректный JSON",
    );
    fireEvent.change(input, { target: { value: "{}" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByRole("alert").textContent).toContain("массив товаров");
    fireEvent.change(input, {
      target: { value: JSON.stringify([products[1]]) },
    });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("DYS-V8");
    expect(catalog).toHaveLength(2);
  });

  it("retains products on network failure and permits retry", async () => {
    await openApp(products);
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать цены" }));
    await screen.findByRole("alert");
    expect(screen.getByText("APL-15-128")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать цены" }));
    await screen.findByText("Цены рассчитаны");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Authentication UI", () => {
  it("logs in using the server session", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ user, csrfToken: "b".repeat(64) }),
    );
    const onLogin = vi.fn();
    render(<Auth onLogin={onLogin} link={null} />);
    fireEvent.change(screen.getByLabelText("Электронная почта"), {
      target: { value: user.email },
    });
    fireEvent.change(screen.getByLabelText("Пароль"), {
      target: { value: "long-password" },
    });
    fireEvent.submit(screen.getByLabelText("Пароль").closest("form")!);
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(user));
  });
  it("shows login errors and a verification resend option", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ error: "Подтвердите почту.", code: "EMAIL_UNVERIFIED" }, 403),
    );
    render(<Auth onLogin={vi.fn()} link={null} />);
    fireEvent.submit(screen.getByLabelText("Пароль").closest("form")!);
    await screen.findByRole("alert");
    fireEvent.click(
      screen.getByRole("button", { name: /Отправить подтверждение повторно/ }),
    );
    expect(screen.getByText("Подтверждение почты")).toBeTruthy();
  });
});

describe("Provider controls", () => {
  it("disables unavailable providers and explains the alternative", () => {
    render(<OAuthButtons providers={{ google: false, apple: false }} />);
    expect(
      (
        screen.getByRole("button", {
          name: "Войти через Google",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Войти через Apple",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/Используйте почту/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reports a failed start and lets the user retry", async () => {
    fetchMock.mockResolvedValue(
      respond({ error: "Провайдер недоступен" }, 503),
    );
    render(<OAuthButtons providers={{ google: true, apple: false }} />);
    fireEvent.click(screen.getByRole("button", { name: "Войти через Google" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Провайдер недоступен",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/oauth/google/start",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": "a".repeat(64) }),
      }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Войти через Google",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
