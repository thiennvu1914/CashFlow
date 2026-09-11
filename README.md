# CashFlow

Personal cash-flow tracking. Next.js 16 App Router, Prisma 7 on PostgreSQL,
Better Auth 1.7.2.

## Overview

Tracks accounts, transactions, transfers, budgets, savings goals, debts,
loans and reminders for one user at a time — no shared workspaces. Vietnamese
default locale with English available, light/dark theme, and full Excel
export. Every financial invariant (no stored balance, `Decimal`-only money,
real FX snapshots) is enforced in the service layer; see
[`docs/architecture.md`](docs/architecture.md) for the invariants and
boundaries an owner needs to know before changing the code.

## Stack

Next.js 16 (App Router, React 19), Prisma 7 (WASM client + `@prisma/adapter-pg`),
PostgreSQL, Better Auth, `next-intl`, Tailwind v4, shadcn (base-nova preset),
Vitest, Playwright.

## Prerequisites

- Node version from [`.nvmrc`](.nvmrc) (Prisma 7's contract:
  `^20.19.0 || ^22.12.0 || >=24.0.0`).
- Docker, for local PostgreSQL (compose maps it to host port **5439** — 5432
  is taken on the original dev machine).

## Install and run

```bash
docker compose up -d          # PostgreSQL on host port 5439
cp .env.example .env          # fill in the groups below; generate BETTER_AUTH_SECRET
npm ci                        # postinstall runs `prisma generate` — no separate step needed
npx prisma migrate dev        # apply migrations (never `db push`)
npm run dev                   # http://localhost:3000
```

With no `SMTP_HOST` set, password-reset emails print to the dev-server
console; set `EMAIL_OUTBOX_FILE` to write them to a file instead.

### Environment setup

`.env.example` is grouped — Application, Database, Authentication, Email,
FX, Testing, Demo/maintenance — with safe placeholders only. `lib/server/env.ts`
validates the whole contract before the first request touches the database,
auth or email; production refuses to boot on a bad value, development just
warns. Full variable-by-variable reference:
[`docs/operations.md`](docs/operations.md#environment-contract).

## Testing

- `npm run test` — Vitest. Requires PostgreSQL running
  (`docker compose up -d`): the global setup creates and migrates a
  dedicated `cashflow_test` database on the first run. `TEST_DATABASE_URL` in
  `.env` chooses it, and the suite refuses to start if that resolves to the
  same database as `DATABASE_URL`.
- `npm run test:e2e` — Playwright. Needs PostgreSQL running and
  `E2E_DATABASE_URL` set in `.env` — there is no default. The browser tests
  register real users and write real financial rows through the UI, so they
  run against their own `cashflow_e2e` database (created/migrated
  automatically) and the suite refuses to start if that variable is missing,
  equals `DATABASE_URL`, or the name doesn't carry `e2e`/`test`. **The suite
  always starts its own dev server** (`reuseExistingServer: false`) —
  **stop any dev server you started by hand first**, or the run fails
  immediately with a port-in-use error.

Run `npm run format:check`, `npm run lint`, `npm run test` and
`npm run build` before every commit.

### Production build

`next.config.ts` sets `output: 'standalone'`, so `npm run build` traces the
build into `.next/standalone` rather than the full `.next` tree plain
`next start` expects. That trace does not include `.next/static` or
`public` — Next leaves it to whoever serves the bundle to place those next
to `server.js`. `npm run start` runs `scripts/start-standalone.mjs`, which
copies `.next/static` and `public` into the standalone bundle and then runs
`node .next/standalone/server.js` — the same entrypoint the Docker `runner`
stage's `CMD` uses below (the Dockerfile does the equivalent two copies with
`COPY` instructions instead).

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and push to `main`:
lint, format, type-check, `prisma validate`, Vitest, Playwright and the
production build against an isolated throwaway Postgres (three separate
databases, so no CI step can reach a real one), plus a production-smoke job
that builds the Docker image, migrates a scratch database and asserts
`/api/health` and the security headers on a running container. No repository
secret is used. GitHub Actions cannot run locally, so the first real run
happens on push. Full job breakdown: [`docs/operations.md`](docs/operations.md#continuous-integration).

## Docker quick start

Vendor-neutral, four build stages (`deps` → `builder` → `migrator` →
`runner`); migrations are a separate release step, never a container
entrypoint.

```bash
docker build -t cashflow:latest .                      # runner (default target)
docker build --target migrator -t cashflow:migrate .    # migration image

docker run --rm --env-file .env.production cashflow:migrate   # runs `npm run db:deploy`
docker run -d -p 3000:3000 --env-file .env.production \
  --stop-timeout 30 --name cashflow cashflow:latest

curl -i http://localhost:3000/api/health   # 200 {"status":"ok"}; 503 when the database is gone
```

Full stage table, image sizes, healthcheck details, and platform examples
(Railway/Render/Fly.io/plain Docker host) live in
[`docs/operations.md`](docs/operations.md#docker-deployment).

## Further reading

- [`docs/architecture.md`](docs/architecture.md) — tenant isolation, balance
  derivation, transaction/transfer/FX semantics, debts/loans/reminders,
  locale/theme resolution, the server/client boundary.
- [`docs/operations.md`](docs/operations.md) — the full environment
  contract, migration procedure, health endpoint, Docker deployment,
  logging, email, FX networking, backup/restore, CSP future work, CI, demo
  scripts and deployment notes.
- `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` — the original
  product specification.

## Operational notes

- `.npmrc` sets `legacy-peer-deps=true` repo-wide, because better-auth 1.7.2
  declares an optional peer on `vitest ^2||^3||^4` while this repo runs
  Vitest 5. Review peer warnings by hand when upgrading dependencies.
- Set `TZ=UTC` in CI and production; period math is computed in the user's
  IANA zone from UTC timestamps, so a server on a local zone shifts every
  period boundary. User-facing dates keep coming from `User.timezone`.
