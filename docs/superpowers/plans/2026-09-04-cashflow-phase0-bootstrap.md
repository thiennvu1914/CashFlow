# CashFlow Phase 0: Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a runnable Next.js + TypeScript app with Postgres/Prisma wired, shadcn/ui restyled to the CashFlow palette, i18n and theme scaffolding in place, and the timezone-aware period-bounds utility built and tested — so every later phase has a working foundation to build on.

**Architecture:** Single Next.js App Router project at the repo root (no `src/` directory). Local Postgres via Docker Compose. Design tokens as CSS variables consumed by Tailwind. next-intl used in "no URL routing" mode (locale is a profile/cookie preference, not a URL segment). No application features yet — this phase produces infrastructure only, verified by `npm run dev` rendering a themed, translated placeholder page.

**Tech Stack:** Next.js (latest stable, App Router), TypeScript (strict), Tailwind CSS, shadcn/ui, Prisma, PostgreSQL 16 (Docker), next-intl, date-fns + date-fns-tz, Vitest, npm.

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md`

## Global Constraints

(Copied verbatim from the spec; every task's requirements implicitly include this section.)

- No stored balance column anywhere — balance is always derived from Transaction + Transfer.
- Every financial Prisma model is scoped by `userId`; cross-user relations use tenant-scoped composite foreign keys (`@@unique([userId, id])` on the parent + composite `@relation([userId, xId], [userId, id])` on the child).
- Money fields are always Prisma `Decimal`, never `Float`.
- `Transaction.amount` is always ≥ 0; sign is determined solely by `type`.
- Every Transaction snapshots `vndPerUsdAtEntry`, `fxRateTimestamp`, `fxRateSource` regardless of its own currency.
- `historicalAmountIn()` is the only function permitted to do historical currency conversion; it must never read `User.baseCurrency` or call the live FX provider.
- `User.baseCurrency` is a display/aggregation preference only — never a stored unit of financial fact.
- `User.isDemo` must never appear in any client-facing Zod schema.
- No background jobs/cron — reminders and historical FX lookups are computed lazily on read.
- Every server action/query calls `requireUser()` and scopes every query by the resulting `userId` — a client-supplied user id is never trusted.
- Zod validates every mutation server-side, independent of client-side validation.
- Package manager: npm. No `src/` directory — `app/`, `components/`, `lib/`, `prisma/` at repo root. Import alias `@/*`. Node 20+ LTS.

---

## Task 1: Scaffold the Next.js project

**Files:**
- Create: entire scaffolded Next.js project at repo root (`package.json`, `next.config.ts`, `tsconfig.json`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, plus whichever Tailwind/ESLint config files the installed tool versions actually generate — see Step 3a, do not assume `tailwind.config.ts`/`.eslintrc.json` exist before checking)
- Modify: `.gitignore` (merge scaffolded entries with any existing)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a running `npm run dev` Next.js app at repo root; `@/*` import alias resolving to repo root

The repo already contains `README.md` and `.git` at the root, so `create-next-app` must not run in-place (it refuses on a non-empty directory). Scaffold into a temp directory, then merge.

- [ ] **Step 1: Scaffold into a temp directory**

```bash
npx create-next-app@latest cashflow-scaffold-tmp \
  --typescript --tailwind --eslint --app --no-src-dir \
  --import-alias "@/*" --use-npm
```
Expected: command completes, `cashflow-scaffold-tmp/` contains a full Next.js project.

- [ ] **Step 2: Merge scaffolded files into the repo root**

```bash
cd cashflow-scaffold-tmp
rm -rf .git
cp -r . ../
cd ..
rm -rf cashflow-scaffold-tmp
```
If the scaffold's `README.md` overwrote the repo's own, restore the original one-line `# CashFlow` content.

- [ ] **Step 3: Verify the dev server runs**

Run: `npm run dev` (in background or with a short timeout), then request `http://localhost:3000`.
Expected: HTTP 200 and the default Next.js starter page content.
Stop the dev server.

- [ ] **Step 3a: Inspect what was actually generated before editing any config**

```bash
ls -a
```
(or `Get-ChildItem -Force` if working in PowerShell). Note which of these exist — do not assume either variant:
- Tailwind: `tailwind.config.ts` (v3-style, JS/TS config) vs. no such file with `@import "tailwindcss"` at the top of `app/globals.css` instead (v4-style CSS-first config).
- ESLint: `.eslintrc.json` (legacy config) vs. `eslint.config.mjs` (flat config, ESLint 9+).

Record which pair is present — it determines exactly how Step 4 below and Task 3 (design tokens) are written. Both are given below; follow only the branch matching what's actually on disk, and verify the exact directive/property names against that tool's current documentation if anything looks unfamiliar (config syntax shifts between major versions).

- [ ] **Step 4: Add Prettier**

```bash
npm install --save-dev prettier eslint-config-prettier
```
Create `.prettierrc.json`:
```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

If `.eslintrc.json` exists (legacy config): add `"prettier"` last in its `extends` array.

If `eslint.config.mjs` exists (flat config) instead: add the import and spread it last in the exported array:
```js
import prettierConfig from 'eslint-config-prettier'
// ...
export default [
  // ...existing generated config entries...
  prettierConfig,
]
```
Either way, the goal is the same: Prettier's config must be applied last so it can turn off any ESLint formatting rules that would otherwise fight it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with TypeScript, Tailwind, ESLint, Prettier"
```

---

## Task 2: Local Postgres via Docker Compose + Prisma connectivity

**Files:**
- Create: `docker-compose.yml`, `prisma/schema.prisma`, `.env.example`
- Create (gitignored): `.env`

**Interfaces:**
- Consumes: nothing new
- Produces: a running local Postgres reachable at `DATABASE_URL`; `prisma/schema.prisma` with `datasource`/`generator` blocks that later phases add models to

- [ ] **Step 1: Write docker-compose.yml**

```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: cashflow
      POSTGRES_PASSWORD: cashflow_dev_password
      POSTGRES_DB: cashflow
    ports:
      - '5432:5432'
    volumes:
      - cashflow_postgres_data:/var/lib/postgresql/data

volumes:
  cashflow_postgres_data:
```

- [ ] **Step 2: Start Postgres and verify it's reachable**

```bash
docker compose up -d
docker compose ps
```
Expected: `postgres` service shows state `running (healthy)` or `Up`.

- [ ] **Step 3: Install Prisma and initialize**

```bash
npm install prisma --save-dev
npm install @prisma/client
npx prisma init --datasource-provider postgresql
```

- [ ] **Step 4: Point Prisma at the local database**

Write `.env.example`:
```
DATABASE_URL="postgresql://cashflow:cashflow_dev_password@localhost:5432/cashflow?schema=public"
BETTER_AUTH_SECRET="replace-with-a-random-32-byte-secret"
BETTER_AUTH_URL="http://localhost:3000"
SMTP_HOST=""
SMTP_PORT=""
SMTP_USER=""
SMTP_PASSWORD=""
EMAIL_FROM="CashFlow <no-reply@example.com>"
ALLOW_DEMO_SEED_IN_PRODUCTION="false"
```
Copy it to `.env` (gitignored) with the real local values (the `DATABASE_URL` above already matches the compose service, so `.env` can be an identical copy for local dev).

Confirm `.gitignore` contains `.env` (not `.env.example`).

- [ ] **Step 5: Verify Prisma can reach the database**

`prisma/schema.prisma` at this point has only `datasource db` and `generator client` blocks (no models yet — those arrive in Phases 1–2). Verify connectivity without needing any model:

```bash
npx prisma db push
```
Expected: output confirms the datasource is reachable (e.g. "The database is already in sync with the Prisma schema" or equivalent) with no connection error.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml prisma/schema.prisma .env.example .gitignore package.json package-lock.json
git commit -m "chore: add Docker Compose Postgres and wire up Prisma"
```

---

## Task 3: Design tokens — palette, radius, shadcn init

**Files:**
- Create: `components.json` (via shadcn init)
- Modify: `app/globals.css`, and `tailwind.config.ts` if it exists (see Step 3 — its absence is expected under Tailwind v4)

**Interfaces:**
- Consumes: scaffolded Tailwind config from Task 1
- Produces: CSS variables (`--background`, `--surface`, `--foreground`, `--brand`, `--accent`, `--positive`, `--negative`, `--warning`, plus shadcn's own `--primary`/`--secondary`/etc. mapped onto these) usable by every later component; `npx shadcn add <component>` working and producing restyled (not stock) output

- [ ] **Step 1: Initialize shadcn/ui**

```bash
npx shadcn@latest init
```
When prompted: base color = neutral, CSS variables = yes.

- [ ] **Step 2: Replace the generated color tokens with the CashFlow palette**

In `app/globals.css`, replace the `:root` and `.dark` blocks shadcn generated with:
```css
:root {
  --background: 100 8% 96%;      /* #F6F7F5 */
  --surface: 0 0% 100%;          /* #FFFFFF */
  --foreground: 155 10% 11%;     /* #19211E */
  --brand: 165 55% 27%;          /* #216B5B — Deep Jade */
  --accent: 215 30% 49%;         /* #5576A3 — Muted Blue */
  --positive: 152 43% 33%;       /* #32805C — income */
  --negative: 3 47% 57%;         /* #C95C5C — expense */
  --warning: 38 51% 46%;         /* #B98532 */
  --radius: 0.5rem;
}

.dark {
  --background: 160 8% 10%;      /* #171C1A */
  --surface: 150 6% 15%;         /* #202724 */
  --foreground: 100 8% 96%;
  --brand: 165 45% 40%;
  --accent: 215 30% 60%;
  --positive: 152 38% 45%;
  --negative: 3 47% 65%;
  --warning: 38 51% 58%;
}
```
Map shadcn's expected tokens (`--primary`, `--card`, etc.) onto these in the same file, e.g. `--primary: var(--brand); --card: var(--surface); --card-foreground: var(--foreground);` — consult the tokens shadcn's `init` step actually generated and redirect each to the equivalent above rather than leaving shadcn's own zinc-based values in place.

- [ ] **Step 3: Wire radius and font family into the Tailwind config**

Use whichever of these matches what Task 1 Step 3a found on disk:

If `tailwind.config.ts` exists (Tailwind v3): set `borderRadius` to derive from `--radius` (shadcn's init typically already does this — verify, don't duplicate) and confirm no color in the generated config still points at a hardcoded zinc/slate scale instead of the CSS variables above.

If there's no `tailwind.config.ts` and `app/globals.css` instead starts with `@import "tailwindcss"` (Tailwind v4, CSS-first config): the token mapping belongs in an `@theme` block in `app/globals.css` rather than a JS/TS config file, e.g.:
```css
@theme inline {
  --radius-DEFAULT: var(--radius);
  --color-background: var(--background);
  --color-surface: var(--surface);
  --color-foreground: var(--foreground);
  --color-brand: var(--brand);
  --color-accent: var(--accent);
  --color-positive: var(--positive);
  --color-negative: var(--negative);
  --color-warning: var(--warning);
}
```
shadcn's `init` (Step 1) should already have generated something close to this for its own tokens — verify the exact directive name and structure against the installed shadcn/Tailwind version's current output rather than assuming this snippet is exact, and extend it with the CashFlow-specific tokens rather than duplicating what's already there.

- [ ] **Step 4: Install two baseline primitives and verify the restyle**

```bash
npx shadcn@latest add button input
```
In `app/page.tsx`, temporarily render `<Button>Test</Button>`. Run `npm run dev`, view `http://localhost:3000` in a browser, confirm the button renders in Deep Jade (`#216B5B`-derived), not shadcn's default zinc/black. Remove the temporary render after confirming.

- [ ] **Step 5: Commit**

```bash
git add components.json app/globals.css components/ui package.json package-lock.json
git add tailwind.config.ts 2>/dev/null || true
git commit -m "feat: apply CashFlow design tokens to shadcn/ui"
```

---

## Task 4: Manrope font + tabular numerals

**Files:**
- Modify: `app/layout.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces: `font-manrope` applied globally; Tailwind's built-in `tabular-nums` utility available for use on every monetary value in later phases (no custom CSS needed — it ships as a core Tailwind utility)

- [ ] **Step 1: Add the Manrope font**

In `app/layout.tsx`:
```tsx
import { Manrope } from 'next/font/google'

const manrope = Manrope({ subsets: ['latin', 'vietnamese'], variable: '--font-manrope' })
```
Apply `manrope.variable` and `manrope.className` on the `<html>` or `<body>` element (following whatever pattern `create-next-app` scaffolded for the default font — replace it, don't add alongside it).

In `tailwind.config.ts`, set the `fontFamily.sans` default to `['var(--font-manrope)', 'sans-serif']`.

- [ ] **Step 2: Verify**

Run `npm run dev`, view the placeholder page, confirm text renders in Manrope (distinct from the browser's default sans-serif — check via browser devtools computed font-family).

- [ ] **Step 3: Commit**

```bash
git add app/layout.tsx tailwind.config.ts
git commit -m "feat: use Manrope as the primary typeface"
```

---

## Task 5: next-intl scaffold (no URL routing)

**Files:**
- Create: `messages/vi.json`, `messages/en.json`, `lib/i18n/config.ts`
- Modify: `app/layout.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces: `resolveLocale(): Promise<'vi' | 'en'>` (reads a `NEXT_LOCALE` cookie, defaults to `'vi'`) — later phases (profile settings, Phase 7) call this and write the cookie when a user changes their preference

Locale is a profile/cookie preference, not a URL segment — there is no `/[locale]/...` route structure, avoiding a doubled route tree for a purely auth-gated app.

- [ ] **Step 1: Install next-intl**

```bash
npm install next-intl
```

- [ ] **Step 2: Write minimal message files**

`messages/vi.json`:
```json
{ "common": { "appName": "CashFlow", "placeholder": "Đang xây dựng nền tảng" } }
```
`messages/en.json`:
```json
{ "common": { "appName": "CashFlow", "placeholder": "Foundation under construction" } }
```

- [ ] **Step 3: Write the locale resolver**

`lib/i18n/config.ts`:
```ts
import { cookies } from 'next/headers'

export const SUPPORTED_LOCALES = ['vi', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'vi'

export async function resolveLocale(): Promise<Locale> {
  const store = await cookies()
  const value = store.get('NEXT_LOCALE')?.value
  return (SUPPORTED_LOCALES as readonly string[]).includes(value ?? '')
    ? (value as Locale)
    : DEFAULT_LOCALE
}
```

- [ ] **Step 4: Wire the provider into the root layout**

In `app/layout.tsx`:
```tsx
import { NextIntlClientProvider } from 'next-intl'
import { resolveLocale } from '@/lib/i18n/config'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveLocale()
  const messages = (await import(`@/messages/${locale}.json`)).default
  return (
    <html lang={locale}>
      <body className={/* existing font classes from Task 4 */}>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
```

- [ ] **Step 5: Render a translated string and verify locale switching**

In `app/page.tsx`, use `useTranslations` (client component) or `getTranslations` (server component) from `next-intl` to render `common.placeholder`.

Run `npm run dev`, load `http://localhost:3000`, confirm the Vietnamese placeholder text renders. Manually set a `NEXT_LOCALE=en` cookie via browser devtools, reload, confirm the English text renders instead.

- [ ] **Step 6: Commit**

```bash
git add messages lib/i18n app/layout.tsx app/page.tsx package.json package-lock.json
git commit -m "feat: scaffold next-intl with vi (default) and en messages"
```

---

## Task 6: Timezone-aware period-bounds utility (TDD)

**Files:**
- Create: `lib/datetime/period-bounds.ts`
- Test: `lib/datetime/period-bounds.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `getPeriodBounds(timezone: string, period: Period, referenceDate: Date): { startUtc: Date; endUtc: Date }` — this exact signature is used by Phase 4 (Reports), Phase 5 (Budget month matching), and Phase 6 (reminder due-date computation). `endUtc` is the **exclusive** upper bound (start of the next period) — range queries use `date >= startUtc AND date < endUtc`.

- [ ] **Step 1: Install date-fns and date-fns-tz, and Vitest**

```bash
npm install date-fns date-fns-tz
npm install --save-dev vitest
```
Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing tests**

`lib/datetime/period-bounds.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { getPeriodBounds } from './period-bounds'

describe('getPeriodBounds', () => {
  it('computes month bounds in Asia/Ho_Chi_Minh (UTC+7)', () => {
    const ref = new Date('2026-03-15T10:00:00Z')
    const { startUtc, endUtc } = getPeriodBounds('Asia/Ho_Chi_Minh', 'month', ref)
    // 2026-03-01T00:00:00+07:00 == 2026-02-28T17:00:00Z
    expect(startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
    // 2026-04-01T00:00:00+07:00 == 2026-03-31T17:00:00Z (exclusive upper bound)
    expect(endUtc.toISOString()).toBe('2026-03-31T17:00:00.000Z')
  })

  it('uses Monday as the start of week regardless of the reference weekday', () => {
    // 2026-03-15 is a Sunday
    const ref = new Date('2026-03-15T10:00:00Z')
    const { startUtc, endUtc } = getPeriodBounds('Asia/Ho_Chi_Minh', 'week', ref)
    // Monday 2026-03-09T00:00:00+07:00 == 2026-03-08T17:00:00Z
    expect(startUtc.toISOString()).toBe('2026-03-08T17:00:00.000Z')
    // Next Monday 2026-03-16T00:00:00+07:00 == 2026-03-15T17:00:00Z
    expect(endUtc.toISOString()).toBe('2026-03-15T17:00:00.000Z')
  })

  it('is genuinely timezone-aware, not a hardcoded +7 offset (DST-observing zone)', () => {
    // 2026-07-15 is during US Eastern Daylight Time (UTC-4)
    const summerRef = new Date('2026-07-15T12:00:00Z')
    const summer = getPeriodBounds('America/New_York', 'day', summerRef)
    expect(summer.startUtc.toISOString()).toBe('2026-07-15T04:00:00.000Z')

    // 2026-01-15 is US Eastern Standard Time (UTC-5)
    const winterRef = new Date('2026-01-15T12:00:00Z')
    const winter = getPeriodBounds('America/New_York', 'day', winterRef)
    expect(winter.startUtc.toISOString()).toBe('2026-01-15T05:00:00.000Z')
  })

  it('computes quarter bounds', () => {
    const ref = new Date('2026-08-01T00:00:00Z') // Q3
    const { startUtc, endUtc } = getPeriodBounds('Asia/Ho_Chi_Minh', 'quarter', ref)
    expect(startUtc.toISOString()).toBe('2026-06-30T17:00:00.000Z') // Jul 1 00:00 +07
    expect(endUtc.toISOString()).toBe('2026-09-30T17:00:00.000Z')   // Oct 1 00:00 +07
  })

  it('computes year bounds', () => {
    const ref = new Date('2026-08-01T00:00:00Z')
    const { startUtc, endUtc } = getPeriodBounds('Asia/Ho_Chi_Minh', 'year', ref)
    expect(startUtc.toISOString()).toBe('2025-12-31T17:00:00.000Z') // Jan 1 2026 00:00 +07
    expect(endUtc.toISOString()).toBe('2026-12-31T17:00:00.000Z')   // Jan 1 2027 00:00 +07
  })
})
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npx vitest run lib/datetime/period-bounds.test.ts`
Expected: FAIL — `period-bounds.ts` does not exist yet.

- [ ] **Step 4: Implement `getPeriodBounds`**

`lib/datetime/period-bounds.ts`:
```ts
import {
  startOfDay, endOfDay, startOfWeek, startOfMonth, startOfQuarter, startOfYear, addDays,
} from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'

export type Period = 'day' | 'week' | 'month' | 'quarter' | 'year'

/**
 * Confirm the installed date-fns-tz major version exposes `fromZonedTime`/`toZonedTime`
 * (v3 naming). If the installed version is v2, use `zonedTimeToUtc`/`utcToZonedTime` instead —
 * check `node_modules/date-fns-tz/package.json` before assuming either name.
 */
export function getPeriodBounds(
  timezone: string,
  period: Period,
  referenceDate: Date,
): { startUtc: Date; endUtc: Date } {
  const zoned = toZonedTime(referenceDate, timezone)

  let startZoned: Date
  let nextStartZoned: Date

  switch (period) {
    case 'day':
      startZoned = startOfDay(zoned)
      nextStartZoned = startOfDay(addDays(zoned, 1))
      break
    case 'week':
      startZoned = startOfWeek(zoned, { weekStartsOn: 1 })
      nextStartZoned = addDays(startZoned, 7)
      break
    case 'month': {
      startZoned = startOfMonth(zoned)
      const next = new Date(startZoned)
      next.setMonth(next.getMonth() + 1)
      nextStartZoned = next
      break
    }
    case 'quarter': {
      startZoned = startOfQuarter(zoned)
      const next = new Date(startZoned)
      next.setMonth(next.getMonth() + 3)
      nextStartZoned = next
      break
    }
    case 'year': {
      startZoned = startOfYear(zoned)
      const next = new Date(startZoned)
      next.setFullYear(next.getFullYear() + 1)
      nextStartZoned = next
      break
    }
  }

  return {
    startUtc: fromZonedTime(startZoned, timezone),
    endUtc: fromZonedTime(nextStartZoned, timezone),
  }
}
```
Note: `endOfDay` is imported but unused above by design — the exclusive-upper-bound convention uses "start of next period" instead of "end of current period," which sidesteps millisecond-boundary bugs. Remove the unused `endOfDay` import when implementing.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run lib/datetime/period-bounds.test.ts`
Expected: PASS, all 5 tests. If the DST test fails, check the installed `date-fns-tz` major version and adjust the `fromZonedTime`/`toZonedTime` import names per the code comment above — do not adjust the expected test values to make a wrong implementation pass.

- [ ] **Step 6: Commit**

```bash
git add lib/datetime package.json package-lock.json
git commit -m "feat: add timezone-aware period-bounds utility with Monday week start"
```

---

## Task 7: Placeholder home route and final verification

**Files:**
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `resolveLocale` (Task 5), design tokens (Task 3), Manrope font (Task 4)
- Produces: nothing new — this is the phase's acceptance check

- [ ] **Step 1: Build a minimal themed placeholder page**

`app/page.tsx` renders the app name and placeholder string (via `next-intl`) inside a centered layout using the `Button` component from Task 3, so the page visibly exercises font, palette, and i18n together.

- [ ] **Step 2: Manual verification in a browser**

Run `npm run dev`, open `http://localhost:3000`:
- Confirm Manrope font, Deep Jade button color, and Vietnamese text all render together.
- Toggle a `dark` class on `<html>` via devtools, confirm the warm-charcoal dark palette (not pure black) applies.
- Resize the viewport to a mobile width, confirm no horizontal overflow.

- [ ] **Step 3: Run the full test suite**

```bash
npm run test
npm run lint
npm run build
```
Expected: all three succeed with no errors.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: themed placeholder home page completing Phase 0 bootstrap"
```

---

## Phase 0 Acceptance Check

- [ ] `npm run dev` serves a page using Manrope, the CashFlow light/dark palette, and Vietnamese-by-default text.
- [ ] `docker compose up -d` brings up Postgres; `npx prisma db push` connects successfully.
- [ ] `npm run test` passes, including the 5 timezone/period-bounds tests.
- [ ] `npm run build` and `npm run lint` both succeed.
- [ ] No `.env` file is committed; `.env.example` is.
