const express = require("express");
const { query } = require("../lib/db");

const router = express.Router();

// Matches the `rebate_percent` default on the `users` table. This route has
// no per-user auth context (it's fetched before/without login), so it shows
// the rate a typical user earns. If per-user rebate tiers are introduced,
// this route should accept an optional Authorization header and use that
// user's actual rebate_percent instead.
const DEFAULT_REBATE_PERCENT = 0.8;

function formatCashback(commissionRate, cashbackType) {
  const rate = Number((commissionRate * DEFAULT_REBATE_PERCENT).toFixed(2));
  const label =
    cashbackType === "flat"
      ? `$${rate.toFixed(2)} Cash Back`
      : `${rate % 1 === 0 ? rate.toFixed(0) : rate}% Cash Back`;
  return { rate, label };
}

// GET /api/v1/merchants
// Returns the live merchant catalog in the same shape as
// /extension/data/merchants.json, so the extension can refresh its cache
// from the backend without shipping a new version. The displayed cashback
// rate is computed here from cj_commission_rate (the raw % CJ pays this
// publisher) x the rebate percent, not read from a stale pre-baked value —
// so it stays accurate if CJ's commission rate changes.
router.get("/merchants", async (req, res, next) => {
  try {
    const result = await query(
      `select id, name, domains, logo_url, category, cj_advertiser_id,
              cj_commission_rate, cashback_type, terms, active
       from merchants
       where active = true
       order by name asc`
    );

    const merchants = result.rows.map((row) => {
      const { rate, label } = formatCashback(
        Number(row.cj_commission_rate),
        row.cashback_type
      );
      return {
        id: row.id,
        name: row.name,
        domains: row.domains,
        logo: row.logo_url,
        category: row.category,
        cjAdvertiserId: row.cj_advertiser_id,
        cashbackType: row.cashback_type,
        cashbackRate: rate,
        cashbackLabel: label,
        terms: row.terms,
        active: row.active,
      };
    });

    res.json({ merchants, updatedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
