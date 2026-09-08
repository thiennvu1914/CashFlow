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
