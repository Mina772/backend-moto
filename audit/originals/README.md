# moto-erp-backend

Express 5 + Mongoose 8 backend. All routes are mounted under `/api`; Socket.IO on the same port.
Self-contained project: `@moto/shared` lives in `packages/shared` and is linked through this project's own npm workspace.

## Run

```bash
npm install
cp .env.example .env     # edit secrets
npm run db               # local single-node replica set (rs0) — needed before dev
npm run dev              # tsx watch, http://localhost:4000
npm run db:reset         # delete all business data; add "--" --confirm to actually do it
npm run init-admin       # set ADMIN_PASSWORD and real BRANCH_NAME_AR / BRANCH_CITY_AR / BRANCH_ADDRESS_AR first
npm test                 # vitest + supertest + mongodb-memory-server (replica set)
npm run build            # esbuild bundle → dist/server.js
npm start
```

Financial writes and sync receipts commit in the same MongoDB transaction. Production startup refuses
standalone MongoDB; use a replica set. Concurrent requests sharing an `Idempotency-Key` replay the committed
response. A crashed, uncommitted HTTP reservation can be retried with the same key after two minutes.

Startup never inserts business records. Company identity and contact/tax/branding fields start blank.
Test fixtures are confined to `src/test/fixtures`, require the isolated `moto-test` database, and never
enter deployment bundles. There is no demo seed command.

Accounting keeps gross invoice totals separate from returns. `returns` is the amount refunded in the period;
`netSales`, tax, cost of goods sold and profit include reversals on the refund date. Sales reports retain their
gross invoice figures.

When upgrading, a legacy sync row left at `applying` for a return, payment, movement or session close has an
unknown commit state. It returns `SYNC_RECOVERY_REQUIRED` and must be reconciled against its business record;
the POS blocks retrying it under a fresh ID. These historical records are not automatically rewritten.

MongoDB **must** run as a replica set (transactions). `npm run db` starts a local one; `docker compose up -d mongo mongo-init` at the repo root does the same in Docker.

## Environment

| Var | Default | Notes |
|---|---|---|
| `PORT` | `4000` | |
| `MONGODB_URI` | `mongodb://localhost:27017/moto?replicaSet=rs0&directConnection=true` | |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | dev-only defaults | ≥ 16 chars; in `production` the defaults are refused and ≥ 32 chars is enforced |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL_DAYS` | `15m` / `30` | refresh is an httpOnly cookie for web, body token for `X-Client: pos-desktop` |
| `CORS_ORIGINS` | `http://localhost:5173` | comma-separated; requests without `Origin` (Electron) are allowed |
| `PUBLIC_URL` | `http://localhost:5173` | used in invoice QR verify links |
| `UPLOAD_DIR` | `uploads` | company logo |
| `WHATSAPP_MODE` | `web` | `web` stores `prepared` and returns a `wa.me` deep link the operator sends manually; `cloud` uses Meta Cloud API with `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID`; delivery receipts are never fabricated |
| `BCRYPT_COST`, `LOG_LEVEL`, `COOKIE_SECURE` | `12`, `info`, `false` | |
| `COOKIE_SAMESITE` | `lax` | `none` (implies `Secure`) when the web app is served from a different origin than the API |
| `TRUST_PROXY` | `1` | reverse-proxy hops to trust for the client IP; rate limiting keys on it |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `600` | global limiter (production only; `/api/health*` is exempt) |
| `JSON_BODY_LIMIT`, `MONGO_POOL_SIZE` | `2mb`, `20` | |
| `SHUTDOWN_DRAIN_MS` / `SHUTDOWN_TIMEOUT_MS` | `5000` / `15000` | readiness fails for the drain window on SIGTERM, then the process force-exits after the timeout |
| `APP_VERSION` | `''` | reported by `/api/health`; the Docker image sets it from the build arg |

In `production` the process refuses to start when the JWT secrets are defaults, shorter than 32 chars or
identical, when `MONGODB_URI` / `CORS_ORIGINS` / `PUBLIC_URL` are left at their development values, or when a
non-localhost origin uses plain `http`. All problems are listed in one message.

## Operations

| Endpoint | Purpose |
|---|---|
| `GET /api/health`, `/api/health/live` | liveness — no DB access |
| `GET /api/health/ready` | readiness — pings MongoDB, 503 while draining |

Logs are JSON on stdout with authorization headers, cookies, passwords and tokens redacted. Every request
gets an `X-Request-Id` (echoed to the client, logged, and included in 500 bodies).

`node dist/db/init-admin.js` (`npm run init-admin` in dev) creates the first branch, main warehouse, register
and administrator from `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `BRANCH_*` env vars. It never inserts example records and
refuses to overwrite an existing user.

`ADMIN_PASSWORD` (at least 10 characters), `BRANCH_NAME_AR`, `BRANCH_CITY_AR` and `BRANCH_ADDRESS_AR` are
required. English branch fields are optional and remain empty when omitted. Configure real company
identity, tax status and receipt branding in Settings before issuing invoices.

## Modules (`src/modules`)

`auth` · `products` (+ `catalog`: categories/brands/models, barcode generation) · `sales` (+ returns, public verify `/api/public/invoices/:invoiceNumber/verify`) · `customers` (+ `debts`) · `inventory` (+ `warehouses`, `transfers`, adjustments, stock counts) · `purchases` (+ `suppliers`) · `org` (branches/users/roles) · `cash` (registers/sessions + `expenses`) · `reports` (sales, stock, profit, **dead stock**, `audit`, `search`) · `alerts` (engine + notifications) · `settings` (+ `print-profiles`, `labels`, logo upload) · `quick` (POS quick grid) · `whatsapp` · `sync` (+ `terminals`).

Conventions:
- `validate(Schema)` for bodies, `q(req, Schema)` for queries (Zod from `@moto/shared`).
- `authorize(...perms)` + `branchScope` on every non-public route (alerts/notifications are filtered per role instead).
- Mutations that may be retried accept `Idempotency-Key`; replays return the stored response with `Idempotent-Replay: true`.
- `applyMovement()` in `inventory/stock.ts` is the only writer of stock quantities (atomic `$inc` with a non-negative guard).
- `createSale` enforces tier prices, `prices.wholesale`, `discounts.*` and `pos.maxDiscountPercent` server-side; `unitCost` always comes from the product.
- Cost fields (`purchasePrice`, `lastPurchaseCost`) are zeroed in responses unless the caller has `prices.view_cost`.

## Sync protocol (POS terminals)

| Endpoint | Purpose |
|---|---|
| `POST /api/terminals` | pair a terminal (admin creds) → `{ id, code: T001, branchId, registerId }` |
| `GET /api/sync/bootstrap?branchId=` | full catalog snapshot for the branch |
| `GET /api/sync/pull?branchId=&since=` | deltas (products, stock, customers, special prices, quick grid, print profiles, settings, tombstones) |
| `POST /api/sync/push` | `{ terminalId, ops: [{ opId, type, clientCreatedAt, payload }] }` → per-op `applied` / `duplicate` / `rejected { code, message }` |
| `GET /api/health` | heartbeat (also used by the terminal's online/offline detection) |

Op types (`SyncOpTypeSchema`): `sale`, `sale_return`, `customer_payment`, `register_open`, `register_close`, `cash_movement`, `customer_create`. The `SyncOp` receipt and domain writes commit in one transaction. A concurrent or post-crash replay receives `duplicate` with the original `serverId`. Reusing an ID for a changed operation is rejected. Final rejections are remembered; retries use a fresh ID, except legacy `SYNC_RECOVERY_REQUIRED` operations, which require reconciliation. `TRANSIENT` retries keep the same ID.

## Jobs (`src/jobs`)

node-cron: scheduled alerts (low/out-of-stock scan, overdue customer debts) and the daily dead-stock snapshot. Event-driven alerts (large returns, count/register variance, sync rejections, stock after sales/receipts/transfers) fire inline. Idempotency keys and `SyncOp` rows expire via Mongo TTL indexes, not a job.

## Docker

`erp-backend/Dockerfile` (multi-stage, non-root) — the build context is this folder. Root `docker-compose.yml` runs `mongo` + `mongo-init` (rs.initiate) + `api` + `web`.
