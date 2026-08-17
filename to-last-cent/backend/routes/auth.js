const express = require("express");
const { query } = require("../lib/db");
const { hashPassword, verifyPassword, signToken } = require("../lib/auth");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCredentials(email, password) {
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return "A valid email address is required.";
  }
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  return null;
}

// POST /api/v1/auth/signup
router.post("/signup", async (req, res, next) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const { password } = req.body;

    const validationError = validateCredentials(email, password);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const passwordHash = await hashPassword(password);

    const result = await query(
      `insert into users (email, password_hash)
       values ($1, $2)
       returning id`,
      [email, passwordHash]
    );

    const userId = result.rows[0].id;
    const token = signToken(userId);

    res.status(201).json({ userId, token });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    next(err);
  }
});

// POST /api/v1/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const { password } = req.body;

    const validationError = validateCredentials(email, password);
    if (validationError) {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    const result = await query(
      `select id, password_hash from users where email = $1`,
      [email]
    );
    const user = result.rows[0];

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = signToken(user.id);
    res.json({ userId: user.id, token });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
