<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## CashFlow project rules

- Package manager npm only; no `src/` — `app/`, `components/`, `lib/`, `prisma/` at repo root; import alias `@/*`; Node ≥ 20; run `npm run format:check`, `npm run lint`, `npm run test`, `npm run build` before every commit.
- Authoritative docs: spec `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md`; phase plans in `docs/superpowers/plans/`.
- Financial invariants (never weaken): no stored account balance — always derived from Transaction + Transfer; money is Prisma `Decimal`, never Float; `Transaction.amount ≥ 0`, sign comes only from `type`; every Transaction snapshots `vndPerUsdAtEntry`/`fxRateFetchedAt`/`fxRateEffectiveAt`/`fxRateSource` via the real FX policy — never a fabricated rate; `historicalAmountIn()` is the only historical conversion; `User.baseCurrency` is display-only; every query is scoped by the session `userId` via `requireUser()`; cross-user relations use composite `(userId, id)` foreign keys; `User.isDemo` never appears in client-facing Zod; no cron/background jobs.
- Prisma 7.10: the client is WASM-based and REQUIRES a driver adapter at runtime — `new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })` from `@prisma/adapter-pg`; `prisma7.config.ts` is CLI-only (do not add `url` back into `schema.prisma`); schema changes use `prisma migrate dev`, never `db push`; seed config belongs in `prisma7.config.ts` `migrations.seed`.
- Design system: Tailwind v4 CSS-first — tokens live in `app/globals.css` as oklch; use `var(--color-brand)` etc. in charts, never `hsl(var(--brand))`; shadcn 4.21 with `@base-ui/react` (base-nova preset) — add components with `npx shadcn add`, never hand-copied Radix snippets; check any menu/select/command component's hover fill (`bg-accent` is CashFlow's Muted Blue); Calm Premium Fintech: no gradients/glassmorphism/large shadows/giant radii/emoji icons.
- i18n: Vietnamese default, English via `NEXT_LOCALE` cookie / profile; `lib/i18n/config.ts` `resolveLocale()` is the single source; no `[locale]` routes. Timezone: store UTC, compute periods with `getPeriodBounds` in the user's IANA zone (Monday weeks, exclusive `endUtc`); set `TZ=UTC` in CI/production.
- Local dev: `docker compose up -d` (Postgres on host port 5439 — 5432 is taken on the original dev machine), `.env` from `.env.example`, never commit `.env*` except `.env.example`.
- Layouts are not an auth boundary (Next renders layout and page concurrently, and a client-side navigation can re-render a page without re-running its layout) — every `(app)` page calls `requireUserOrRedirect()` and every service/server action calls `requireUser()`.
