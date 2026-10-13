import { describe, expect, it } from 'vitest'
import type { SavingsGoalDto } from '@/lib/ui/savings-goal-view-model'
import type { UpdateSavingsGoalInput } from '@/lib/validation/savings-goal'
import { buildGoalEditPayload, editAccountOptions } from './goal-edit'

const VND = { id: 'a1', name: 'Tiền mặt', currency: 'VND' as const }
const USD = { id: 'a2', name: 'Đô la', currency: 'USD' as const }

function goal(
  overrides: Partial<Pick<SavingsGoalDto, 'entries' | 'linkedAccount'>> & {
    currency?: 'VND' | 'USD'
  } = {},
) {
  const currency = overrides.currency ?? 'VND'
  return {
    currency,
    entries: overrides.entries ?? [],
    linkedAccount: overrides.linkedAccount ?? null,
    editable: { currency },
  } as Pick<SavingsGoalDto, 'entries' | 'currency' | 'linkedAccount' | 'editable'>
}

const entry = {
  id: 'e1',
  kind: 'CONTRIBUTION' as const,
  amount: '1',
  amountValue: '1.00',
  date: '2026-03-01',
  note: '',
}

const values: UpdateSavingsGoalInput = { name: 'G', targetAmount: 5, currency: 'VND' }

describe('editAccountOptions', () => {
  it('lists every active account for a goal with no entries', () => {
    expect(editAccountOptions(goal(), [VND, USD])).toEqual([VND, USD])
  })

  it('lists only same-currency accounts once the goal has entries', () => {
    expect(editAccountOptions(goal({ entries: [entry] }), [VND, USD])).toEqual([VND])
  })

  it('keeps an archived linked account, labelled archived', () => {
    const linked = { id: 'gone', name: 'Quỹ cũ', archived: true }
    expect(editAccountOptions(goal({ linkedAccount: linked }), [VND])).toEqual([
      VND,
      { id: 'gone', name: 'Quỹ cũ', currency: 'VND', archived: true },
    ])
  })

  it('does not duplicate an active linked account', () => {
    const linked = { id: 'a1', name: 'Tiền mặt', archived: false }
    expect(editAccountOptions(goal({ linkedAccount: linked }), [VND, USD])).toEqual([VND, USD])
  })
})

describe('buildGoalEditPayload', () => {
  it('keeps linkedAccountId for a linked goal and takes the account currency', () => {
    const payload = buildGoalEditPayload(
      { ...values, linkedAccountId: 'a2', currency: 'VND' },
      USD,
      goal({ currency: 'VND' }),
    )
    expect(payload.linkedAccountId).toBe('a2')
    expect(payload.currency).toBe('USD')
  })

  it('posts no linkedAccountId only when "Not linked" is chosen', () => {
    const payload = buildGoalEditPayload(
      { ...values, linkedAccountId: undefined },
      undefined,
      goal(),
    )
    expect(payload.linkedAccountId).toBeUndefined()
    expect(payload.currency).toBe('VND')
  })

  it('never changes the currency of a goal with entries', () => {
    const payload = buildGoalEditPayload(
      { ...values, currency: 'USD' },
      undefined,
      goal({ entries: [entry] }),
    )
    expect(payload.currency).toBe('VND')
  })

  it('passes the picked currency for an unlinked goal without entries', () => {
    expect(buildGoalEditPayload({ ...values, currency: 'USD' }, undefined, goal()).currency).toBe(
      'USD',
    )
  })
})
