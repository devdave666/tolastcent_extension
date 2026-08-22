-- =============================================================================
-- To Last Cent — Backend Schema (PostgreSQL / Supabase)
--
-- Run against a fresh Supabase project (SQL Editor) or any Postgres 13+
-- instance:
--   psql "$DATABASE_URL" -f schema.sql
-- =============================================================================

create extension if not exists pgcrypto; -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- users
--   One row per To Last Cent account. `rebate_percent` is the share of the
--   CJ commission (0-1) that gets passed on to the user as cashback — the
--   rest is retained as platform revenue.
-- -----------------------------------------------------------------------------
create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  email           citext unique not null,
  password_hash   text not null,
  rebate_percent  numeric(5,4) not null default 0.8000
                    check (rebate_percent > 0 and rebate_percent <= 1),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- citext (case-insensitive text) needs its own extension; fall back to a
-- plain unique index on lower(email) if citext isn't available.
create extension if not exists citext;

-- -----------------------------------------------------------------------------
-- merchants
--   Mirrors /extension/data/merchants.json. Kept in the DB so the backend can
--   serve a live catalog via GET /api/v1/merchants and so /api/v1/redirect
--   can resolve a merchant slug to its CJ advertiser ID and destination URL
--   without redeploying the extension.
-- -----------------------------------------------------------------------------
create table if not exists merchants (
  id                text primary key,               -- slug, e.g. "nike"
  name              text not null,
  domains           text[] not null default '{}',    -- hostnames the extension matches
  logo_url          text,
  category          text,
  cj_advertiser_id  text not null,                    -- CJ "CID" for this advertiser
  destination_url   text not null,                    -- merchant URL to land on after tracking
  cj_commission_rate numeric(6,2) not null,            -- raw % of sale CJ pays the publisher
                                                        -- (source of truth; GET /api/v1/merchants
                                                        -- multiplies this by the user's
                                                        -- rebate_percent to get the displayed rate)
  cashback_type     text not null default 'percent'
                      check (cashback_type in ('percent', 'flat')),
  cashback_rate     numeric(6,2) not null,             -- fallback snapshot, e.g. 4.00 = 4%
  cashback_label    text not null,                     -- fallback snapshot, e.g. "4% Cash Back"
  terms             text,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_merchants_active on merchants (active);

-- -----------------------------------------------------------------------------
-- click_sessions
--   One row per "Activate Cashback" click. `sid` is the value sent to CJ as
--   the sub-ID (currently == user_id) so the cjSyncWorker can match CJ's
--   reported transactions back to a user.
-- -----------------------------------------------------------------------------
create table if not exists click_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users (id) on delete cascade,
  merchant_id       text not null references merchants (id),
  sid               text not null,
  destination_url   text not null,
  ip_address        inet,
  user_agent        text,
  created_at        timestamptz not null default now()
);

create index if not exists idx_click_sessions_user_id on click_sessions (user_id);
create index if not exists idx_click_sessions_sid on click_sessions (sid);
create index if not exists idx_click_sessions_merchant_id on click_sessions (merchant_id);
create index if not exists idx_click_sessions_created_at on click_sessions (created_at);

-- -----------------------------------------------------------------------------
-- commissions
--   One row per CJ commission/transaction record, credited to a user.
--   `cj_commission_id` is CJ's own unique ID for the transaction and is used
--   as an idempotency key so cjSyncWorker can run repeatedly without
--   double-crediting a purchase.
-- -----------------------------------------------------------------------------
create table if not exists commissions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users (id) on delete cascade,
  click_session_id      uuid references click_sessions (id) on delete set null,
  merchant_id           text references merchants (id),
  cj_commission_id      text not null unique,          -- CJ's `id` field, dedupe key
  cj_order_id           text,
  sale_amount           numeric(12,2) not null default 0,
  commission_amount     numeric(12,2) not null default 0, -- what CJ paid the publisher
  user_earning_amount   numeric(12,2) not null default 0, -- commission_amount * rebate_percent
  status                text not null default 'pending'
                          check (status in ('pending', 'available', 'paid', 'reversed')),
  event_date            timestamptz,
  posting_date          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_commissions_user_id on commissions (user_id);
create index if not exists idx_commissions_status on commissions (status);
create index if not exists idx_commissions_merchant_id on commissions (merchant_id);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

drop trigger if exists trg_merchants_updated_at on merchants;
create trigger trg_merchants_updated_at
  before update on merchants
  for each row execute function set_updated_at();

drop trigger if exists trg_commissions_updated_at on commissions;
create trigger trg_commissions_updated_at
  before update on commissions
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- Seed data — keep in sync with /extension/data/merchants.json
-- Real CJ-approved advertisers for this publisher account.
-- -----------------------------------------------------------------------------
insert into merchants
  (id, name, domains, logo_url, category, cj_advertiser_id, destination_url, cj_commission_rate, cashback_type, cashback_rate, cashback_label, terms, active)
values
  ('abracadabra-nyc', 'Abracadabra NYC', array['abracadabranyc.com','www.abracadabranyc.com'], 'https://logo.clearbit.com/abracadabranyc.com', 'Collectibles', '7889430', 'https://www.abracadabranyc.com', 5.00, 'percent', 4.00, '4% Cash Back', 'Excludes gift cards and tips.', true),
  ('oedro', 'OEDRO', array['oedro.com','www.oedro.com'], 'https://logo.clearbit.com/oedro.com', 'Cars & Trucks', '7455332', 'https://www.oedro.com', 5.00, 'percent', 4.00, '4% Cash Back', 'Auto parts & accessories.', true),
  ('velocity-outdoor', 'Velocity Outdoor (Ravin & CenterPoint)', array['ravincrossbows.com','www.ravincrossbows.com','centerpointarchery.com','www.centerpointarchery.com'], 'https://logo.clearbit.com/ravincrossbows.com', 'Hunting & Outdoor Equipment', '6038648', 'https://www.ravincrossbows.com', 5.00, 'percent', 4.00, '4% Cash Back', 'Covers Ravin, CenterPoint & Valhalla brands.', true)
on conflict (id) do update set
  name = excluded.name,
  domains = excluded.domains,
  logo_url = excluded.logo_url,
  category = excluded.category,
  cj_advertiser_id = excluded.cj_advertiser_id,
  destination_url = excluded.destination_url,
  cj_commission_rate = excluded.cj_commission_rate,
  cashback_type = excluded.cashback_type,
  cashback_rate = excluded.cashback_rate,
  cashback_label = excluded.cashback_label,
  terms = excluded.terms,
  active = excluded.active;
