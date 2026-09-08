import { describe, expect, it } from 'vitest'
import viLabels from '@/messages/vi/labels.json'
import enLabels from '@/messages/en/labels.json'
import {
  budgetScopeLabelKey,
  budgetStatusLabelKey,
  categoryTypeLabelKey,
  currencyLabelKey,
  debtDirectionLabelKey,
  debtStatusLabelKey,
  goalStatusLabelKey,
  loanStatusLabelKey,
  occurrenceStatusLabelKey,
  paymentFrequencyLabelKey,
  recordStatusLabelKey,
  recurrenceLabelKey,
  reminderTypeLabelKey,
  transactionTypeLabelKey,
} from './labels'

/**
 * The guarantee this file exists for (spec §4): every member of every enum the
 * UI renders has a real label in BOTH locales. A missing key surfaces as
 * next-intl echoing the key path into the DOM — which is the "raw enum on
 * screen" defect Phase 7 is fixing, wearing a different hat.
 *
 * The members are listed literally rather than read off `@prisma/client` at
 * runtime: the Prisma client here is WASM-based and needs a driver adapter, and
 * importing it for a key-shape test would pull a database driver into a pure
 * unit test. The lists are checked against `prisma/schema.prisma` by hand, and
 * the `Record<Enum, …>` types in `labels.ts` are what make a schema change a
 * compile error rather than a silently unchecked member here.
 */
function resolve(tree: unknown, key: string): unknown {
  return key
    .replace(/^labels\./, '')
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tree)
}

const CASES: [string, string[]][] = [
  [
    'transactionType',
    (
      [
        'INCOME',
        'EXPENSE',
        'CASH_IN',
        'CASH_OUT',
        'ADJUSTMENT_INCREASE',
        'ADJUSTMENT_DECREASE',
      ] as const
    ).map(transactionTypeLabelKey),
  ],
  ['categoryType', (['INCOME', 'EXPENSE'] as const).map(categoryTypeLabelKey)],
  ['recordStatus', (['ACTIVE', 'ARCHIVED'] as const).map(recordStatusLabelKey)],
  ['budgetScope', (['OVERALL', 'CATEGORY'] as const).map(budgetScopeLabelKey)],
  [
    'budgetStatus',
    (['ok', 'warning_50', 'warning_80', 'at_100', 'exceeded'] as const).map(budgetStatusLabelKey),
  ],
  ['goalStatus', (['ACTIVE', 'ACHIEVED', 'ARCHIVED'] as const).map(goalStatusLabelKey)],
  ['debtDirection', (['RECEIVABLE', 'PAYABLE'] as const).map(debtDirectionLabelKey)],
  [
    'debtStatus',
    (['OPEN', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WRITTEN_OFF'] as const).map(debtStatusLabelKey),
  ],
  ['loanStatus', (['ACTIVE', 'OVERDUE', 'PAID_OFF', 'CLOSED'] as const).map(loanStatusLabelKey)],
  ['paymentFrequency', (['WEEKLY', 'MONTHLY', 'YEARLY'] as const).map(paymentFrequencyLabelKey)],
  ['reminderType', (['INCOME', 'EXPENSE'] as const).map(reminderTypeLabelKey)],
  [
    'recurrence',
    (['ONE_TIME', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).flatMap((frequency) => [
      recurrenceLabelKey(frequency, 1),
      recurrenceLabelKey(frequency, 3),
    ]),
  ],
  [
    'occurrenceStatus',
    (['PENDING', 'ACKNOWLEDGED', 'DISMISSED'] as const).map(occurrenceStatusLabelKey),
  ],
  ['currency', (['VND', 'USD'] as const).map(currencyLabelKey)],
]

describe('label keys', () => {
  for (const [family, keys] of CASES) {
    it(`${family}: every member resolves to a non-empty label in vi and en`, () => {
      for (const key of keys) {
        expect(resolve(viLabels, key), `vi ${key}`).toBeTypeOf('string')
        expect(resolve(viLabels, key), `vi ${key}`).not.toBe('')
        expect(resolve(enLabels, key), `en ${key}`).toBeTypeOf('string')
        expect(resolve(enLabels, key), `en ${key}`).not.toBe('')
      }
    })
  }

  it('has no label in the files that no function points at — dead copy rots', () => {
    const reachable = new Set(
      CASES.flatMap(([, keys]) => keys.map((key) => key.replace(/^labels\./, ''))),
    )
    function leaves(node: unknown, prefix = ''): string[] {
      if (typeof node !== 'object' || node === null) return [prefix]
      return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
        leaves(v, prefix ? `${prefix}.${k}` : k),
      )
    }
    expect(leaves(viLabels).filter((key) => !reachable.has(key))).toEqual([])
  })
})
