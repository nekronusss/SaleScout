import express, { type ErrorRequestHandler } from "express";
import { fileURLToPath } from "node:url";
import { calculatePrice } from "../src/pricing.js";
import type { Product } from "../src/types.js";
import { isProduct } from "../src/validation.js";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { createSaaS, type SaaSOptions } from "./saas.js";

export function createApp(saas?: SaaSOptions) {
  const app = express();
  app.disable("x-powered-by");
  if (saas) app.set("trust proxy", saas.config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: saas?.config.production ? [] : null,
        },
      },
      strictTransportSecurity: saas?.config.production ? undefined : false,
    }),
  );
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    if (saas && !saas.disableRateLimit) {
      const start = Date.now();
      res.on("finish", () =>
        console.log(
          JSON.stringify({
            requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Date.now() - start,
          }),
        ),
      );
    }
    next();
  });
  if (saas && !saas.disableRateLimit)
    app.use(
      rateLimit({
        windowMs: 60000,
        limit: 180,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: { error: "Слишком много запросов. Попробуйте через минуту." },
      }),
    );
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/readyz", async (_req, res) => {
    try {
      if (saas) await saas.pool.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  if (saas) app.use("/api", createSaaS(saas));
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API-эндпоинт не найден." }),
  );

  app.post("/reprice", (req, res) => {
    const body: unknown = req.body;
    if (!Array.isArray(body)) {
      res.status(400).json({
        error: "Тело запроса должно быть массивом товаров (Product[]).",
      });
      return;
    }

    const products: Product[] = [];
    for (const [index, item] of body.entries()) {
      if (!isProduct(item)) {
        res.status(400).json({
          error: `Некорректный товар с индексом ${index}. Проверьте поля, диапазон цен и конкурентов.`,
        });
        return;
      }
      products.push(item);
    }
    res.json(products.map(calculatePrice));
  });

  // After npm run build the API also serves the compiled React application.
  app.use(express.static(fileURLToPath(new URL("../client", import.meta.url))));

  const handleError: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? error.status
        : undefined;
    if (status === 400) {
      res.status(400).json({ error: "Некорректный JSON в теле запроса." });
    } else if (status === 413) {
      res.status(413).json({ error: "Размер запроса превышает 1 МБ." });
    } else {
      console.error(
        JSON.stringify({
          requestId: res.locals.requestId,
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
      res.status(500).json({
        error: "Не удалось выполнить действие. Попробуйте позже.",
        requestId: res.locals.requestId,
      });
    }
  };
  app.use(handleError);
  return app;
}

// Stateless endpoint stays importable for the original assignment tests.
export const app = createApp();
