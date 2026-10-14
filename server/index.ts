import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { createMailer } from "./mail.js";

const config = readConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
const app = createApp({ pool, config, sendMail: createMailer(config) });
const server = app.listen(config.port, config.host, () =>
  console.log(`SaleScout: http://${config.host}:${config.port}`),
);
// Bounded cleanup of expired tokens and sessions. Both remain invalid before cleanup.
const cleanup = setInterval(() => {
  void pool
    .query(
      "DELETE FROM email_tokens WHERE expires_at < now(); DELETE FROM sessions WHERE expire < now(); DELETE FROM oauth_flows WHERE expires_at < now()",
    )
    .catch((error) => console.error("Cleanup failed:", error.message));
}, 3600000).unref();
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    clearInterval(cleanup);
    const timeout = setTimeout(() => process.exit(1), 10000).unref();
    server.close(() => {
      void pool.end().finally(() => {
        clearTimeout(timeout);
        process.exit(0);
      });
    });
  });
}
