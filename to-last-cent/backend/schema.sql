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
  cashback_type     text not null default 'percent'
                      check (cashback_type in ('percent', 'flat')),
  cashback_rate     numeric(6,2) not null,             -- e.g. 4.00 = 4% or $4.00 flat
  cashback_label    text not null,                     -- e.g. "4% Cash Back"
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
-- -----------------------------------------------------------------------------
insert into merchants
  (id, name, domains, logo_url, category, cj_advertiser_id, destination_url, cashback_type, cashback_rate, cashback_label, terms, active)
values
  ('nike', 'Nike', array['nike.com','www.nike.com'], 'https://logo.clearbit.com/nike.com', 'Apparel & Shoes', '3450151', 'https://www.nike.com', 'percent', 4.00, '4% Cash Back', 'Excludes gift cards and clearance items.', true),
  ('expedia', 'Expedia', array['expedia.com','www.expedia.com'], 'https://logo.clearbit.com/expedia.com', 'Travel', '2734166', 'https://www.expedia.com', 'percent', 3.50, '3.5% Cash Back', 'Cashback varies by booking type.', true),
  ('macys', 'Macy''s', array['macys.com','www.macys.com'], 'https://logo.clearbit.com/macys.com', 'Department Stores', '2247725', 'https://www.macys.com', 'percent', 6.00, '6% Cash Back', 'Excludes furniture, mattresses, and gift cards.', true),
  ('priceline', 'Priceline', array['priceline.com','www.priceline.com'], 'https://logo.clearbit.com/priceline.com', 'Travel', '1997855', 'https://www.priceline.com', 'percent', 2.00, '2% Cash Back', 'Applies to Express Deals and retail bookings only.', true),
  ('office-depot', 'Office Depot', array['officedepot.com','www.officedepot.com'], 'https://logo.clearbit.com/officedepot.com', 'Office Supplies', '2149289', 'https://www.officedepot.com', 'percent', 5.00, '5% Cash Back', 'Excludes technology and print/copy services.', true),
  ('vistaprint', 'Vistaprint', array['vistaprint.com','www.vistaprint.com'], 'https://logo.clearbit.com/vistaprint.com', 'Printing & Design', '1069215', 'https://www.vistaprint.com', 'percent', 8.00, '8% Cash Back', 'New customers only on some promotions.', true),
  ('gnc', 'GNC', array['gnc.com','www.gnc.com'], 'https://logo.clearbit.com/gnc.com', 'Health & Wellness', '2029352', 'https://www.gnc.com', 'percent', 7.00, '7% Cash Back', 'Excludes gold card memberships.', true),
  ('adidas', 'adidas', array['adidas.com','www.adidas.com'], 'https://logo.clearbit.com/adidas.com', 'Apparel & Shoes', '3623597', 'https://www.adidas.com', 'percent', 3.00, '3% Cash Back', 'Excludes limited edition releases.', true),
  ('wayfair', 'Wayfair', array['wayfair.com','www.wayfair.com'], 'https://logo.clearbit.com/wayfair.com', 'Home & Furniture', '3874318', 'https://www.wayfair.com', 'percent', 2.50, '2.5% Cash Back', 'Excludes Wayfair Professional orders.', true),
  ('hotwire', 'Hotwire', array['hotwire.com','www.hotwire.com'], 'https://logo.clearbit.com/hotwire.com', 'Travel', '1993197', 'https://www.hotwire.com', 'percent', 1.50, '1.5% Cash Back', 'Hot Rate bookings may be excluded.', true)
on conflict (id) do update set
  name = excluded.name,
  domains = excluded.domains,
  logo_url = excluded.logo_url,
  category = excluded.category,
  cj_advertiser_id = excluded.cj_advertiser_id,
  destination_url = excluded.destination_url,
  cashback_type = excluded.cashback_type,
  cashback_rate = excluded.cashback_rate,
  cashback_label = excluded.cashback_label,
  terms = excluded.terms,
  active = excluded.active;
