import type { Locale } from './locale'

/**
 * The eighteen message domains (spec §4), in a fixed order so the merged tree
 * is deterministic and a diff of it is readable.
 *
 * Split per domain rather than one file per locale because the two flat files
 * this replaces were about to become a thousand-line merge conflict: every
 * module task in Phase 7 adds keys, and a per-domain file means two tasks
 * touching two modules never touch the same file.
 *
 * `validation` is included and loaded like every other domain even though
 * Task 2b creates it as `{}` in both locales — Task 2c fills it, and nothing
 * about the loader changes when it does. `t('validation.Enter an amount')`
 * has to resolve once 2c lands, which means the domain has to be part of the
 * merged tree from this task onward.
 *
 * Accepted untranslated strings, as of Phase 7 Task 13's product-wide sweep
 * (each with its reason):
 *
 *  1. `InvalidReportRangeError`'s message (`lib/reports/report-range.ts`,
 *     thrown from six call sites, e.g. line 191's "from (…) must be on or
 *     before to (…)") — **no longer reaches the UI** (corrected by Task 17 fix
 *     round 1): `/reports` now renders `reports.invalidRange`, one localized
 *     sentence, and logs the developer message server-side instead. The
 *     English text still exists in two places, neither of them product copy:
 *     the thrown message itself (`lib/reports/` is frozen this phase, and it
 *     is written for a stack trace) and the 400 body of
 *     `GET /api/reports/export`, which is an API response with its own
 *     contract test (`app/api/reports/export/route.test.ts`) and is read-only
 *     for this phase.
 *  2. Excel sheet names and column headers (`lib/server/export/*`, including
 *     the `*_STATUS_LABELS`/`recurrenceLabel`/`LOAN_*_LABELS` maps
 *     `lib/ui/*-view-model.ts` export for them to import) — an explicit
 *     contract (spec §12), deliberately not localised: the workbook a user
 *     downloads today must open identically tomorrow regardless of which
 *     locale cookie is set when they click Export.
 *  3. Currency codes, IANA time-zone ids, and account/category/person/lender
 *     names — data the user typed or a currency/timezone standard defines,
 *     not copy this app owns. The Settings language `<select>`'s "Tiếng Việt"
 *     option is the same idea one level up: a language's own endonym, shown
 *     in its own script regardless of which locale is active — the
 *     convention every language switcher uses.
 *
 * NOT an exception: the Zod messages in `lib/validation/**`. The schemas keep
 * their English literals (Phase 2–6 tests assert them, and they are
 * reproduced server-side, frozen this phase), and the UI translates them at
 * the render boundary through `messages/{vi,en}/validation.json` — see
 * `lib/ui/validation-messages.ts` and the extraction test
 * (`lib/ui/validation-messages.test.ts`) that proves every literal has both
 * entries. This is only true because every field has a literal to extract:
 * Task 13's own fix round 1 found `financial-account.ts`'s (create and
 * update) and `account-type.ts`'s/`category.ts`'s `name` fields using a bare
 * `z.string().min(1)` with NO message, which meant Zod's own untranslatable
 * internal English ("Too small: expected string to have >=1 characters")
 * reached the DOM on an empty submit — not a missing dictionary entry (there
 * was no literal to extract) and not a bypassed `FieldError` (the form did
 * route through it correctly), so neither the extraction regex nor the
 * component was at fault. Fixed by giving those three `name` fields the
 * existing `'Name is required'` literal (already used by `auth.ts`/
 * `profile.ts`, already in both `validation.json` files) — a message literal
 * is copy, not a validation rule, so no `min`/`max` limit changed.
 */
export const MESSAGE_DOMAINS = [
  'common',
  'nav',
  'auth',
  'dashboard',
  'transactions',
  'transfers',
  'accounts',
  'categories',
  'budgets',
  'goals',
  'debts',
  'loans',
  'reminders',
  'reports',
  'settings',
  'errors',
  'labels',
  'validation',
] as const

/**
 * One namespace tree for `next-intl`, keyed by domain.
 *
 * A static `import()` per domain, written out rather than built from a template
 * literal: a `` import(`@/messages/${locale}/${domain}.json`) `` inside a loop
 * makes the bundler emit every JSON file in both directories and give up on
 * splitting them. Two locales × eighteen domains is 36 explicit specifiers,
 * and being explicit is what keeps the request cheap.
 */
const LOADERS: Record<Locale, () => Promise<Record<string, unknown>>> = {
  vi: async () => ({
    common: (await import('@/messages/vi/common.json')).default,
    nav: (await import('@/messages/vi/nav.json')).default,
    auth: (await import('@/messages/vi/auth.json')).default,
    dashboard: (await import('@/messages/vi/dashboard.json')).default,
    transactions: (await import('@/messages/vi/transactions.json')).default,
    transfers: (await import('@/messages/vi/transfers.json')).default,
    accounts: (await import('@/messages/vi/accounts.json')).default,
    categories: (await import('@/messages/vi/categories.json')).default,
    budgets: (await import('@/messages/vi/budgets.json')).default,
    goals: (await import('@/messages/vi/goals.json')).default,
    debts: (await import('@/messages/vi/debts.json')).default,
    loans: (await import('@/messages/vi/loans.json')).default,
    reminders: (await import('@/messages/vi/reminders.json')).default,
    reports: (await import('@/messages/vi/reports.json')).default,
    settings: (await import('@/messages/vi/settings.json')).default,
    errors: (await import('@/messages/vi/errors.json')).default,
    labels: (await import('@/messages/vi/labels.json')).default,
    validation: (await import('@/messages/vi/validation.json')).default,
  }),
  en: async () => ({
    common: (await import('@/messages/en/common.json')).default,
    nav: (await import('@/messages/en/nav.json')).default,
    auth: (await import('@/messages/en/auth.json')).default,
    dashboard: (await import('@/messages/en/dashboard.json')).default,
    transactions: (await import('@/messages/en/transactions.json')).default,
    transfers: (await import('@/messages/en/transfers.json')).default,
    accounts: (await import('@/messages/en/accounts.json')).default,
    categories: (await import('@/messages/en/categories.json')).default,
    budgets: (await import('@/messages/en/budgets.json')).default,
    goals: (await import('@/messages/en/goals.json')).default,
    debts: (await import('@/messages/en/debts.json')).default,
    loans: (await import('@/messages/en/loans.json')).default,
    reminders: (await import('@/messages/en/reminders.json')).default,
    reports: (await import('@/messages/en/reports.json')).default,
    settings: (await import('@/messages/en/settings.json')).default,
    errors: (await import('@/messages/en/errors.json')).default,
    labels: (await import('@/messages/en/labels.json')).default,
    validation: (await import('@/messages/en/validation.json')).default,
  }),
}

export async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  return LOADERS[locale]()
}
