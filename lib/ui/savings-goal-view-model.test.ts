import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import type { SavingsGoalRow } from '@/lib/server/services/savings-goal'
import { toSavingsGoalDto } from './savings-goal-view-model'

/**
 * Pure mapping — no database, no session, no renderer. These cases pin the one
 * `toNumber()` this DTO performs (`percent`, the bar's width), the one place a
 * percentage is rounded (`percentLabel`, half-up on the `Decimal` rather than
 * on the float), that each goal is formatted in its OWN currency, and that
 * "overdue" is a comparison of two calendar strings and never of two instants.
 */

const CREATED_AT = new Date('2026-03-01T04:05:06.000Z')

function goal(overrides: Partial<SavingsGoalRow> = {}): SavingsGoalRow {
  return {
    id: 'goal_1',
    userId: 'user_1',
    name: 'MacBook',
    targetAmount: new Prisma.Decimal('50000000'),
    currentProgress: new Prisma.Decimal('20000000'),
    currency: 'VND',
    deadline: null,
    note: null,
    status: 'ACTIVE',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  }
}

/** Today, as it reads in the user's zone — the only "now" this module sees. */
const TODAY = '2026-03-15'

describe('toSavingsGoalDto', () => {
  it('maps an in-progress VND goal: own currency, whole dong, 40 %', () => {
    const dto = toSavingsGoalDto(goal(), TODAY)

    expect(dto.id).toBe('goal_1')
    expect(dto.name).toBe('MacBook')
    expect(dto.currency).toBe('VND')
    expect(dto.status).toBe('ACTIVE')
    expect(dto.target).toBe('50.000.000')
    expect(dto.progress).toBe('20.000.000')
    expect(dto.remaining).toBe('30.000.000')
    expect(dto.percent).toBe(40)
    expect(dto.percentLabel).toBe('40 %')
    expect(dto.deadline).toBeNull()
    expect(dto.deadlinePassed).toBe(false)
    expect(dto.daysToDeadline).toBeNull()
  })

  it('formats a USD goal with its two decimals, never converted to VND', () => {
    const dto = toSavingsGoalDto(
      goal({
        currency: 'USD',
        targetAmount: new Prisma.Decimal('2000'),
        currentProgress: new Prisma.Decimal('1500.50'),
      }),
      TODAY,
    )

    // Vietnamese grouping (the reader's locale) with USD precision (the money's).
    expect(dto.target).toBe('2.000,00')
    expect(dto.progress).toBe('1.500,50')
    expect(dto.remaining).toBe('499,50')
    expect(dto.currency).toBe('USD')
  })

  it('formats every money field in the caller-supplied locale', () => {
    const dto = toSavingsGoalDto(goal(), TODAY, 'en')

    expect(dto.target).toBe('50,000,000')
    expect(dto.progress).toBe('20,000,000')
    expect(dto.remaining).toBe('30,000,000')
  })

  it('clamps the bar at 100 % while the label tells the truth about over-saving', () => {
    const dto = toSavingsGoalDto(
      goal({
        targetAmount: new Prisma.Decimal('1000000'),
        currentProgress: new Prisma.Decimal('1200000'),
        status: 'ACHIEVED',
      }),
      TODAY,
    )

    // The bar cannot overflow its track…
    expect(dto.percent).toBe(100)
    // …but the figure the user saved is not hidden by that.
    expect(dto.percentLabel).toBe('120 %')
    // Nothing is "remaining" on an over-saved goal — never a negative figure.
    expect(dto.remaining).toBe('0')
    expect(dto.status).toBe('ACHIEVED')
  })

  it('reports 0 % for an untouched goal and 100 % at exactly the target', () => {
    const untouched = toSavingsGoalDto(goal({ currentProgress: new Prisma.Decimal('0') }), TODAY)
    expect(untouched.percent).toBe(0)
    expect(untouched.percentLabel).toBe('0 %')
    expect(untouched.remaining).toBe('50.000.000')

    const exact = toSavingsGoalDto(
      goal({
        targetAmount: new Prisma.Decimal('100.10'),
        currentProgress: new Prisma.Decimal('100.10'),
        status: 'ACHIEVED',
      }),
      TODAY,
    )
    expect(exact.percent).toBe(100)
    expect(exact.percentLabel).toBe('100 %')
    expect(exact.remaining).toBe('0')
  })

  it('rounds the label half-up on the Decimal, not on a float', () => {
    // 2/3 of the target: 66.666…%, which must read 67 % and never 66 %.
    const dto = toSavingsGoalDto(
      goal({
        targetAmount: new Prisma.Decimal('3'),
        currentProgress: new Prisma.Decimal('2'),
      }),
      TODAY,
    )

    expect(dto.percentLabel).toBe('67 %')
    // The bar keeps the unrounded width, so label and bar agree on the reading
    // without the bar inheriting the label's rounding.
    expect(dto.percent).toBeCloseTo(66.6667, 3)
  })

  it('marks a deadline in the past as passed while the goal is still unmet, with a negative day count', () => {
    const dto = toSavingsGoalDto(goal({ deadline: new Date('2026-03-14T00:00:00.000Z') }), TODAY)

    expect(dto.deadline).toBe('2026-03-14')
    expect(dto.deadlinePassed).toBe(true)
    expect(dto.daysToDeadline).toBe(-1)
  })

  it('does not mark today, or a future day, as passed, and gives a non-negative day count', () => {
    const today = toSavingsGoalDto(goal({ deadline: new Date('2026-03-15T00:00:00.000Z') }), TODAY)
    expect(today.deadline).toBe('2026-03-15')
    // A deadline of today has not been missed — the day is not over.
    expect(today.deadlinePassed).toBe(false)
    expect(today.daysToDeadline).toBe(0)

    const future = toSavingsGoalDto(goal({ deadline: new Date('2026-12-31T00:00:00.000Z') }), TODAY)
    expect(future.deadline).toBe('2026-12-31')
    expect(future.deadlinePassed).toBe(false)
    expect(future.daysToDeadline).toBe(291)
  })

  it('never marks an achieved goal as having missed its deadline', () => {
    const dto = toSavingsGoalDto(
      goal({
        deadline: new Date('2026-01-01T00:00:00.000Z'),
        currentProgress: new Prisma.Decimal('50000000'),
        status: 'ACHIEVED',
      }),
      TODAY,
    )

    // Saved late is still saved: the warning is about a target that may now be
    // out of reach, and this one is not.
    expect(dto.deadlinePassed).toBe(false)
  })

  it('reads the deadline in UTC, so a carrier is the day the user picked', () => {
    // A carrier is UTC midnight. Read in any zone west of UTC it would come
    // back as the previous day — which is exactly the bug this asserts against.
    const dto = toSavingsGoalDto(goal({ deadline: new Date('2026-04-01T00:00:00.000Z') }), TODAY)

    expect(dto.deadline).toBe('2026-04-01')
  })

  it('carries the edit form its own prefill, with no Decimal crossing to the client', () => {
    const dto = toSavingsGoalDto(
      goal({
        name: 'Emergency fund',
        targetAmount: new Prisma.Decimal('12000000'),
        currentProgress: new Prisma.Decimal('4500000.5'),
        deadline: new Date('2026-06-30T00:00:00.000Z'),
        note: 'Three months of expenses',
      }),
      TODAY,
    )

    expect(dto.editable).toEqual({
      name: 'Emergency fund',
      targetAmount: '12000000.00',
      currency: 'VND',
      deadline: '2026-06-30',
      note: 'Three months of expenses',
      currentProgress: '4500000.50',
    })
    // Plain strings only — a `Prisma.Decimal` cannot cross into a client component.
    for (const value of Object.values(dto.editable)) {
      expect(typeof value).toBe('string')
    }
  })

  it('empties the edit form fields the goal has no value for', () => {
    const dto = toSavingsGoalDto(goal({ deadline: null, note: null }), TODAY)

    // `''`, not `null`: these feed an `<input>`'s default value, and the schema
    // reads an empty deadline as "no deadline".
    expect(dto.editable.deadline).toBe('')
    expect(dto.editable.note).toBe('')
  })

  it('labels an archived goal as archived whatever its arithmetic says', () => {
    const dto = toSavingsGoalDto(
      goal({
        status: 'ARCHIVED',
        currentProgress: new Prisma.Decimal('50000000'),
      }),
      TODAY,
    )

    expect(dto.status).toBe('ARCHIVED')
    expect(dto.percent).toBe(100)
  })

  it('carries no DTO field that is an English status literal, an enum key, and nothing else', () => {
    const dto = toSavingsGoalDto(goal({ status: 'ACHIEVED' }), TODAY)

    // No `statusLabel` (or any other translated string) on the DTO at all —
    // the component calls `goalStatusLabelKey`.
    expect(Object.keys(dto)).not.toContain('statusLabel')

    const serialized = JSON.stringify(dto)
    expect(serialized).not.toMatch(/In progress|Achieved|Archived/)
  })
})
