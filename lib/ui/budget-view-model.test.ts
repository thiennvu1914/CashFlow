import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import type { BudgetProgress } from '@/lib/server/services/budget'
import { toBudgetProgressDto } from './budget-view-model'

/**
 * Pure mapping — no database, no session, no renderer. These cases pin the
 * one `toNumber()` this DTO performs (`percent`), the one place a percentage
 * is rounded (`percentLabel`, half-up on the Decimal, not the float), and that
 * a budget's own currency is what every money string uses — never
 * `User.baseCurrency`.
 */

function decimal(value: string) {
  return new Prisma.Decimal(value)
}

const NOW = new Date('2026-03-01T00:00:00Z')

interface ProgressOverrides {
  budget?: Partial<BudgetProgress['budget']>
  spent?: Prisma.Decimal
  remaining?: Prisma.Decimal
  ratio?: Prisma.Decimal
  status?: BudgetProgress['status']
}

function makeProgress(overrides: ProgressOverrides = {}): BudgetProgress {
  const budget = {
    id: 'budget_1',
    userId: 'user_1',
    year: 2026,
    month: 3,
    scope: 'CATEGORY' as const,
    categoryId: 'cat_1',
    amount: decimal('1000000'),
    currency: 'VND' as const,
    createdAt: NOW,
    updatedAt: NOW,
    category: {
      id: 'cat_1',
      name: 'Food',
      type: 'EXPENSE' as const,
      status: 'ACTIVE' as const,
    },
    ...overrides.budget,
  }
  const amount = budget.amount
  const spent = overrides.spent ?? decimal('300000')
  const remaining = overrides.remaining ?? amount.sub(spent)
  const ratio = overrides.ratio ?? spent.div(amount)
  const status = overrides.status ?? 'ok'

  return { budget, spent, remaining, ratio, status } as BudgetProgress
}

describe('toBudgetProgressDto', () => {
  it('maps an "ok" budget: category label, formatted VND figures, remaining not over', () => {
    const dto = toBudgetProgressDto(makeProgress())

    expect(dto).toMatchObject({
      id: 'budget_1',
      label: 'Food',
      scope: 'CATEGORY',
      categoryArchived: false,
      currency: 'VND',
      amount: '1.000.000',
      spent: '300.000',
      remaining: '700.000',
      over: false,
      percent: 30,
      percentLabel: '30 %',
      status: 'ok',
      statusLabel: 'Healthy',
      editable: { amount: '1000000.00', currency: 'VND' },
    })
  })

  it("clamps an exceeded budget's bar at 100 while the label reads the true percentage", () => {
    const dto = toBudgetProgressDto(
      makeProgress({
        spent: decimal('1200000'),
        remaining: decimal('-200000'),
        ratio: decimal('1.2'),
        status: 'exceeded',
      }),
    )

    expect(dto.percent).toBe(100)
    expect(dto.percentLabel).toBe('120 %')
    expect(dto.over).toBe(true)
    // Absolute value — the sign is conveyed by `over`, not a leading minus.
    expect(dto.remaining).toBe('200.000')
    expect(dto.statusLabel).toBe('Exceeded')
  })

  it('rounds a half-boundary ratio HALF_UP, not to-even or down', () => {
    // 0.125 × 100 = 12.5 exactly — a real ambiguous tie. `ROUND_HALF_UP`
    // rounds ties away from zero (13), where `ROUND_HALF_EVEN` would answer
    // 12: this pins the rounding mode the code comment calls out, so a future
    // change to it fails here rather than only in a code-review re-read.
    expect(toBudgetProgressDto(makeProgress({ ratio: decimal('0.125') })).percentLabel).toBe('13 %')
    // 0.115 × 100 = 11.5 exactly — the same tie one step down, confirming the
    // rounding is symmetric rather than a special case at one boundary only.
    expect(toBudgetProgressDto(makeProgress({ ratio: decimal('0.115') })).percentLabel).toBe('12 %')
  })

  it('formats a USD budget with two decimal places', () => {
    const dto = toBudgetProgressDto(
      makeProgress({
        budget: {
          amount: decimal('500.5'),
          currency: 'USD' as const,
        },
        spent: decimal('100.25'),
        remaining: decimal('400.25'),
        ratio: decimal('0.2003'),
      }),
    )

    expect(dto.currency).toBe('USD')
    expect(dto.amount).toBe('500,50')
    expect(dto.spent).toBe('100,25')
    expect(dto.remaining).toBe('400,25')
    expect(dto.editable).toEqual({ amount: '500.50', currency: 'USD' })
  })

  it('flags an archived category on an existing budget', () => {
    const dto = toBudgetProgressDto(
      makeProgress({
        budget: {
          category: {
            id: 'cat_1',
            name: 'Food',
            type: 'EXPENSE' as const,
            status: 'ARCHIVED' as const,
          },
        },
      }),
    )

    expect(dto.categoryArchived).toBe(true)
    expect(dto.label).toBe('Food')
  })

  it('labels an OVERALL budget "Overall" rather than a category name', () => {
    const dto = toBudgetProgressDto(
      makeProgress({
        budget: {
          scope: 'OVERALL' as const,
          categoryId: null,
          category: null,
        },
      }),
    )

    expect(dto.label).toBe('Overall')
    expect(dto.scope).toBe('OVERALL')
    expect(dto.categoryArchived).toBe(false)
  })
})
