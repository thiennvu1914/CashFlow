import { describe, it, expect } from 'vitest'
import { todayInZone } from './today-in-zone'

describe('todayInZone', () => {
  it('rolls over to the next calendar day in a zone ahead of UTC', () => {
    // 2026-09-05T22:30:00Z is already 2026-09-06T05:30:00+07:00.
    const now = new Date('2026-09-05T22:30:00Z')
    expect(todayInZone('Asia/Ho_Chi_Minh', now)).toBe('2026-09-06')
  })

  it('matches the UTC calendar day for the UTC zone itself', () => {
    const now = new Date('2026-09-05T22:30:00Z')
    expect(todayInZone('UTC', now)).toBe('2026-09-05')
  })

  it('defaults to the real current instant when none is given', () => {
    const before = todayInZone('UTC')
    expect(before).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
