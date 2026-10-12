import { describe, expect, it } from 'vitest'
import { defaultNextDueDate } from './loan-schedule'

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
