# CashFlow

Personal cash-flow tracking. Next.js 16 App Router, Prisma 7 on PostgreSQL,
Better Auth 1.7.2.

## Local development

```bash
docker compose up -d          # PostgreSQL on host port 5439 (5432 is taken on the original dev machine)
cp .env.example .env          # then fill in BETTER_AUTH_SECRET
npm install
npx prisma migrate dev        # apply migrations and generate the client
npm run dev                   # http://localhost:3000
```

With no `SMTP_HOST` set, password-reset emails are printed to the dev-server
console. Set `EMAIL_OUTBOX_FILE` to write them to a file instead.

## Testing

- `npm run test` — Vitest. Requires PostgreSQL to be running
  (`docker compose up -d`): before the first test file, the global setup creates
  and migrates a dedicated `cashflow_test` database. `TEST_DATABASE_URL` in
  `.env` chooses it, and the suite refuses to start when that address resolves
  to the same database as `DATABASE_URL` — tests must never write to the
  development database. The auth tests themselves need no network and no
  database rows: they run the real Better Auth instance against an in-memory
  adapter, built through `lib/auth/__testing__/auth-harness.ts`.
- `npm run test:e2e` — Playwright. Needs PostgreSQL running and
  `E2E_DATABASE_URL` set in `.env` (see `.env.example`): the browser tests
  register real users and write real financial rows through the UI, so they run
  against their own `cashflow_e2e` database, which the global setup creates and
  migrates on the first run. There is no default — the suite refuses to start,
  before it spawns a dev server, when the variable is missing, when it resolves
  to the same database as `DATABASE_URL`, or when the database name does not
  carry `e2e`/`test`. It always starts the dev server itself, with
  `DATABASE_URL` set to that e2e database and `EMAIL_OUTBOX_FILE` pointed at
  `e2e/.outbox/emails.jsonl`, and reads the reset link back out of that file.

  A server it did not start is never reused (`reuseExistingServer: false`),
  because a dev server you started by hand is on your own `DATABASE_URL` and has
  none of those variables — reusing it would write the suite's throwaway users
  into the development database and strand the reset test waiting for an email
  that went to the console. So **stop your dev server before running the
  suite**: with port 3000 already busy, Playwright fails immediately and says so.

Run `npm run format:check`, `npm run lint`, `npm run test` and `npm run build`
before every commit.

## Deployment requirements

Required environment variables. `lib/server/env.ts` validates the whole
contract once at server start: in production a missing or placeholder value
throws one aggregated error naming the offending variables (never their
values), and outside production the same findings are `console.warn`ed and the
app boots. `.env.example` is the grouped, annotated copy of this list.

- `BETTER_AUTH_URL` — the public origin. Without it Better Auth derives its base
  URL from the request, so a forged `Host` header can end up inside an emailed
  password-reset link.
- `BETTER_AUTH_SECRET` — a random 32-byte secret (`openssl rand -base64 32`).
  Boot is refused in production when it is missing, blank, shorter than 32
  characters, or still the `.env.example` placeholder, which is exported as one
  constant from `lib/server/env.ts` so the example and the guard cannot drift.
- `TRUSTED_PROXY_CIDRS` — comma-separated CIDRs/IPs of the reverse proxy or CDN
  that sets `x-forwarded-for`. Rate limiting keys on the client IP, resolved by
  walking the forwarded chain right to left and skipping these hops. Unset, a
  chain-appending proxy leaves Better Auth with no usable IP and every caller
  shares one bucket; a single-value header is trusted at face value and is
  forgeable.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` — there is
  no email fallback in production. `getEmailSender()` throws rather than falling
  back to the console or the file outbox. `EMAIL_FROM` is required in
  production, and `SMTP_PORT` must be a positive integer whenever `SMTP_HOST`
  is set; `SMTP_USER`/`SMTP_PASSWORD` may be empty for an anonymous relay.
- `DATABASE_URL` — also needed at build time. `next build` imports every route
  module to collect page data, and the Prisma client is constructed at module
  scope, so the build needs a reachable database. (The production-only part of the
  contract is skipped during the build, which Next marks with
  `NEXT_PHASE=phase-production-build`.)

Operational notes:

- The rate-limit store is an in-memory Map, per process. Before scaling
  horizontally, switch to a shared store (`rateLimit.storage` backed by Redis or
  a custom store) — otherwise each instance counts separately and the effective
  limit multiplies by the instance count.
- A failed reset-email delivery is swallowed by Better Auth: it logs
  `Failed to run background task:` and still answers 200 (deliberate — the
  endpoint gives the same response for every address so nothing leaks). There is
  no config switch for this in 1.7.2, so **alert on that log line** or reset
  emails can fail silently.
- `.npmrc` sets `legacy-peer-deps=true` repo-wide, because better-auth 1.7.2
  declares an optional peer on `vitest ^2||^3||^4` while this repo runs Vitest 5.
  It is a blanket setting, so review peer warnings by hand when upgrading
  dependencies.
- Set `TZ=UTC` in CI and production (it is in `.env.example`); period math is
  computed in the user's IANA zone from UTC timestamps, so a server on a local
  zone shifts every period boundary. User-facing dates keep coming from
  `User.timezone`; a non-UTC `TZ` is reported as a startup warning, not a
  failure.
- `ALLOW_DEMO_SEED_IN_PRODUCTION` appears in `.env.example` but no code reads it
  yet; it is reserved for the demo seed/clear scripts' production guard.
