import pg from "pg";
export { type Pool } from "pg";

export function createPool(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
  });
  pool.on("error", (error) =>
    console.error("Database connection error", error.message),
  );
  return pool;
}

// Versioned and serialized so simultaneous application starts cannot race.
export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(7193421)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = await client.query(
      "SELECT version FROM schema_migrations WHERE version = 1",
    );
    if (!applied.rowCount) {
      await client.query(`
        CREATE TABLE users (
          id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
          password_hash text NOT NULL, verified boolean NOT NULL DEFAULT false,
          auth_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE catalogs (
          user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          products jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 0,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE email_tokens (
          token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
          expires_at timestamptz NOT NULL, UNIQUE(user_id, purpose)
        );
        CREATE INDEX email_tokens_expiry_idx ON email_tokens(expires_at);
        CREATE TABLE sessions (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL);
        CREATE INDEX sessions_expiry_idx ON sessions(expire);
        INSERT INTO schema_migrations(version) VALUES (1);
      `);
    }
    const tokenMigration = await client.query(
      "SELECT version FROM schema_migrations WHERE version = 2",
    );
    if (!tokenMigration.rowCount) {
      await client.query(
        "ALTER TABLE email_tokens ADD COLUMN issued_at timestamptz NOT NULL DEFAULT now(); INSERT INTO schema_migrations(version) VALUES (2);",
      );
    }
    const oauthMigration = await client.query(
      "SELECT version FROM schema_migrations WHERE version = 3",
    );
    if (!oauthMigration.rowCount) {
      await client.query(`
        ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
        CREATE TABLE oauth_identities (
          provider text NOT NULL CHECK (provider IN ('google','apple')),
          subject text NOT NULL, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY(provider,subject), UNIQUE(user_id,provider)
        );
        CREATE TABLE oauth_flows (
          state_hash text PRIMARY KEY, code text, error text, expires_at timestamptz NOT NULL
        );
        CREATE INDEX oauth_flows_expiry_idx ON oauth_flows(expires_at);
        INSERT INTO schema_migrations(version) VALUES (3);
      `);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
