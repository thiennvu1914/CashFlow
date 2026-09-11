# Architecture

CashFlow is a Next.js 16 App Router application: server actions and services
own every financial invariant, client components stay thin. This document
describes the invariants and boundaries an owner needs before touching the
code — not a line-by-line walkthrough. Where a rule is frozen (never
weakened, per the phase plans), it is called out explicitly.

## Tenant isolation

Every request that touches user data goes through `requireUser()`
(`lib/auth/require-user.ts`) in the service/server-action layer — this is the
actual boundary, not the page. Next can render a layout and a page
concurrently, and a client-side navigation can re-render a page without
re-running its parent layout, so **layouts are not an auth boundary**: every
`(app)` page also calls `requireUserOrRedirect()` on its own. Cross-user
relations use composite `(userId, id)` foreign keys, so a row can only be
joined through its owner's id — a stray query cannot accidentally pull
another user's account by numeric id alone. `User.isDemo` never appears in
any client-facing Zod schema; it is set once, server-side, by the demo seed
script.

## Balance derivation

`FinancialAccount` has no stored balance column. A balance is always the sum
of `Transaction` and `Transfer` rows for that account, computed on read
(`lib/server/services/balance.ts` and friends). This is deliberate: "planning
modules must never silently touch balances" is structurally true rather than
policy-enforced, because there is no balance field to touch.

## Transactions, transfers and money

- `Transaction.amount` is always `≥ 0`; the sign is carried entirely by
  `type` (`INCOME`, `EXPENSE`, `CASH_IN`, `CASH_OUT`), never by a negative
  amount.
- Money is a Prisma `Decimal` everywhere, never a `Float` — this avoids
  floating-point drift in currency arithmetic.
- A transfer moves money between two accounts and preserves value: a
  same-currency transfer copies the amount, and a cross-currency transfer
  derives `toAmount` from the FX policy at the time of the transfer, never
  from a client-supplied number.

## FX snapshot vs. current position

Every `Transaction` snapshots the rate it was entered under —
`vndPerUsdAtEntry`, `fxRateFetchedAt`, `fxRateEffectiveAt`, `fxRateSource` —
via the real FX policy (`lib/currency/`). No code path is allowed to
fabricate a rate. `historicalAmountIn()` (`lib/currency/historical-amount.ts`)
is the **only** function that converts a historical amount into another
currency; it always uses the snapshot on the row, never today's rate. Current
position (dashboards, Net Worth) instead uses `lib/currency/current-amount.ts`
against the live/cached rate. `User.baseCurrency` only controls which
currency the UI displays totals in — it never changes what was stored.

## Net Worth, budgets, savings

Net Worth is derived the same way balances are: summed from accounts (in
their current position, converted to the user's base currency), plus
outstanding debts/loans, computed on read — nothing is cached in a column.
Budgets and savings goals are period-scoped views over the same transaction
data; they read, they do not mutate balances.

## Debts and loans — payment history is immutable (K6)

Debt and loan payments are append-only through the product UI: there is no
correction, reversal, edit or delete flow for a `DebtPayment` or a
`LoanPayment` once recorded, and `nextDueDate` semantics are untouched by
Phase 8. This is an explicit owner ruling, not an oversight — if a payment
was recorded wrong today, the only paths are a new offsetting payment
recorded through the same service, or a direct database intervention outside
the product. Any future correction/reversal feature is new product work, not
a bug fix.

## Reminders

Reminders carry a recurrence rule and are anchored to the IANA timezone the
user was in **when the reminder was created** — a later profile timezone
change re-phases nothing and never duplicates an occurrence. Occurrences are
not pre-computed on a schedule (there is no cron/background job anywhere in
this app); they are **materialized on read**,
`materializeDueOccurrences()`/`listUpcomingOccurrences()`
(`lib/server/services/reminder.ts`), the first time a page or the dashboard
widget asks for them. `listUpcomingOccurrences` is bounded (`take`) to the
dashboard's overdue-cap-plus-display-max so the query cannot grow unbounded
as reminders accumulate.

## Locale and theme resolution

Vietnamese is the default locale; English is selected via a `NEXT_LOCALE`
cookie or the user's profile. `resolveLocale()` (`lib/i18n/config.ts`) is the
single source of truth for that decision — there are no `[locale]` routes.
Message dictionaries are per-domain files under `messages/vi/*.json` and
`messages/en/*.json` (e.g. `common.json`, `auth.json`, `transactions.json`),
kept in parity by a dedicated test. Theme (light/dark) resolves the same way:
profile preference, mirrored to a cookie so first paint has no flash of the
wrong theme. Both preference cookies get the `Secure` attribute over HTTPS in
production and stay plain over local HTTP dev.

Server timezone contract: everything is stored in UTC; period boundaries
(weeks starting Monday, months, budget periods; exclusive `endUtc`) are
computed with `getPeriodBounds` in the *user's* IANA zone from those UTC
timestamps. The server process itself must run with `TZ=UTC` — see
`docs/operations.md`.

## Server/client boundary

- Mutations are Server Actions (`'use server'`), colocated per feature,
  calling the service layer — never a client component talking to Prisma
  directly.
- Validation is Zod, shared between the client form (UX-only feedback) and
  the server action, which always re-validates independently regardless of
  what the client sent.
- Server-side view models emit plain, already-localized keys/values to the
  client rather than handing over raw enums or Decimal objects for the
  client to reformat.
- Client mutation submission goes through one shared hook,
  `useActionSubmit()` (`lib/ui/use-action-submit.ts`): pending/locked state,
  `aria-busy`, a duplicate-submit guard, a refused-code path mapped to a
  localized key, and a thrown-error path that preserves the server's
  `error.digest` so a user-visible reference code matches the corresponding
  server log line (see `docs/operations.md`'s logging section). This
  replaced roughly 26 hand-copied client handlers in Phase 8 Wave 1 — new
  mutation UI should use the hook rather than reintroducing a bespoke
  `catch` block.

## Error boundaries

`app/global-error.tsx` and `app/not-found.tsx` (plus a nested `(app)`
not-found where useful) render CashFlow's own tokens, a heading, one
sentence, a recovery action, and — for `global-error` — the same `digest`
Next's `onRequestError` instrumentation logs server-side. Neither boundary
ever renders `error.message` or a stack trace to the user.

## What is explicitly out of scope for this document

No line-by-line code, no migration history, no UI component inventory. See
`docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` for the original
product specification and `docs/superpowers/plans/` for phase-by-phase
implementation plans, including the frozen invariants list each phase
committed not to weaken.
