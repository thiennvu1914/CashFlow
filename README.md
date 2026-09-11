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

### Production build

`next.config.ts` sets `output: 'standalone'`, so `npm run build` traces the
build into `.next/standalone` rather than the full `.next` directory plain
`next start` expects — running `next start` against a standalone build only
warns and serves nothing useful. `npm run start` therefore runs
`node .next/standalone/server.js` directly, the same entrypoint the Docker
`runner` stage's `CMD` uses (below); it is unaffected by this since it never
called `npm run start` in the first place.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on every push to
`main`, one run per ref (a new push cancels the one in flight). The `checks`
job installs from the lockfile on the Node version in `.nvmrc`, then runs lint,
`format:check`, `tsc --noEmit`, `prisma validate`, Vitest, Playwright
(Chromium only, workers 1, retries 0, traces uploaded as an artifact when it
fails) and the production build against a throwaway `postgres:16` service — the
same three-database split as local development, with `cashflow_ci`,
`cashflow_ci_test` and `cashflow_ci_e2e` on one disposable server, so no CI
step can reach a real database. `npm audit` runs there too, informationally,
and never fails the build. The `production-smoke` job builds the runner and
migrator images from the `Dockerfile`, migrates a scratch database with the
migrator, starts the container with a production-shaped environment and a
secret generated in the job, and asserts `/api/health` returns 200 and that a
real page ships its security headers. Nothing is deployed and no repository
secret is used. GitHub Actions cannot be executed locally, so the first real
run of the pipeline happens when this file is pushed.

## Docker quick start

The image is vendor-neutral: Node, PostgreSQL, nothing platform-specific. It is
built in four stages — `deps` (full `npm ci`), `builder` (`next build` with
`output: 'standalone'`), `migrator` (the Prisma CLI and the migrations, nothing
else) and `runner` (the standalone server, non-root, no CLI). Migrations are a
separate release step, never a container entrypoint: an entrypoint migration
races every replica, and the runner deliberately carries no Prisma CLI to run
one.

```bash
docker build -t cashflow:latest .                     # runner (the default target)
docker build --target migrator -t cashflow:migrate .  # migration image

docker run --rm --env-file .env.production cashflow:migrate   # runs `npm run db:deploy`
docker run -d -p 3000:3000 --env-file .env.production \
  --stop-timeout 30 --name cashflow cashflow:latest

curl -i http://localhost:3000/api/health   # 200 {"status":"ok"}; 503 when the database is gone
```

The env file supplies every variable in
[Deployment requirements](#deployment-requirements) plus `TZ=UTC`. No secret is
baked into any layer: the build sets a dummy, never-connected `DATABASE_URL`
only because `next build` constructs the Prisma client while collecting page
data, and `.dockerignore` keeps a local `.env` out of the build context. The
image ships a `HEALTHCHECK` polling `/api/health` and needs no writable
directory, so a read-only root filesystem works. Platform examples, backup and
restore live in `docs/operations.md`.

## Deployment requirements

Required environment variables. `lib/server/env.ts` validates the whole
contract before the first request that touches the database, auth or email: in
production a missing or placeholder value throws one aggregated error naming
the offending variables (never their values), and outside production the same
findings are `console.warn`ed and the app boots. Advisory findings — a
test-only variable, a stray `EMAIL_OUTBOX_FILE`, a non-UTC `TZ` — are logged by
name in production too, and never fail a boot. `.env.example` is the grouped,
annotated copy of this list.

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
  back to the console or the file outbox, so `SMTP_HOST`, `SMTP_PORT` and
  `EMAIL_FROM` are required at startup, not at the first send. `SMTP_PORT` must
  be an integer between 1 and 65535 whenever `SMTP_HOST` is set. Authentication
  is optional — leave `SMTP_USER`/`SMTP_PASSWORD` empty for an anonymous relay,
  or set both; `SMTP_USER` without `SMTP_PASSWORD` is refused.
- `DATABASE_URL` — also needed at build time, but only as a _value_. `next build`
  imports every route module to collect page data and the Prisma client is
  constructed at module scope, so the variable must be set and syntactically
  valid; the build never opens a connection (the Docker build proves it — the
  builder stage sets a dummy URL pointing at nothing). (The production-only part
  of the contract is skipped during the build, which Next marks with
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
- Environment values are trimmed before they are validated and used, so a
  secret pasted with surrounding whitespace signs with its trimmed form.
  Better Auth's `AUTH_SECRET` fallback is no longer enough in production
  either: `BETTER_AUTH_SECRET` itself must be set, or the process refuses to
  start.
- Set `TZ=UTC` in CI and production (it is in `.env.example`); period math is
  computed in the user's IANA zone from UTC timestamps, so a server on a local
  zone shifts every period boundary. User-facing dates keep coming from
  `User.timezone`; a non-UTC `TZ` is reported as a startup warning, not a
  failure.
- `ALLOW_DEMO_SEED_IN_PRODUCTION` appears in `.env.example` but no code reads it
  yet; it is reserved for the demo seed/clear scripts' production guard.
