import { useRef, useState, type FormEvent } from "react";
import type { Product } from "../../src/types";
import { Icon } from "./Icon";

type PriceField = "myPrice" | "minPrice" | "maxPrice" | "step";
type Draft = Record<PriceField | "sku" | "name", string>;
interface CompetitorDraft {
  id: string;
  seller: string;
  price: string;
  inStock: boolean;
}
interface Props {
  product: Product | null;
  onSave: (product: Product) => void | Promise<void>;
  onCancel: () => void;
  saving?: boolean;
}

// Text fields accept both decimal separators without converting empty input to zero.
function parsePrice(value: string): number {
  const normalized = value
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(",", ".");
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}

const priceFields: {
  key: PriceField;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    key: "myPrice",
    label: "Текущая цена",
    hint: "Цена, по которой вы продаёте сейчас",
    placeholder: "Например, 150 000",
  },
  {
    key: "step",
    label: "Шаг снижения",
    hint: "На сколько быть дешевле конкурента",
    placeholder: "Например, 10",
  },
  {
    key: "minPrice",
    label: "Минимальная цена",
    hint: "Нижняя граница, целое число",
    placeholder: "Например, 120 000",
  },
  {
    key: "maxPrice",
    label: "Максимальная цена",
    hint: "Верхняя граница, целое число",
    placeholder: "Например, 180 000",
  },
];

export function ProductForm({
  product,
  onSave,
  onCancel,
  saving = false,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<Draft>({
    sku: product?.sku ?? "",
    name: product?.name ?? "",
    myPrice: product ? String(product.myPrice) : "",
    minPrice: product ? String(product.minPrice) : "",
    maxPrice: product ? String(product.maxPrice) : "",
    step: product ? String(product.step) : "1",
  });
  const [competitors, setCompetitors] = useState<CompetitorDraft[]>(() =>
    (product?.competitors ?? []).map((item) => ({
      ...item,
      price: String(item.price),
      id: crypto.randomUUID(),
    })),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(key: string) {
    setErrors((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function updateField(key: keyof Draft, value: string) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    clearError(key);
    if (key === "minPrice") clearError("maxPrice");
  }

  function updateCompetitor(id: string, update: Partial<CompetitorDraft>) {
    setCompetitors((previous) =>
      previous.map((item) => (item.id === id ? { ...item, ...update } : item)),
    );
    for (const key of Object.keys(update)) clearError(`${id}-${key}`);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (!draft.sku.trim() || draft.sku.length > 120)
      nextErrors.sku = "Укажите артикул длиной до 120 символов.";
    if (!draft.name.trim() || draft.name.length > 240)
      nextErrors.name = "Укажите название длиной до 240 символов.";
    const prices = {
      myPrice: parsePrice(draft.myPrice),
      minPrice: parsePrice(draft.minPrice),
      maxPrice: parsePrice(draft.maxPrice),
      step: parsePrice(draft.step),
    };
    for (const { key } of priceFields) {
      if (
        !Number.isFinite(prices[key]) ||
        prices[key] < 0 ||
        prices[key] > Number.MAX_SAFE_INTEGER
      )
        nextErrors[key] =
          "Введите число от 0 до 9 007 199 254 740 991. Дробную часть можно отделить запятой.";
      else if (
        (key === "minPrice" || key === "maxPrice") &&
        !Number.isInteger(prices[key])
      )
        nextErrors[key] = "Граница цены должна быть целым числом.";
    }
    if (prices.minPrice > prices.maxPrice)
      nextErrors.maxPrice = "Максимальная цена не может быть ниже минимальной.";
    for (const competitor of competitors) {
      if (!competitor.seller.trim() || competitor.seller.length > 240)
        nextErrors[`${competitor.id}-seller`] =
          "Укажите название продавца длиной до 240 символов.";
      if (
        !Number.isFinite(parsePrice(competitor.price)) ||
        parsePrice(competitor.price) > Number.MAX_SAFE_INTEGER
      )
        nextErrors[`${competitor.id}-price`] = "Введите допустимую цену от 0.";
    }
    setErrors(nextErrors);
    const firstError = Object.keys(nextErrors)[0];
    if (firstError) {
      const field = formRef.current?.elements.namedItem(firstError);
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }
    void onSave({
      ...prices,
      sku: draft.sku.trim(),
      name: draft.name.trim(),
      competitors: competitors.map((item) => ({
        seller: item.seller.trim(),
        price: parsePrice(item.price),
        inStock: item.inStock,
      })),
    });
  }

  function fieldAttributes(key: string) {
    return {
      name: key,
      id: key,
      "aria-invalid": Boolean(errors[key]),
      "aria-describedby": errors[key] ? `${key}-error` : undefined,
    };
  }

  const errorText = (key: string) =>
    errors[key] && (
      <span className="field-error" id={`${key}-error`}>
        {errors[key]}
      </span>
    );

  return (
    <section className="panel editor" aria-labelledby="editor-title">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">ДАННЫЕ ТОВАРА</div>
          <h2 id="editor-title">
            {product ? "Редактировать товар" : "Новый товар"}
          </h2>
          <p>Заполните цены и добавьте известных конкурентов.</p>
        </div>
        <button
          className="icon-button"
          onClick={onCancel}
          aria-label="Закрыть форму"
          disabled={saving}
        >
          <Icon name="close" />
        </button>
      </div>
      <form
        ref={formRef}
        onSubmit={submit}
        noValidate
        aria-label="Форма товара"
      >
        <fieldset className="plain-fieldset" disabled={saving}>
          <div className="editor-grid">
            <div className="product-fields">
              <h3>
                <span className="step-number">1</span> Товар и границы цены
              </h3>
              <div className="fields-grid">
                <label className="field field-wide" htmlFor="name">
                  <span>Название товара</span>
                  <input
                    {...fieldAttributes("name")}
                    autoFocus
                    value={draft.name}
                    onChange={(event) =>
                      updateField("name", event.target.value)
                    }
                    placeholder="Например, Apple iPhone 15, 128 ГБ"
                    autoComplete="off"
                  />
                  {errorText("name")}
                </label>
                <label className="field field-wide" htmlFor="sku">
                  <span>Артикул / SKU</span>
                  <input
                    {...fieldAttributes("sku")}
                    value={draft.sku}
                    onChange={(event) => updateField("sku", event.target.value)}
                    placeholder="Например, IPHONE-15-128"
                    autoComplete="off"
                  />
                  {errorText("sku")}
                </label>
                {priceFields.map(({ key, label, hint, placeholder }) => (
                  <label className="field" htmlFor={key} key={key}>
                    <span>{label}</span>
                    <div className="money-input">
                      <input
                        {...fieldAttributes(key)}
                        inputMode="decimal"
                        value={draft[key]}
                        onChange={(event) =>
                          updateField(key, event.target.value)
                        }
                        placeholder={placeholder.replaceAll(" ", "\u00a0")}
                      />
                      <span aria-hidden="true">₸</span>
                    </div>
                    {errorText(key) || <small>{hint}</small>}
                  </label>
                ))}
              </div>
            </div>
            <div className="competitor-fields">
              <div className="section-heading">
                <h3>
                  <span className="step-number">2</span> Конкуренты{" "}
                  <span className="count">{competitors.length}</span>
                </h3>
                <span className="optional">Необязательно</span>
              </div>
              <p className="section-hint">
                В расчёт попадут только предложения в наличии.
              </p>
              <div className="competitor-list">
                {competitors.map((item, index) => (
                  <fieldset className="competitor-card" key={item.id}>
                    <legend>Конкурент {index + 1}</legend>
                    <div className="competitor-inputs">
                      <label className="field" htmlFor={`${item.id}-seller`}>
                        <span>Продавец</span>
                        <input
                          {...fieldAttributes(`${item.id}-seller`)}
                          value={item.seller}
                          placeholder="Название магазина"
                          onChange={(event) =>
                            updateCompetitor(item.id, {
                              seller: event.target.value,
                            })
                          }
                        />
                        {errorText(`${item.id}-seller`)}
                      </label>
                      <label className="field" htmlFor={`${item.id}-price`}>
                        <span>Цена конкурента</span>
                        <div className="money-input">
                          <input
                            {...fieldAttributes(`${item.id}-price`)}
                            inputMode="decimal"
                            value={item.price}
                            placeholder="0"
                            onChange={(event) =>
                              updateCompetitor(item.id, {
                                price: event.target.value,
                              })
                            }
                          />
                          <span aria-hidden="true">₸</span>
                        </div>
                        {errorText(`${item.id}-price`)}
                      </label>
                    </div>
                    <div className="competitor-actions">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={item.inStock}
                          onChange={(event) =>
                            updateCompetitor(item.id, {
                              inStock: event.target.checked,
                            })
                          }
                        />
                        В наличии
                      </label>
                      <button
                        type="button"
                        className="text-button danger"
                        aria-label={`Удалить конкурента ${index + 1}`}
                        onClick={() => {
                          setCompetitors((previous) =>
                            previous.filter((row) => row.id !== item.id),
                          );
                          setErrors({});
                        }}
                      >
                        <Icon name="trash" />
                        Удалить
                      </button>
                    </div>
                  </fieldset>
                ))}
                {competitors.length === 0 && (
                  <div className="competitor-empty">
                    <Icon name="box" />
                    <strong>Конкурентов пока нет</strong>
                    <p>
                      Можно сохранить товар без них. В этом случае новая цена
                      будет равна максимальной.
                    </p>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="button secondary add-competitor"
                onClick={() =>
                  setCompetitors((previous) => [
                    ...previous,
                    {
                      id: crypto.randomUUID(),
                      seller: "",
                      price: "",
                      inStock: true,
                    },
                  ])
                }
              >
                <Icon name="plus" />
                Добавить конкурента
              </button>
            </div>
          </div>
          <div className="editor-footer">
            <p>
              {Object.keys(errors).length > 0 ? (
                <span role="alert" className="field-error">
                  Проверьте выделенные поля.
                </span>
              ) : (
                "Все цены — в тенге. Расчёт запускается отдельно."
              )}
            </p>
            <div className="actions">
              <button
                type="button"
                className="button secondary"
                onClick={onCancel}
              >
                Отмена
              </button>
              <button type="submit" className="button primary">
                <Icon name="check" />
                {product ? "Сохранить изменения" : "Сохранить товар"}
              </button>
            </div>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
