# CashFlow production image — vendor-neutral, four stages.
#
#   deps     full `npm ci` (dev dependencies included)
#   builder  `next build` with `output: 'standalone'`
#   migrator `prisma migrate deploy` — a SEPARATE image/command, never an entrypoint
#   runner   the served app: standalone server, non-root, no Prisma CLI
#
# Why `migrator` is its own stage and not a runner entrypoint: `prisma` and
# `dotenv` are devDependencies (`prisma7.config.ts` does `import "dotenv/config"`),
# so a runtime image small enough to be worth shipping cannot migrate, and a
# migration that runs on container start races every replica. Deploy is
# therefore two steps — run the migrator once as a release command, then roll
# the runner:
#
#   docker build --target migrator -t cashflow:migrate .
#   docker run --rm --env-file <env> cashflow:migrate      # runs `npm run db:deploy`
#   docker build -t cashflow:latest .
#   docker run -p 3000:3000 --env-file <env> cashflow:latest
#
# `prisma migrate deploy` only applies committed migrations; `db push` is never
# used here or anywhere (AGENTS.md).
#
# Base image: Debian slim, not alpine. Prisma 7's client is WASM — there is no
# native query engine and no libssl question any more, and `pg` is pure JS — so
# alpine would probably work, but "probably" is not a property worth having in
# the image that runs the money. Node 24 matches `.nvmrc` and the `engines`
# range in package.json.
ARG NODE_VERSION=24-bookworm-slim

# ---------------------------------------------------------------- deps -------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# `npm ci --omit=dev` is impossible here: `postinstall` is `prisma generate` and
# `prisma` is a devDependency, so a production-only install has no CLI to
# generate the client the app imports. The full install lives in this stage and
# never reaches the runner, which gets only what Next's trace copies.
#
# `prisma7.config.ts` and `prisma/` are copied before the install because
# `postinstall` reads them.
COPY package.json package-lock.json .npmrc ./
COPY prisma7.config.ts ./
COPY prisma ./prisma
RUN npm ci

# ------------------------------------------------------------- builder -------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

# NODE_ENV is deliberately NOT set in this stage. `next build` defaults it to
# `production` itself, and `next.config.ts`'s `headers()` is evaluated HERE, at
# build time, and baked into `routes-manifest.json` — so the builder's NODE_ENV,
# not the runner's, is what decides whether `Strict-Transport-Security` ships.
# Overriding it to anything else would silently drop HSTS from the production
# image. See `lib/server/security-headers.ts`.
ENV NEXT_TELEMETRY_DISABLED=1
# `lib/server/env.ts` requires `DATABASE_URL` in every environment, build
# included (`lib/prisma.ts` constructs the client at module scope while Next
# collects page data). It must be syntactically valid; it is never connected to
# during the build. A dummy value only — never a real secret, and every other
# secret is supplied at run time, not baked into a layer.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
# The production-only half of the env contract (BETTER_AUTH_SECRET, SMTP, …) is
# exempted during the build by `NEXT_PHASE=phase-production-build`, which Next
# sets itself.

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ------------------------------------------------------------ migrator -------
# Migrations only. Full `node_modules` (the Prisma CLI and `dotenv` are dev
# dependencies), the schema, the migrations directory and the CLI config. No
# application build output — this image never serves a request.
FROM node:${NODE_VERSION} AS migrator
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=UTC
COPY --from=deps /app/node_modules ./node_modules
COPY package.json prisma7.config.ts ./
COPY prisma ./prisma
USER node
CMD ["npm", "run", "db:deploy"]

# -------------------------------------------------------------- runner -------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
# The server/container contract (AGENTS.md, `lib/server/env.ts`): all period
# math starts from UTC; user-facing dates come from `User.timezone`.
ENV TZ=UTC
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Exactly the three things `output: 'standalone'` produces or leaves behind —
# the traced server plus the two directories `server.js` does not copy itself.
# `node_modules` is NOT copied wholesale: the standalone bundle carries the
# traced subset, which includes the Prisma WASM client, `@prisma/adapter-pg`
# and `pg` (verified against the trace — see the task report). `prisma/` and
# `prisma7.config.ts` are absent on purpose: they are CLI-only, and the runner
# must not be able to migrate.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# uid 1000, already present in the base image. Nothing here is written at run
# time — the only filesystem write in the app is the dev/e2e email outbox,
# which production refuses — so this can run with a read-only root filesystem.
USER node

EXPOSE 3000

# No curl in a slim image. A 503 (database unreachable) counts as unhealthy;
# three retries keep transient latency from cycling the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form so node is PID 1 and receives SIGTERM directly; Next drains
# in-flight requests itself. Allow a 30 s stop grace period on the platform.
CMD ["node", "server.js"]
