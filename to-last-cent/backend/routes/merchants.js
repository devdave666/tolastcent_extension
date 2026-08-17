const express = require("express");
const { query } = require("../lib/db");

const router = express.Router();

// GET /api/v1/merchants
// Returns the live merchant catalog in the same shape as
// /extension/data/merchants.json, so the extension can refresh its cache
// from the backend without shipping a new version.
router.get("/merchants", async (req, res, next) => {
  try {
    const result = await query(
      `select id, name, domains, logo_url, category, cj_advertiser_id,
              cashback_type, cashback_rate, cashback_label, terms, active
       from merchants
       where active = true
       order by name asc`
    );

    const merchants = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      domains: row.domains,
      logo: row.logo_url,
      category: row.category,
      cjAdvertiserId: row.cj_advertiser_id,
      cashbackType: row.cashback_type,
      cashbackRate: Number(row.cashback_rate),
      cashbackLabel: row.cashback_label,
      terms: row.terms,
      active: row.active,
    }));

    res.json({ merchants, updatedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
