# Operations

Everything an owner needs to configure, deploy, monitor and recover CashFlow
in production. Vendor-neutral throughout — Railway/Render/Fly.io/a plain
Docker host appear only as examples, never as a dependency.

## Environment contract

`lib/server/env.ts` validates this contract before the first request that
touches the database, auth or email. In production, a missing, blank or
placeholder value throws one aggregated error naming the offending
*variables* (never their values) and the process refuses to boot; outside
production the same findings are logged with `console.warn` and the app
still boots. Advisory findings (a stray test-only variable, a non-UTC `TZ`)
are checked only in a real production runtime (`NODE_ENV=production` and not
the `next build` phase) and never fire in development or test; they are
logged by name, never fail a boot, and never carry a value. `.env.example`
is the grouped, annotated, safe-placeholder
copy of this table — never paste a real secret into it or into this file.

Every value is trimmed before validation and use (`trimmedOrUndefined` in
`lib/server/env.ts`), so a secret pasted with surrounding whitespace — a
stray newline or space from a copy-paste into a platform's secret manager —
signs with its trimmed form, not the padded one.

Better Auth's own `AUTH_SECRET` fallback is not sufficient in production:
`BETTER_AUTH_SECRET` itself must be set, at least 32 characters, and not the
placeholder shipped in `.env.example`, or the process refuses to start.

| Variable | Required in | Purpose | Example placeholder |
| --- | --- | --- | --- |
| `TZ` | production, CI (optional elsewhere, warned if not `UTC`) | Server/container clock; period math computed from UTC in the user's IANA zone | `UTC` |
| `DATABASE_URL` | always, including build | Postgres connection string; the Prisma client is constructed at module scope | `postgresql://user:pass@localhost:5439/cashflow` |
| `BETTER_AUTH_SECRET` | production | Signs session cookies and reset tokens; rejected if missing/blank/short/the shipped placeholder | (generate with `openssl rand -base64 32`) |
| `BETTER_AUTH_URL` | production | Public origin; without it a forged `Host` header can end up in a reset link | `https://cashflow.example.com` |
| `TRUSTED_PROXY_CIDRS` | production | CIDRs/IPs of the reverse proxy/CDN in front of the app, for rate-limit IP resolution | `10.0.0.0/8` |
| `SMTP_HOST` | production | Outbound mail relay host; there is no production fallback | `smtp.example.com` |
| `SMTP_PORT` | production (with `SMTP_HOST`) | Integer 1–65535 | `587` |
| `SMTP_USER` / `SMTP_PASSWORD` | optional (both or neither) | SMTP auth; anonymous relay is legal | (empty for anonymous) |
| `EMAIL_FROM` | production | From address for reset emails | `CashFlow <no-reply@example.com>` |
| `EMAIL_OUTBOX_FILE` | dev/e2e only | Writes outgoing mail to a JSON-lines file instead of sending it | `e2e/.outbox/emails.jsonl` |
| `TEST_DATABASE_URL` | Vitest only | Dedicated database Vitest creates/migrates itself | `postgresql://…/cashflow_test` |
| `E2E_DATABASE_URL` | Playwright only, no default | Dedicated database the e2e suite creates/migrates itself; name must carry `e2e`/`test` and differ from `DATABASE_URL` | `postgresql://…/cashflow_e2e` |
| `CASHFLOW_E2E_DISABLE_RATE_LIMIT` | test/dev only, set by `playwright.config.ts` | Disables auth rate limiting for the spawned dev server; never set in a deployment | `1` |
| `ALLOW_DEMO_SEED_IN_PRODUCTION` | maintenance | Consumed only by `demo:seed`/`demo:clear`'s production guard | `false` |

`NODE_ENV` is deliberately not hand-set — Next manages it (`next dev` →
development, `next build`/`next start`/the standalone `server.js` →
production). Setting it to `production` on a machine with no production
configuration turns every warning above into a hard boot failure. Note the
one asymmetry: **the env module treats an unset or unrecognised `NODE_ENV`
as non-production** (so a bare `node server.js` or a fresh checkout still
boots for validation purposes), while **Next's own runtime treats an unset
`NODE_ENV` as production** for build/serve behaviour. They can disagree in
an unusual invocation; always set `NODE_ENV=production` explicitly when
actually deploying.

FX configuration has no variables: rates come from `open.er-api.com`, which
needs no API key; staleness window, rounding and the historical-snapshot
policy are code in `lib/currency/`, not configuration. That endpoint must be
reachable from the running server at request time — it is not a build-time
dependency.

## Migration procedure

Never `prisma db push` in any environment — schema changes are committed
migrations, applied with `prisma migrate deploy` (`npm run db:deploy`), run
by the Docker `migrator` stage described below, not by the running app.

1. **Backup** the target database (`pg_dump -Fc`, below) before migrating.
2. Run `npm run db:deploy` — in Docker, `docker run --rm --env-file <env>
   cashflow:migrate` — against the target `DATABASE_URL`. This only applies
   migrations already committed to `prisma/migrations/`; it does not
   generate new ones.
3. **Health check**: confirm `/api/health` returns `200` against the
   deployment that will serve traffic on the new schema, and (for a schema
   change of any consequence) run `prisma migrate status` to confirm no
   migration is pending or failed.

## Health endpoint

`GET /api/health` (`app/api/health/route.ts`) is the only readiness probe.
It runs `SELECT 1` through the shared Prisma client with a 2-second bound,
and answers:

- `200 {"status":"ok"}` — database reachable within the bound.
- `503 {"status":"unavailable"}` — the query rejected, timed out, or the
  Prisma client itself failed to construct.

It carries `Cache-Control: no-store` plus the standard security headers, and
leaks nothing else — no version, host, database name, duration or driver
text. It is **unauthenticated by design** (a platform probe cannot present
credentials), which is exactly why it must be treated carefully:

- Keep the platform's probe interval at **30 seconds or slower** — this
  endpoint does a real database round trip, and a tight interval turns a
  health check into a self-inflicted load generator.
- If the deployment is directly internet-facing without a reverse
  proxy/CDN in front of it, restrict `/api/health` to the platform's own
  network where the platform supports it (a firewall rule or an internal
  load-balancer path), since Better Auth's own rate limiting covers only
  `/api/auth/*`.

## Docker deployment

Four stages, one image, vendor-neutral (Node + PostgreSQL, nothing
platform-specific):

| Stage | Contains | Runs |
| --- | --- | --- |
| `deps` | full `npm ci` (dev dependencies included — `prisma` is a devDependency and `postinstall` runs `prisma generate`) | install only |
| `builder` | `deps`' `node_modules` + the build context | `next build` with `output: 'standalone'` |
| `migrator` | full `node_modules`, `prisma/`, `prisma7.config.ts`, `package.json`; no build output | `CMD npm run db:deploy` — a release command, not a container entrypoint |
| `runner` | `.next/standalone`, `.next/static`, `public`; no Prisma CLI, no `prisma/` | `CMD ["node","server.js"]`, non-root `node` user |

```bash
docker build -t cashflow:latest .                      # runner (default target)
docker build --target migrator -t cashflow:migrate .    # migration image

docker run --rm --env-file .env.production cashflow:migrate   # runs `npm run db:deploy`
docker run -d -p 3000:3000 --env-file .env.production \
  --stop-timeout 30 --name cashflow cashflow:latest

curl -i http://localhost:3000/api/health   # 200 {"status":"ok"}; 503 when the database is gone
```

Notes:

- **Migrations run only in the `migrator` stage**, as an explicit,
  operator-triggered step. The runner carries no Prisma CLI at all, so it
  cannot migrate even by accident, and an entrypoint migration would race
  every replica on a scale-out deploy.
- **Runtime env**: the runner needs the full production contract above
  (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
  `TRUSTED_PROXY_CIDRS`, SMTP, `EMAIL_FROM`) plus `TZ=UTC`; it is supplied at
  `docker run` time via `--env-file`, never baked into a layer. The builder
  sets only a syntactically valid, never-connected dummy `DATABASE_URL`
  (`next build` constructs the Prisma client while collecting page data, but
  the build never opens a connection); every real secret is runtime-only.
- **Healthcheck**: `HEALTHCHECK --interval=30s --timeout=5s
  --start-period=20s --retries=3` polling `/api/health` with a `node -e`
  fetch (no `curl` in the slim base image); a 503 counts as unhealthy, and
  three retries absorb transient latency without cycling the container.
- **Stop grace**: pass `--stop-timeout 30` (or the platform's equivalent,
  e.g. Compose's `stop_grace_period: 30s`) — Docker's own default is 10
  seconds, which can cut off an in-flight request. This is a platform/run
  setting, not something the image can enforce on its own.
- **Google Fonts egress at build time**: `next build` fetches Manrope from
  `fonts.googleapis.com`/`fonts.gstatic.com` via `next/font/google`; the
  `builder` stage therefore needs outbound network access during the image
  build (not at runtime — the fonts are embedded in the built output).  A
  network-restricted build environment must allow this egress or the build
  will hang rather than fail fast.
- **Image sizes** (observed): the `runner` image is ≈ 405 MB
  (`node:24-bookworm-slim` base plus the standalone bundle); the `migrator`
  image is ≈ 1.8 GB because it carries the full dev install (the Prisma CLI
  and `dotenv` are devDependencies) — expected, since it is a short-lived
  release-command image, not something that stays resident.

## Logging and redaction

`lib/server/log.ts` exposes `log.info/warn/error(event, fields?)`. In
development/test it prints one readable line
(`<ISO time> <LEVEL> <event> key=value …`); in production it prints one JSON
object per line with `level`, `event`, `time` and the fields. A redaction
guard masks any key matching `password|token|secret|authorization|cookie|
set-cookie` at any depth, replaces a string value that parses as a URL
carrying credentials, and masks embedded credentials inside a longer string
without destroying the rest of the message. Errors are logged as
`{ name, message, digest? }` only — **no stack trace in any environment**.

`instrumentation.ts`'s `onRequestError` hook logs every unhandled request
error as `event: "request.error"` with the method, the pathname only (no
query string), router/route metadata and the error's `digest` — the same
`digest` value the client-facing error boundaries (`app/(app)/error.tsx`,
`app/global-error.tsx`) show the user as a short reference code. **To
investigate a user's reported reference code**: grep the server log for that
`digest` value; the matching `request.error` line carries the method, route
and error name/message at the time it happened.

## Email requirements

- **Production**: SMTP is required at boot — `SMTP_HOST`, `SMTP_PORT` and
  `EMAIL_FROM` must be set, because password reset is the only email this
  app sends and there is no safe fallback for it. `SMTP_USER`/
  `SMTP_PASSWORD` are optional together (anonymous relay is legal) but
  refused if only one is set.
- **Dev/e2e**: with no `SMTP_HOST`, password-reset emails print to the
  dev-server console; set `EMAIL_OUTBOX_FILE` to append them as JSON lines
  to a file instead (Playwright uses this so the reset-password test can
  read the real link back out). This path is structurally unreachable in
  production — `getEmailSender()` throws before it can select the outbox.
- A failed reset-email delivery is swallowed by Better Auth itself: it logs
  `Failed to run background task:` and still answers `200` (deliberate — the
  same response for every address, so nothing about account existence
  leaks). There is no 1.7.2 config switch for this, so **alert on that log
  line** or a broken SMTP relay fails silently.

## FX networking

Exchange rates are fetched from `open.er-api.com` at request/cache-refresh
time — no API key, no configuration variable. This is a runtime network
dependency (unlike the build-time Google Fonts fetch above): if the server's
egress cannot reach it, live-rate lookups fall back per the documented FX
policy in `lib/currency/`, and a warning is logged (`fx.live_rate_fallback`);
historical transaction data is never affected, since `historicalAmountIn()`
only ever uses the rate already snapshotted on the row.

## Backup, restore and recovery verification

**Backup** (schema + data, portable, restorable into a differently-versioned
Postgres via `pg_restore`):

```bash
pg_dump -Fc --dbname="$DATABASE_URL" -f cashflow-$(date +%Y%m%d).dump
```

**Restore**, onto a fresh database — never over a live one in place:

```bash
createdb cashflow_restored
pg_restore --dbname=cashflow_restored --no-owner --no-privileges cashflow-20260101.dump
DATABASE_URL="postgresql://…/cashflow_restored" npx prisma migrate status   # confirm schema is current
curl -i http://<restored-app-host>/api/health                              # confirm 200
```

**Recovery verification** — before declaring a restore good, check
representative counts against what the backup should contain (adjust table
names/filters as needed), e.g.:

```sql
SELECT count(*) FROM "user";
SELECT count(*) FROM "transaction";
SELECT count(*) FROM "financial_accounts";
SELECT max("createdAt") FROM "transaction";
```

Compare against the source database's counts at backup time (or a known
expected order of magnitude) — an empty or drastically smaller table is the
signal a restore silently failed partway through.

## Security headers and CSP future work

Every response carries `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
`Content-Security-Policy: frame-ancestors 'none'`, and a `Permissions-Policy`
deny list (camera, microphone, geolocation, payment, usb, browsing-topics);
`Strict-Transport-Security` is added only when `NODE_ENV === 'production'`
(TLS terminates at the platform proxy, never at the Node process itself);
`X-Powered-By` is removed. **This is decided at build time, not runtime.**
`next.config.ts`'s `headers()` calls `securityHeadersFor(process.env.NODE_ENV)`
once, while `next build` collects the routes manifest, and the result is
baked into `.next/server/routes-manifest.json`; the running server only
replays it. So HSTS depends on the *builder's* `NODE_ENV` (the Dockerfile's
builder stage deliberately leaves it unset, and Next's CLI defaults it to
`production` for `next build`), not the runtime's — starting a
development-mode build with `NODE_ENV=production` does not add the header.
To verify a given image actually ships it, run the container and inspect the
live response: `curl -sI https://<host>/ | grep -i strict-transport-security`.

**No nonce CSP and no `script-src` policy ship today.** This was evaluated
directly: a static `script-src 'self' 'unsafe-inline'` policy was tried as
`Content-Security-Policy-Report-Only` against `npm run dev` and produced
violations on every page — but every single one was Next's **development
server** itself using `eval` for React Refresh, not application code. Zero
violations is the adoption bar, and that bar cannot be honestly cleared
without checking against a **production build** (`next build && next
start`), which was out of scope for the task that made this decision.
**Future work**: re-run the same `Content-Security-Policy-Report-Only` check
against a production build; if it comes back clean, add the report-only
header first, watch it in production, then promote to enforcing. A true
`script-src` CSP without `unsafe-inline` needs a nonce pipeline, which is a
larger change deliberately deferred past Phase 8.

## Auth rate limiting

Better Auth's rate limiter (`lib/auth/create-auth.ts`) is explicitly enabled
in every environment and stores its counters in an in-memory `Map` local to
the process — Better Auth's default store, left unconfigured. That store is
**per process, not shared**: each replica keeps its own counts, so the
effective limit multiplies by the number of running instances (five
replicas each enforcing 5 requests/60s on `/sign-in/email` is 25
requests/60s in aggregate, not 5). Before running more than one replica,
either budget for that multiplication or front the deployment with a
proxy-level rate limit; do not reach for a shared store such as Redis to
close the gap — that is exactly the enterprise infrastructure this project
deliberately does not add.

## Rate-limit e2e switch

`CASHFLOW_E2E_DISABLE_RATE_LIMIT=1` disables Better Auth's rate limiting,
**but only when `NODE_ENV` is not production** (an unset or unrecognised
`NODE_ENV` counts as production for this check, i.e. it fails closed). It is
set by `playwright.config.ts` for the dev server it spawns and must never
appear in a committed file other than as a comment, nor in any deployed
environment. It is dev/test only, by design — there is no way to turn it on
in a real deployment.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to
`main` (one run per ref; a new push cancels the one in flight). The `checks`
job installs from the lockfile on the Node version in `.nvmrc`, then runs
lint, `format:check`, `tsc --noEmit`, `prisma validate`, Vitest, Playwright
(Chromium only, workers 1, retries 0, traces uploaded as an artifact on
failure) and the production build, all against a throwaway `postgres:16`
service split into three isolated databases (`cashflow_ci`,
`cashflow_ci_test`, `cashflow_ci_e2e`) so no CI step can reach a real
database; `npm audit` runs there too, informationally, and never fails the
build. The `production-smoke` job builds the `runner` and `migrator` images
from the `Dockerfile`, migrates a scratch database with the migrator, starts
the container with a production-shaped environment and a secret generated
in-job, and asserts `/api/health` returns 200 and that a real page ships its
security headers. Nothing is deployed, and no repository secret is used
anywhere in the workflow.

GitHub Actions cannot be executed locally, so **the first real run happens
when this workflow is pushed** — everything above was validated statically
(YAML/schema validation, `bash -n` on every `run:` block), not by an actual
CI execution. Read failures from the Actions run page: the `checks` job's
uploaded `playwright-report`/`e2e/.results` artifacts (present only on
failure) contain traces and screenshots; step-level logs show which command
failed and its output directly.

## Demo scripts

`npm run demo:seed` / `npm run demo:clear` (`scripts/seed-demo.ts`,
`scripts/clear-demo.ts`) create and remove a complete fixture (accounts,
transactions, transfers, budgets, goals, a debt, a loan, reminders) for one
fixed demo account, `demo@cashflow.local`, entirely through the application's
own services — never a raw insert. Three fail-closed guards, all before any
write:

1. **Production guard**: refuses when `NODE_ENV === 'production'` unless
   `ALLOW_DEMO_SEED_IN_PRODUCTION` is the exact string `"true"` (not `1`,
   not `yes`) — an explicit, discouraged override, never the default.
2. **Database guard**: refuses when `DATABASE_URL` names a database the
   test policy would treat as disposable (carries `test`/`e2e` as a word,
   or matches `TEST_DATABASE_URL`/`E2E_DATABASE_URL`) — the scripts are for
   a real application database, not a test database, and cannot be pointed
   at one.
3. **Identity guard**: immediately before deleting anything, re-reads the
   target user inside the delete transaction and aborts unless it carries
   both the demo email and `isDemo === true` — a real person who happens to
   register the demo email is never touched.

`demo:clear` deletes only rows owned by that one user id, in FK-safe order,
inside a single transaction; it never touches another user's rows and never
deletes the demo user row itself (so `demo:seed` can be re-run afterward).
Both commands print counts, never a connection string or secret; the demo
password is deliberately printed, since it is public in this repository and
can only ever belong to an account on a non-production database. If the
production override above is ever actually used, change the demo account's
password immediately after seeding, or remove the account by hand — the
shipped password (`DEMO_PASSWORD` in `lib/server/demo/constants.ts`) is
public and `clearDemoUser` keeps the user row rather than deleting it.

## Optional: listing historical dev-database test users

Phase 7's browser test suite, before the Phase 8 database guard existed,
registered real throwaway users directly into the shared development
database — hundreds of rows named `e2e-*@example.com`. Phase 8 does not
delete them (an owner decision: cleaning up the 972 historical dev-DB test
users is explicitly out of scope, and no code in this repository does it).
The following is a **read-only, local-only** count/listing an owner can run
by hand against their own development database — never execute it against a
production database, and there is no corresponding delete command anywhere
in this codebase:

```sql
SELECT count(*) FROM "user" WHERE email LIKE 'e2e-%@example.com';
```

## Deployment notes (vendor-neutral)

Nothing in this repository is tied to a specific host. A deployment needs:
Node ≥ 20 (or the Docker image above), a reachable PostgreSQL 16+ instance,
and the production environment contract set. Examples of platforms that fit
this shape — mentioned only as illustrations, not dependencies:

- **Railway / Render / Fly.io**: point the platform's Docker deploy at this
  repository's `Dockerfile`, run the `migrator` target as a one-off release
  command before rolling the `runner` target, and set the environment
  contract in the platform's secret/variable manager.
- **A plain Docker host** (a VM, a bare-metal box): use the `docker build`/
  `docker run` commands above directly, with a process supervisor
  (systemd, a Compose file) restarting the `runner` container and running
  the `migrator` image manually before each deploy that changes the schema.

## Known constraints (read before relying on this system)

- **Debt/loan payment history is immutable through the product UI** — see
  `docs/architecture.md`. There is no correction, reversal or delete flow.
- **Registration failure copy is intentionally uninformative**: a duplicate
  email and any other registration failure show the same generic message,
  by owner ruling, to avoid confirming whether an address has an account.
  The underlying timing difference (password hashing only happens for a
  fresh address) is a known, accepted residual — not equalized.
- **No email configured means no boot in production.** A production
  deployment with no SMTP relay cannot start at all, by design — password
  reset is the only email this app sends, and it is a security-sensitive
  flow with no safe fallback.
- **`NODE_ENV` unset is treated differently by two different layers.** The
  env-validation module (`lib/server/env.ts`) treats an unset or
  unrecognised `NODE_ENV` as *not* production (so a bare `node` invocation
  or a fresh checkout still boots for local inspection); Next's own runtime
  treats an unset `NODE_ENV` as *production* for its own build/serve
  behaviour (headers, minification, etc.). Never rely on leaving it unset —
  always set it explicitly for the environment you mean.
