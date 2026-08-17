# To Last Cent

Automated cashback at checkout. Save to the last cent.

To Last Cent is a Chrome extension + backend platform that automatically
detects when you're shopping at a partner store, lets you activate cashback
in one click, tracks the resulting purchase through the **CJ Affiliate**
network, and credits your account once CJ reports the commission.

```
/to-last-cent/
├── /extension/        Chrome Manifest V3 extension (banner + popup)
├── /landing-page/     Tailwind CSS marketing site (GitHub Pages)
├── /backend/          Express API (auth, redirect tracking, balances)
├── /jobs/             CJ GraphQL Commission Detail sync worker
└── README.md          You are here
```

## How it fits together

1. A user installs the **extension** and creates an account (handled by the
   **backend**'s `/api/v1/auth` routes).
2. The extension detects merchant domains (`extension/data/merchants.json`,
   refreshed from `GET /api/v1/merchants`) and shows an "Activate Cashback"
   banner.
3. Clicking **Activate** opens `GET /api/v1/redirect?user_id=…&merchant=…`,
   which logs a `click_sessions` row and 302-redirects through CJ's tracking
   domain with `&sid=<user_id>` appended, then on to the merchant.
4. CJ tracks the resulting order against that `sid`. On a schedule, **jobs**
   `cjSyncWorker.js` queries CJ's GraphQL Commission Detail API, matches each
   transaction's `sid` back to a `users.id`, and upserts a row in
   `commissions`.
5. The popup calls `GET /api/v1/user/balance` to show **Pending** (CJ hasn't
   finalized the order yet) vs. **Available** (commission closed, ready to
   pay out) balances.

---

## Prerequisites

- Node.js 18+
- A PostgreSQL database — [Supabase](https://supabase.com) is the easiest
  path (free tier, hosted, works out of the box with `schema.sql`), but any
  Postgres 13+ instance works.
- A [CJ Affiliate](https://www.cj.com) **Publisher** account, approved into
  the merchant programs you want to feature.
- Google Chrome (or any Chromium browser) for loading the extension.

---

## 1. Database setup (Supabase / PostgreSQL)

1. Create a new Supabase project (or a local/hosted Postgres database).
2. Open the SQL editor (or `psql`) and run the schema:

   ```bash
   psql "$DATABASE_URL" -f backend/schema.sql
   ```

   This creates `users`, `merchants`, `click_sessions`, and `commissions`,
   and seeds `merchants` with the same catalog shipped in
   `extension/data/merchants.json`.
3. Grab your connection string: **Supabase → Project Settings → Database →
   Connection string (URI)**. You'll use it as `DATABASE_URL` below.

---

## 2. Backend API (`/backend`)

```bash
cd backend
npm install
cp .env.example .env
```

Fill in `backend/.env`:

| Variable | Where to get it |
| --- | --- |
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string |
| `DATABASE_SSL` | `true` for Supabase/hosted Postgres, `false` for local |
| `JWT_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_EXPIRES_IN` | Session lifetime, e.g. `30d` |
| `CJ_PUBLISHER_ID` | CJ dashboard → Account → Websites (a.k.a. PID) |
| `CJ_TRACKING_DOMAIN` | Any CJ deep-link domain, e.g. `www.anrdoezrs.net` |
| `CORS_ORIGINS` | Your unpacked extension's `chrome-extension://<id>` + your GitHub Pages URL |

Run it:

```bash
npm run dev      # auto-restarts on file changes (node --watch)
# or
npm start
```

The API listens on `http://localhost:4000` by default. Health check:
`GET /healthz`.

### Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/signup` | — | Create an account, returns `{ userId, token }` |
| `POST` | `/api/v1/auth/login` | — | Returns `{ userId, token }` |
| `GET` | `/api/v1/user/balance` | Bearer token | Returns `{ pending, available, currency }` |
| `GET` | `/api/v1/redirect?user_id=&merchant=` | — | Logs the click, 302s to CJ with `&sid=<user_id>` |
| `GET` | `/api/v1/merchants` | — | Live merchant catalog (same shape as `merchants.json`) |

---

## 3. CJ sync worker (`/jobs`)

This script pulls yesterday's (rolling 24h) commissions from CJ and credits
users. It's meant to run on a schedule, not stay running.

```bash
cd jobs
npm install
cp .env.example .env
```

Fill in `jobs/.env`:

| Variable | Where to get it |
| --- | --- |
| `DATABASE_URL` / `DATABASE_SSL` | Same database as `/backend` |
| `CJ_PERSONAL_ACCESS_TOKEN` | [developers.cj.com](https://developers.cj.com) → Account Manager → GraphQL API Tokens |
| `CJ_COMPANY_ID` | CJ Publisher dashboard → account settings ("Company ID") |
| `CJ_GRAPHQL_ENDPOINT` | Defaults to `https://commission-detail.api.cj.com/query` |
| `SYNC_LOOKBACK_HOURS` | Defaults to `24`; run the job at least that often |

Run it manually:

```bash
npm run sync
```

### Scheduling it

Run hourly via cron:

```cron
0 * * * * cd /path/to/to-last-cent/jobs && /usr/bin/node cjSyncWorker.js >> sync.log 2>&1
```

Or via a GitHub Actions scheduled workflow (`.github/workflows/cj-sync.yml`):

```yaml
name: CJ Commission Sync
on:
  schedule:
    - cron: "0 * * * *" # hourly
  workflow_dispatch: {}
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
        working-directory: jobs
      - run: npm run sync
        working-directory: jobs
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          DATABASE_SSL: "true"
          CJ_PERSONAL_ACCESS_TOKEN: ${{ secrets.CJ_PERSONAL_ACCESS_TOKEN }}
          CJ_COMPANY_ID: ${{ secrets.CJ_COMPANY_ID }}
```

> **Note on CJ's GraphQL schema:** `jobs/cjSyncWorker.js` isolates the query
> (`COMMISSION_DETAIL_QUERY`) and the response-mapping function
> (`mapRecordToCommission`) at the top of the file. CJ occasionally revises
> field names on the Commission Detail API — if a sync run errors on schema
> mismatch, run CJ's GraphQL introspection query against
> `CJ_GRAPHQL_ENDPOINT` and adjust those two spots.

---

## 4. Chrome extension (`/extension`)

1. Point the extension at your backend: edit `extension/config.js` →
   `API_BASE_URL` (defaults to `http://localhost:4000`). For a deployed
   backend, use its public HTTPS URL.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select the `extension/` folder.
3. Copy the generated extension ID and add it to `backend/.env`'s
   `CORS_ORIGINS` as `chrome-extension://<that-id>`, then restart the
   backend.
4. Visit any domain listed in `extension/data/merchants.json` (e.g.
   `nike.com`) — the dark/emerald "Activate Cashback" banner should appear.
5. Click the toolbar icon to sign up/sign in, see your **Pending** /
   **Available** balances, and search stores.

### Publishing

Zip the `extension/` folder (manifest at the zip root) and upload it via the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
Before submitting, update `manifest.json`'s `version` and confirm
`host_permissions` only lists domains you actually need.

---

## 5. Landing page (`/landing-page`)

Single self-contained `index.html` (Tailwind via CDN, no build step) —
ideal for GitHub Pages.

1. Push this repo to GitHub.
2. **Settings → Pages → Source**: `Deploy from a branch`, branch `main`,
   folder `/landing-page` (or `/` if you move `index.html` to the repo
   root — GitHub Pages can only serve from `/` or `/docs`, so if you want
   it served from `/landing-page` directly, instead point Pages at a
   dedicated branch, or use a simple redirect page at the repo root).
3. Update the "Add to Chrome" links once your extension is published to the
   Chrome Web Store.

---

## Environment variable reference

### `backend/.env`

```
PORT=4000
NODE_ENV=development
CORS_ORIGINS=chrome-extension://YOUR_EXTENSION_ID,https://devdave666.github.io
DATABASE_URL=postgres://postgres:password@localhost:5432/tolastcent
DATABASE_SSL=true
JWT_SECRET=replace_with_a_long_random_secret
JWT_EXPIRES_IN=30d
CJ_PUBLISHER_ID=1234567
CJ_TRACKING_DOMAIN=www.anrdoezrs.net
```

### `jobs/.env`

```
DATABASE_URL=postgres://postgres:password@localhost:5432/tolastcent
DATABASE_SSL=true
CJ_PERSONAL_ACCESS_TOKEN=replace_with_cj_pat
CJ_COMPANY_ID=1234567
CJ_GRAPHQL_ENDPOINT=https://commission-detail.api.cj.com/query
SYNC_LOOKBACK_HOURS=24
```

`.env` files are git-ignored — never commit real credentials. `.env.example`
files in `backend/` and `jobs/` document every variable above.

---

## Deployment checklist

- [ ] Postgres schema applied (`backend/schema.sql`)
- [ ] Backend deployed (Render / Railway / Fly.io / a VM) with all env vars set
- [ ] `CORS_ORIGINS` includes the published extension ID and landing page URL
- [ ] Landing page deployed on GitHub Pages, "Add to Chrome" link updated
- [ ] Extension published to the Chrome Web Store, `config.js` pointed at the
      production `API_BASE_URL`
- [ ] `cjSyncWorker.js` scheduled hourly (cron or GitHub Actions) with CJ
      credentials as secrets, not plaintext

## Security notes

- Passwords are hashed with `bcryptjs` (12 rounds); never store plaintext.
- `GET /api/v1/user/balance` requires a valid `Authorization: Bearer <JWT>`
  and always uses the *token's* user id, never a client-supplied one, to
  prevent one user reading another's balance.
- `GET /api/v1/redirect` is intentionally unauthenticated (it's opened as a
  plain browser navigation, which can't carry custom headers) — it only logs
  a click and forwards to CJ, it never exposes balance or account data.
- Keep `CJ_PERSONAL_ACCESS_TOKEN` and `JWT_SECRET` in your hosting
  provider's secret manager, never in source control.
