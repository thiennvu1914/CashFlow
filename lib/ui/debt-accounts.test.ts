import { describe, expect, it } from 'vitest'
import {
  defaultLinkAccountId,
  defaultLinkDate,
  defaultPaymentAccountId,
  type DebtAccountOption,
} from './debt-accounts'

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

describe('defaultLinkAccountId', () => {
  it('starts on the most recently used account when the picker lists it', () => {
    expect(defaultLinkAccountId([wallet, bank], 'bank')).toBe('bank')
  })

  it('falls back to the first listed account — there is no "don\'t record" to fall back to', () => {
    expect(defaultLinkAccountId([wallet, bank], 'usd-account')).toBe('wallet')
    expect(defaultLinkAccountId([wallet, bank], null)).toBe('wallet')
  })

  it('is empty only when no account in the currency exists at all', () => {
    expect(defaultLinkAccountId([], 'wallet')).toBe('')
  })
})

describe('defaultLinkDate (Ruling P7)', () => {
  const unlinked = (date: string) => ({ date, accountId: null })
  const linked = (date: string) => ({ date, accountId: 'wallet' })

  it("is the agreement's own date when it comes before every payment still to record", () => {
    expect(defaultLinkDate('2026-03-01', [unlinked('2026-03-05'), unlinked('2026-04-01')])).toBe(
      '2026-03-01',
    )
    expect(defaultLinkDate('2026-03-01', [])).toBe('2026-03-01')
  })

  it('moves back to the oldest payment still to record, so the opening never lands after its own repayments', () => {
    // Added to the app on 1 March, but repaid from 10 February.
    expect(defaultLinkDate('2026-03-01', [unlinked('2026-03-05'), unlinked('2026-02-10')])).toBe(
      '2026-02-10',
    )
  })

  it('ignores a payment already recorded in an account — the link leaves it alone', () => {
    expect(defaultLinkDate('2026-03-01', [linked('2026-01-15'), unlinked('2026-03-05')])).toBe(
      '2026-03-01',
    )
  })
})
