const express = require("express");
const { query } = require("../lib/db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();

// GET /api/v1/user/balance
// Requires `Authorization: Bearer <token>`. The user id is always taken from
// the verified token, never from the `user_id` query string, to prevent one
// user from reading another user's balance — the query param (sent by the
// extension for readability/debugging) is only checked for consistency.
router.get("/balance", requireAuth, async (req, res, next) => {
  try {
    if (req.query.user_id && String(req.query.user_id) !== String(req.userId)) {
      return res.status(403).json({ error: "user_id does not match the authenticated user." });
    }

    const result = await query(
      `select status, coalesce(sum(user_earning_amount), 0) as total
       from commissions
       where user_id = $1 and status in ('pending', 'available')
       group by status`,
      [req.userId]
    );

    const totals = { pending: 0, available: 0 };
    for (const row of result.rows) {
      totals[row.status] = Number(row.total);
    }

    res.json({
      userId: req.userId,
      pending: Number(totals.pending.toFixed(2)),
      available: Number(totals.available.toFixed(2)),
      currency: "USD",
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
