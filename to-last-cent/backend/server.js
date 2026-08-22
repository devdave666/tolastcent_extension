require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const balanceRoutes = require("./routes/balance");
const redirectRoutes = require("./routes/redirect");
const merchantRoutes = require("./routes/merchants");

const app = express();
const PORT = process.env.PORT || 4000;

// Behind a reverse proxy (Render, Fly, Railway, etc.) so req.ip reflects the
// real client address for click_sessions.ip_address.
app.set("trust proxy", 1);

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server / curl requests with no Origin header, and
      // any origin explicitly listed in CORS_ORIGINS.
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS_ORIGINS`));
    },
  })
);

app.use(express.json());

// Basic brute-force protection on auth endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// /api/v1/redirect is unauthenticated by necessity (it's a plain browser
// navigation, no custom headers possible) and every hit fires a real click
// through CJ's tracking network. Without a limit here, anyone could script
// unlimited requests with arbitrary user_id/merchant pairs — this wouldn't
// let them extract money (payouts only ever come from CJ's own reported
// commissions, never from a click alone), but a burst of fake clicks with
// zero conversions is exactly the "invalid traffic" pattern that gets a CJ
// publisher account suspended. 30 clicks / 15 min per IP comfortably covers
// real usage while blocking that.
const redirectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true, service: "to-last-cent-backend", time: new Date().toISOString() });
});

app.use("/api/v1/auth", authLimiter, authRoutes);
app.use("/api/v1/user", balanceRoutes);
app.use("/api/v1", redirectLimiter, redirectRoutes);
app.use("/api/v1", merchantRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`To Last Cent backend listening on http://localhost:${PORT}`);
});

module.exports = app;
