#!/usr/bin/env node
/**
 * cjSyncWorker.js
 * ---------------------------------------------------------------------------
 * Queries CJ Affiliate's GraphQL Commission Detail API for transactions
 * reported in the last N hours (default 24), matches each transaction's
 * `sid` (the sub-id we pass on every /api/v1/redirect click — see
 * /backend/routes/redirect.js) back to a row in the `users` table, and
 * upserts a corresponding row in `commissions` crediting the user's balance.
 *
 * Run manually:
 *   node cjSyncWorker.js
 *
 * Run on a schedule (recommended: hourly) via cron, a GitHub Actions
 * scheduled workflow, or a platform's Scheduled Job / Cron feature — see
 * the root README for a sample GitHub Actions workflow.
 *
 * NOTE on the GraphQL schema: CJ's Commission Detail API evolves over time.
 * The query below reflects the documented `commissionDetail` root field as
 * of this writing (https://developers.cj.com). If CJ changes field names,
 * re-run their GraphQL introspection query against CJ_GRAPHQL_ENDPOINT and
 * update `COMMISSION_DETAIL_QUERY` + `mapRecordToCommission()` accordingly —
 * both are intentionally kept in one place to make that easy.
 * ---------------------------------------------------------------------------
 */

require("dotenv").config();

const axios = require("axios");
const { Pool } = require("pg");

const {
  DATABASE_URL,
  DATABASE_SSL,
  CJ_PERSONAL_ACCESS_TOKEN,
  CJ_COMPANY_ID,
  CJ_GRAPHQL_ENDPOINT = "https://commission-detail.api.cj.com/query",
  SYNC_LOOKBACK_HOURS = "24",
} = process.env;

function assertEnv() {
  const missing = ["DATABASE_URL", "CJ_PERSONAL_ACCESS_TOKEN", "CJ_COMPANY_ID"].filter(
    (key) => !process.env[key]
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Copy jobs/.env.example to jobs/.env and fill them in."
    );
  }
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// -----------------------------------------------------------------------------
// CJ GraphQL Commission Detail query
// -----------------------------------------------------------------------------

const COMMISSION_DETAIL_QUERY = `
  query CommissionDetail(
    $companyId: ID!
    $sinceCommissionDate: Date!
    $beforeCommissionDate: Date!
    $limit: Int!
  ) {
    commissionDetail(
      forCompanyId: $companyId
      sinceCommissionDate: $sinceCommissionDate
      beforeCommissionDate: $beforeCommissionDate
      records: $limit
    ) {
      count
      totalMatched
      records {
        id
        sid
        orderId
        eventDate
        postingDate
        actionStatus
        advertiserId
        advertiserName
        saleAmount {
          amount
          currency
        }
        commissionAmount {
          amount
          currency
        }
      }
    }
  }
`;

async function fetchCommissionDetail({ sinceISO, beforeISO }) {
  const response = await axios.post(
    CJ_GRAPHQL_ENDPOINT,
    {
      query: COMMISSION_DETAIL_QUERY,
      variables: {
        companyId: CJ_COMPANY_ID,
        sinceCommissionDate: sinceISO,
        beforeCommissionDate: beforeISO,
        limit: 1000,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${CJ_PERSONAL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  if (response.data.errors?.length) {
    throw new Error(
      `CJ GraphQL API returned errors: ${JSON.stringify(response.data.errors)}`
    );
  }

  return response.data.data?.commissionDetail?.records || [];
}

// -----------------------------------------------------------------------------
// actionStatus -> our internal commission status
// -----------------------------------------------------------------------------

function mapActionStatus(actionStatus) {
  switch ((actionStatus || "").toUpperCase()) {
    case "NEW":
    case "PENDING":
      return "pending";
    case "CLOSED":
      return "available";
    case "CORRECTED":
    case "EXTENDED":
      return "pending";
    case "CANCELLED":
    case "DECLINED":
      return "reversed";
    default:
      return "pending";
  }
}

function mapRecordToCommission(record) {
  return {
    cjCommissionId: String(record.id),
    sid: record.sid,
    orderId: record.orderId || null,
    advertiserId: record.advertiserId ? String(record.advertiserId) : null,
    saleAmount: Number(record.saleAmount?.amount || 0),
    commissionAmount: Number(record.commissionAmount?.amount || 0),
    status: mapActionStatus(record.actionStatus),
    eventDate: record.eventDate || null,
    postingDate: record.postingDate || null,
  };
}

// -----------------------------------------------------------------------------
// DB helpers
// -----------------------------------------------------------------------------

/** sid is set to the user's UUID at click time (see backend/routes/redirect.js). */
async function findUserBySid(client, sid) {
  if (!sid) return null;
  const result = await client.query(
    `select id, rebate_percent from users where id = $1`,
    [sid]
  );
  return result.rows[0] || null;
}

async function findMerchantByAdvertiserId(client, advertiserId) {
  if (!advertiserId) return null;
  const result = await client.query(
    `select id from merchants where cj_advertiser_id = $1`,
    [advertiserId]
  );
  return result.rows[0] || null;
}

/** Best-effort link to the click_session that generated this sid/merchant pair. */
async function findClickSession(client, userId, merchantId) {
  if (!merchantId) return null;
  const result = await client.query(
    `select id from click_sessions
     where user_id = $1 and merchant_id = $2
     order by created_at desc
     limit 1`,
    [userId, merchantId]
  );
  return result.rows[0]?.id || null;
}

async function upsertCommission(client, commission, userId, merchantId, clickSessionId) {
  const rebateResult = await client.query(
    `select rebate_percent from users where id = $1`,
    [userId]
  );
  const rebatePercent = Number(rebateResult.rows[0]?.rebate_percent ?? 0.8);
  const userEarningAmount = Number((commission.commissionAmount * rebatePercent).toFixed(2));

  const result = await client.query(
    `insert into commissions (
       user_id, click_session_id, merchant_id, cj_commission_id, cj_order_id,
       sale_amount, commission_amount, user_earning_amount, status,
       event_date, posting_date
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (cj_commission_id) do update set
       sale_amount = excluded.sale_amount,
       commission_amount = excluded.commission_amount,
       user_earning_amount = excluded.user_earning_amount,
       status = excluded.status,
       posting_date = excluded.posting_date
     returning (xmax = 0) as inserted`,
    [
      userId,
      clickSessionId,
      merchantId,
      commission.cjCommissionId,
      commission.orderId,
      commission.saleAmount,
      commission.commissionAmount,
      userEarningAmount,
      commission.status,
      commission.eventDate,
      commission.postingDate,
    ]
  );

  return { userEarningAmount, inserted: result.rows[0]?.inserted === true };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function run() {
  assertEnv();

  const lookbackHours = Number(SYNC_LOOKBACK_HOURS) || 24;
  const before = new Date();
  const since = new Date(before.getTime() - lookbackHours * 60 * 60 * 1000);

  console.log(
    `[cjSyncWorker] Fetching CJ commissions from ${since.toISOString()} to ${before.toISOString()}…`
  );

  const records = await fetchCommissionDetail({
    sinceISO: since.toISOString(),
    beforeISO: before.toISOString(),
  });

  console.log(`[cjSyncWorker] CJ returned ${records.length} commission record(s).`);

  const summary = { matched: 0, unmatchedSid: 0, inserted: 0, updated: 0, totalCredited: 0 };

  const client = await pool.connect();
  try {
    for (const raw of records) {
      const commission = mapRecordToCommission(raw);

      const user = await findUserBySid(client, commission.sid);
      if (!user) {
        summary.unmatchedSid += 1;
        console.warn(
          `[cjSyncWorker] No user found for sid="${commission.sid}" (cjCommissionId=${commission.cjCommissionId}) — skipping.`
        );
        continue;
      }

      const merchant = await findMerchantByAdvertiserId(client, commission.advertiserId);
      const clickSessionId = merchant
        ? await findClickSession(client, user.id, merchant.id)
        : null;

      const { userEarningAmount, inserted } = await upsertCommission(
        client,
        commission,
        user.id,
        merchant?.id || null,
        clickSessionId
      );

      summary.matched += 1;
      summary.totalCredited += userEarningAmount;
      if (inserted) summary.inserted += 1;
      else summary.updated += 1;
    }
  } finally {
    client.release();
  }

  console.log("[cjSyncWorker] Sync complete:", {
    ...summary,
    totalCredited: `$${summary.totalCredited.toFixed(2)}`,
  });
}

run()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("[cjSyncWorker] Sync failed:", err.response?.data || err.message || err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
