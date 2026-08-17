const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy backend/.env.example to backend/.env and configure it."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: false }
      : false,
  max: Number(process.env.DATABASE_POOL_MAX || 10),
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client:", err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
