import { describe, expect, it } from 'vitest'
import { defaultPaymentAccountId, type DebtAccountOption } from './debt-accounts'

const wallet: DebtAccountOption = { id: 'wallet', name: 'Wallet', currency: 'VND' }
const bank: DebtAccountOption = { id: 'bank', name: 'Bank', currency: 'VND' }

describe('defaultPaymentAccountId', () => {
  it("prefers the debt's opening account over the most recently used one", () => {
    expect(defaultPaymentAccountId([wallet, bank], 'bank', 'wallet')).toBe('bank')
  })

  it('falls back to the most recently used account when the debt moved no money', () => {
    expect(defaultPaymentAccountId([wallet, bank], null, 'wallet')).toBe('wallet')
  })

  it('never selects an account the picker does not list (other currency, archived)', () => {
    // The picker is already filtered to the debt's currency, so an account
    // outside it is simply absent from `options`.
    expect(defaultPaymentAccountId([wallet], 'usd-account', 'bank')).toBe('')
    expect(defaultPaymentAccountId([wallet], null, null)).toBe('')
  })

  it('uses the most recent account when the opening account is no longer listed', () => {
    expect(defaultPaymentAccountId([wallet], 'archived', 'wallet')).toBe('wallet')
  })
})
