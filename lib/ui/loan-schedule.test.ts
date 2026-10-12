import { describe, expect, it } from 'vitest'
import { createLoanSchema } from '@/lib/validation/loan'
import { defaultNextDueDate, scheduleAnchorDay } from './loan-schedule'

describe('defaultNextDueDate', () => {
  it('is one period after the start date, per frequency', () => {
    expect(defaultNextDueDate('2026-04-15', 'WEEKLY')).toBe('2026-04-22')
    expect(defaultNextDueDate('2026-04-15', 'MONTHLY')).toBe('2026-05-15')
    expect(defaultNextDueDate('2026-04-15', 'YEARLY')).toBe('2027-04-15')
  })

  it('clamps a month-end start to the shorter month', () => {
    expect(defaultNextDueDate('2026-01-31', 'MONTHLY')).toBe('2026-02-28')
    expect(defaultNextDueDate('2028-02-29', 'YEARLY')).toBe('2029-02-28')
  })

  it('answers nothing for a start date that is not a real calendar date', () => {
    expect(defaultNextDueDate('', 'MONTHLY')).toBeNull()
    expect(defaultNextDueDate('2026-02-30', 'MONTHLY')).toBeNull()
    expect(defaultNextDueDate('not a date', 'WEEKLY')).toBeNull()
  })
})

describe('scheduleAnchorDay', () => {
  it("is the start date's day while the next due date is the pre-filled one", () => {
    // Started Jan 31, first due Feb 28 — the anchor must stay 31.
    expect(scheduleAnchorDay('2026-01-31', '2026-02-28', false)).toBe(31)
    expect(scheduleAnchorDay('2028-02-29', '2029-02-28', false)).toBe(29)
    expect(scheduleAnchorDay('2026-04-15', '2026-05-15', false)).toBe(15)
  })

  it("is the typed due date's day once the user chose their own", () => {
    expect(scheduleAnchorDay('2026-01-31', '2026-02-28', true)).toBe(28)
    expect(scheduleAnchorDay('2026-01-10', '2026-02-20', true)).toBe(20)
  })

  it('agrees with what the schema accepts for the pre-filled due date', () => {
    for (const [start, frequency] of [
      ['2026-01-31', 'MONTHLY'],
      ['2028-02-29', 'YEARLY'],
      ['2026-03-30', 'MONTHLY'],
    ] as const) {
      const next = defaultNextDueDate(start, frequency)!
      expect(
        createLoanSchema.safeParse({
          lender: 'x',
          principal: 1,
          currency: 'VND',
          interestRate: 0,
          startDate: start,
          termMonths: 12,
          paymentFrequency: frequency,
          scheduledPaymentAmount: 1,
          nextDueDate: next,
          dueDayOfMonth: scheduleAnchorDay(start, next, false),
        }).success,
      ).toBe(true)
    }
  })
})
