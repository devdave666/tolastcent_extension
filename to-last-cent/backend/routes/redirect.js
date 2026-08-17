const express = require("express");
const { query } = require("../lib/db");

const router = express.Router();

const CJ_PUBLISHER_ID = process.env.CJ_PUBLISHER_ID;
const CJ_TRACKING_DOMAIN = process.env.CJ_TRACKING_DOMAIN || "www.anrdoezrs.net";

/**
 * Builds a CJ Affiliate deep-link tracking URL.
 *
 * Format: https://<tracking-domain>/click-<PID>-<CID>?url=<destination>&sid=<sid>
 *   PID = your CJ Publisher ID (CJ_PUBLISHER_ID)
 *   CID = the advertiser's CJ ID (merchant.cj_advertiser_id)
 *   sid = sub-id CJ echoes back on the commission record — we use it to
 *         match transactions back to a user in cjSyncWorker.js.
 */
function buildTrackingUrl({ advertiserId, destinationUrl, sid }) {
  const url = new URL(`https://${CJ_TRACKING_DOMAIN}/click-${CJ_PUBLISHER_ID}-${advertiserId}`);
  url.searchParams.set("url", destinationUrl);
  url.searchParams.set("sid", sid);
  return url.toString();
}

// GET /api/v1/redirect?user_id=123&merchant=nike
//
// Logs the click session and 302s to the merchant's CJ Affiliate tracking
// link with `&sid=<user_id>` appended, so CJ attributes the resulting
// purchase to this user's account.
router.get("/redirect", async (req, res, next) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const merchantId = String(req.query.merchant || "").trim().toLowerCase();

    if (!userId || !merchantId) {
      return res.status(400).json({ error: "Both user_id and merchant are required." });
    }

    if (!CJ_PUBLISHER_ID) {
      return res.status(500).json({ error: "Server is missing CJ_PUBLISHER_ID configuration." });
    }

    const [userResult, merchantResult] = await Promise.all([
      query(`select id from users where id = $1`, [userId]),
      query(`select * from merchants where id = $1 and active = true`, [merchantId]),
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "Unknown user_id." });
    }
    if (merchantResult.rows.length === 0) {
      return res.status(404).json({ error: "Unknown or inactive merchant." });
    }

    const merchant = merchantResult.rows[0];
    const sid = userId;

    const trackingUrl = buildTrackingUrl({
      advertiserId: merchant.cj_advertiser_id,
      destinationUrl: merchant.destination_url,
      sid,
    });

    await query(
      `insert into click_sessions (user_id, merchant_id, sid, destination_url, ip_address, user_agent)
       values ($1, $2, $3, $4, $5, $6)`,
      [userId, merchant.id, sid, merchant.destination_url, req.ip, req.get("user-agent") || null]
    );

    res.redirect(302, trackingUrl);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
