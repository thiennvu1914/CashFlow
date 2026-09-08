import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { FxUnavailableError } from '@/lib/currency/current-rate-policy'
import type { UsableRateResult } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import {
  getAccountDistribution,
  getCurrentPosition,
  getNetWorth,
  getTotalAccountBalance,
} from './position'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database.
 *
 * Every case injects a provider and `beforeEach` replaces `fetch` with a
 * throwing spy, so no test here can reach the network: an accidental live
 * lookup fails the test that caused it rather than passing quietly. The
 * USD/VND `ExchangeRate` rows are global (not user-scoped), so `afterEach`
 * clears them along with the user's own rows.
 */

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

/** Every `source` string this file can write into the shared FX cache. */
const FAKE_SOURCES = ['fake', 'seeded']

/**
 * A counting fake: the position service must consult the current-rate policy
 * at most once per call, no matter how many accounts need converting.
 */
function countingProvider(rate = 25000, source = 'fake') {
  let calls = 0
  const provider: ExchangeRateProvider = {
    getLatestRate: async () => {
      calls += 1
      return { rate, effectiveDate: new Date(), fetchedAt: new Date(), source }
    },
    getHistoricalRate: async () => null,
  }
  return { provider, callCount: () => calls }
}

/** Stands in for a live provider outage — the only way into the fallback path. */
const failingProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('provider down')
  },
  getHistoricalRate: async () => null,
}

/** A `UsableRateResult` a caller already holds — what the export's single FX
 *  lookup hands to every sheet. */
function suppliedRate(rate: string): UsableRateResult {
  const at = new Date()
  return {
    rate: Number(rate),
    rateDecimal: new Prisma.Decimal(rate),
    effectiveDate: at,
    fetchedAt: at,
    source: 'supplied',
    isFallback: false,
  }
}

describe('current position service', () => {
  const createdUserIds: string[] = []
  let fetchSpy: MockInstance

  async function setup() {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `test-${randomUUID()}@example.com`,
        name: 'Test',
        emailVerified: false,
      },
    })
    createdUserIds.push(user.id)
    const accountType = await prisma.accountType.create({
      data: { userId: user.id, name: 'Cash' },
    })
    const vndAccount = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'VND',
        accountTypeId: accountType.id,
        initialBalance: 1_000_000,
        currency: 'VND',
      },
    })
    const usdAccount = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'USD',
        accountTypeId: accountType.id,
        initialBalance: 100,
        currency: 'USD',
      },
    })
    return {
      userId: user.id,
      accountTypeId: accountType.id,
      vndAccountId: vndAccount.id,
      usdAccountId: usdAccount.id,
    }
  }

  /** A user with no accounts at all — the Net Worth cases that are only about
   *  debts and loans, with nothing to add from the account side. */
  async function setupWithoutAccounts() {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `test-${randomUUID()}@example.com`,
        name: 'Test',
        emailVerified: false,
      },
    })
    createdUserIds.push(user.id)
    return { userId: user.id }
  }

  /**
   * A debt, and optionally one repayment against it — written directly rather
   * than through `createDebt`/`recordDebtPayment`, because this suite is about
   * the position's arithmetic and the services' Zod parse, row lock and
   * overpayment check would add a transaction per row without changing a single
   * figure. (`debt.test.ts` is where those rules are pinned down.)
   */
  async function seedDebt(
    userId: string,
    row: {
      direction: 'RECEIVABLE' | 'PAYABLE'
      originalAmount: string
      currency?: 'VND' | 'USD'
      status?: 'ACTIVE' | 'WRITTEN_OFF'
      /** A repayment already recorded, so `outstanding` is not the original. */
      paid?: string
    },
  ) {
    const debt = await prisma.debt.create({
      data: {
        userId,
        direction: row.direction,
        person: 'Counterparty',
        originalAmount: new Prisma.Decimal(row.originalAmount),
        currency: row.currency ?? 'VND',
        status: row.status ?? 'ACTIVE',
      },
    })
    if (row.paid !== undefined) {
      await prisma.debtPayment.create({
        data: {
          userId,
          debtId: debt.id,
          amount: new Prisma.Decimal(row.paid),
          date: new Date('2026-03-01T00:00:00Z'),
        },
      })
    }
    return debt
  }

  /** A loan, and optionally one instalment against it — same reasoning as
   *  `seedDebt`. `totalAmount` is the split's sum, which the
   *  `LoanPayment_total_matches_split` CHECK enforces. */
  async function seedLoan(
    userId: string,
    row: {
      principal: string
      currency?: 'VND' | 'USD'
      status?: 'ACTIVE' | 'CLOSED'
      principalPaid?: string
      interestPaid?: string
    },
  ) {
    const loan = await prisma.loan.create({
      data: {
        userId,
        lender: 'Bank',
        principal: new Prisma.Decimal(row.principal),
        currency: row.currency ?? 'VND',
        interestRate: new Prisma.Decimal('5'),
        startDate: new Date('2026-01-01T00:00:00Z'),
        termMonths: 12,
        paymentFrequency: 'MONTHLY',
        scheduledPaymentAmount: new Prisma.Decimal('1'),
        nextDueDate: new Date('2026-04-01T00:00:00Z'),
        dueDayOfMonth: 1,
        status: row.status ?? 'ACTIVE',
      },
    })
    if (row.principalPaid !== undefined || row.interestPaid !== undefined) {
      const principalAmount = new Prisma.Decimal(row.principalPaid ?? '0')
      const interestAmount = new Prisma.Decimal(row.interestPaid ?? '0')
      await prisma.loanPayment.create({
        data: {
          userId,
          loanId: loan.id,
          totalAmount: principalAmount.add(interestAmount),
          principalAmount,
          interestAmount,
          paymentDate: new Date('2026-03-01T00:00:00Z'),
        },
      })
    }
    return loan
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    // The fallback path warns by design; silenced to keep the output pristine.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    const userIds = createdUserIds.splice(0)
    try {
      await prisma.exchangeRate.deleteMany({ where: { source: { in: FAKE_SOURCES } } })
      await prisma.exchangeRate.deleteMany({ where: { base: PAIR.base, quote: PAIR.quote } })
      if (userIds.length > 0) {
        await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
        // Payments before their parent: both foreign keys are ON DELETE
        // RESTRICT, so the other order is a P2003 rather than a cascade.
        await prisma.debtPayment.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.debt.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.loanPayment.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.loan.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
      }
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
    // Asserted after cleanup so a network leak fails the run without also
    // leaving rows behind for the next test.
    expect(fetchCalls).toBe(0)
  })

  describe('getCurrentPosition', () => {
    it('sums same-currency accounts without touching FX at all', async () => {
      const s = await setup()
      await prisma.financialAccount.delete({
        where: { userId_id: { userId: s.userId, id: s.usdAccountId } },
      })
      const second = await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          name: 'VND 2',
          accountTypeId: s.accountTypeId,
          initialBalance: 250_000,
          currency: 'VND',
        },
      })
      // A source string unique to this run, so the "nothing was cached"
      // assertion below can name exactly the rows *this* call could have
      // written. `ExchangeRate` is a global table shared with every other
      // suite; counting all of its rows would fail whenever another test
      // happened to leave one behind.
      const uniqueSource = `vnd-only-${randomUUID()}`
      const { provider, callCount } = countingProvider(25_000, uniqueSource)

      const position = await getCurrentPosition(s.userId, 'VND', { providerOverride: provider })

      expect(position.totalBalance.toString()).toBe('1250000')
      // No account needs converting, so the policy is never consulted and the
      // dashboard still renders during a provider outage.
      expect(position.fx).toBeNull()
      expect(callCount()).toBe(0)
      expect(position.accounts.map((a) => a.id).sort()).toEqual([s.vndAccountId, second.id].sort())
      // The provider is the only thing that can populate the cache, so an
      // uncalled provider must leave no row of its own behind.
      expect(await prisma.exchangeRate.count({ where: { source: uniqueSource } })).toBe(0)
    })

    it('converts every foreign-currency balance before summing (the raw-native regression)', async () => {
      const s = await setup()
      const { provider } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', { providerOverride: provider })

      // 1,000,000 VND + (100 USD x 25,000) = 3,500,000 VND. A bug that summed
      // raw native numbers would answer 1,000,100.
      expect(position.totalBalance.toString()).toBe('3500000')
      const usd = position.accounts.find((a) => a.id === s.usdAccountId)
      expect(usd?.nativeBalance.toString()).toBe('100')
      expect(usd?.displayBalance.toString()).toBe('2500000')
      const vnd = position.accounts.find((a) => a.id === s.vndAccountId)
      expect(vnd?.nativeBalance.toString()).toBe('1000000')
      expect(vnd?.displayBalance.toString()).toBe('1000000')
      expect(position.fx?.isFallback).toBe(false)
    })

    it('converts VND into USD when USD is the display currency', async () => {
      const s = await setup()
      const { provider } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'USD', { providerOverride: provider })

      const vnd = position.accounts.find((a) => a.id === s.vndAccountId)
      // 1,000,000 VND / 25,000 = 40 USD — division, not multiplication.
      expect(vnd?.nativeBalance.toString()).toBe('1000000')
      expect(vnd?.displayBalance.toString()).toBe('40')
      expect(position.totalBalance.toString()).toBe('140')
    })

    it('consults the current-rate policy exactly once however many accounts need converting', async () => {
      const s = await setup()
      await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          name: 'USD 2',
          accountTypeId: s.accountTypeId,
          initialBalance: 200,
          currency: 'USD',
        },
      })
      const { provider, callCount } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', { providerOverride: provider })

      // 1,000,000 + 100 x 25,000 + 200 x 25,000
      expect(position.totalBalance.toString()).toBe('8500000')
      expect(callCount()).toBe(1)
    })

    it('degrades to a recent last-known-good rate and says so', async () => {
      const s = await setup()
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await prisma.exchangeRate.create({
        data: {
          base: PAIR.base,
          quote: PAIR.quote,
          rate: new Prisma.Decimal('24000'),
          effectiveDate: twoHoursAgo,
          fetchedAt: twoHoursAgo,
          source: 'seeded',
        },
      })

      const position = await getCurrentPosition(s.userId, 'VND', {
        providerOverride: failingProvider,
      })

      // 1,000,000 + 100 x 24,000
      expect(position.totalBalance.toString()).toBe('3400000')
      expect(position.fx?.isFallback).toBe(true)
      expect(position.fx?.source).toBe('cache-fallback:seeded')
    })

    it('propagates FxUnavailableError when a conversion is needed and no rate exists', async () => {
      const s = await setup()

      await expect(
        getCurrentPosition(s.userId, 'VND', { providerOverride: failingProvider }),
      ).rejects.toThrow(FxUnavailableError)
    })

    it('still answers during an FX outage when no conversion is needed', async () => {
      const s = await setup()
      await prisma.financialAccount.delete({
        where: { userId_id: { userId: s.userId, id: s.usdAccountId } },
      })

      const position = await getCurrentPosition(s.userId, 'VND', {
        providerOverride: failingProvider,
      })

      expect(position.totalBalance.toString()).toBe('1000000')
      expect(position.fx).toBeNull()
    })

    it('excludes archived accounts from the position', async () => {
      const s = await setup()
      const archived = await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          name: 'Closed',
          accountTypeId: s.accountTypeId,
          initialBalance: 0,
          currency: 'VND',
        },
      })
      // Set directly rather than through `archiveFinancialAccount`: this proves
      // the position service itself filters on status.
      await prisma.financialAccount.update({
        where: { userId_id: { userId: s.userId, id: archived.id } },
        data: { status: 'ARCHIVED' },
      })
      const { provider } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', { providerOverride: provider })

      expect(position.accounts.some((a) => a.id === archived.id)).toBe(false)
      expect(position.totalBalance.toString()).toBe('3500000')
    })

    it("never sees another user's accounts", async () => {
      const mine = await setup()
      const theirs = await setup()

      const position = await getCurrentPosition(mine.userId, 'VND', {
        providerOverride: countingProvider().provider,
      })

      expect(position.accounts.map((a) => a.id).sort()).toEqual(
        [mine.vndAccountId, mine.usdAccountId].sort(),
      )
      expect(position.accounts.some((a) => a.id === theirs.vndAccountId)).toBe(false)
    })

    it('answers zero with no accounts and no FX call', async () => {
      const user = await prisma.user.create({
        data: {
          id: randomUUID(),
          email: `test-${randomUUID()}@example.com`,
          name: 'Test',
          emailVerified: false,
        },
      })
      createdUserIds.push(user.id)
      const { provider, callCount } = countingProvider()

      const position = await getCurrentPosition(user.id, 'VND', { providerOverride: provider })

      expect(position.totalBalance.toString()).toBe('0')
      expect(position.accounts).toEqual([])
      expect(position.fx).toBeNull()
      expect(callCount()).toBe(0)
    })

    it('uses a supplied rate and consults no policy at all', async () => {
      const s = await setup()
      const { provider, callCount } = countingProvider()
      // A rate the caller already resolved — a workbook's single FX lookup, say.
      const supplied = suppliedRate('26000.5')

      const position = await getCurrentPosition(s.userId, 'VND', {
        fx: supplied,
        providerOverride: provider,
      })

      // 1,000,000 + 100 x 26,000.5 — the supplied rate, not the provider's.
      expect(position.totalBalance.toString()).toBe('3600050')
      // The provider is never asked: a caller that already holds a rate must
      // not have a second, possibly different, one fetched behind its back.
      expect(callCount()).toBe(0)
      expect(position.fx).toBe(supplied)
    })

    it('refuses a needed conversion when the supplied rate is explicitly null', async () => {
      const s = await setup()
      const { provider, callCount } = countingProvider()

      // `fx: null` is an answer, not an absence: the caller has already been
      // told no usable rate exists, so this must not go looking for one.
      await expect(
        getCurrentPosition(s.userId, 'VND', { fx: null, providerOverride: provider }),
      ).rejects.toThrow(FxUnavailableError)
      expect(callCount()).toBe(0)
    })

    it('answers with a supplied null rate when no conversion is needed', async () => {
      const s = await setup()
      await prisma.financialAccount.delete({
        where: { userId_id: { userId: s.userId, id: s.usdAccountId } },
      })
      const { provider, callCount } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', {
        fx: null,
        providerOverride: provider,
      })

      expect(position.totalBalance.toString()).toBe('1000000')
      expect(position.fx).toBeNull()
      expect(callCount()).toBe(0)
    })

    it('reports no rate for a supplied rate nothing needed converting', async () => {
      const s = await setup()
      await prisma.financialAccount.delete({
        where: { userId_id: { userId: s.userId, id: s.usdAccountId } },
      })
      const supplied = suppliedRate('26000.5')

      const position = await getCurrentPosition(s.userId, 'VND', { fx: supplied })

      // `fx` reports the rate the conversions used, and there were none — the
      // same meaning it carries on the policy path.
      expect(position.fx).toBeNull()
      expect(position.totalBalance.toString()).toBe('1000000')
    })

    it('counts transaction activity, not just opening balances', async () => {
      const s = await setup()
      await prisma.transaction.create({
        data: {
          userId: s.userId,
          accountId: s.vndAccountId,
          type: 'CASH_IN',
          amount: new Prisma.Decimal('500000'),
          currency: 'VND',
          date: new Date('2026-03-15T10:00:00Z'),
          vndPerUsdAtEntry: new Prisma.Decimal('25000'),
          fxRateFetchedAt: new Date(),
          fxRateEffectiveAt: new Date('2026-03-15T00:00:00Z'),
          fxRateSource: 'fixture',
        },
      })
      const { provider } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', { providerOverride: provider })

      // 1,500,000 VND + 100 USD x 25,000
      expect(position.totalBalance.toString()).toBe('4000000')
    })

    it('excludes a future-dated transaction — the position is as of now', async () => {
      const s = await setup()
      const now = new Date()
      await prisma.transaction.create({
        data: {
          userId: s.userId,
          accountId: s.vndAccountId,
          type: 'CASH_IN',
          amount: new Prisma.Decimal('777000'),
          currency: 'VND',
          // Tomorrow: booked, but it has not happened yet.
          date: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          vndPerUsdAtEntry: new Prisma.Decimal('25000'),
          fxRateFetchedAt: now,
          fxRateEffectiveAt: new Date('2026-03-15T00:00:00Z'),
          fxRateSource: 'fixture',
        },
      })
      const { provider } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', {
        providerOverride: provider,
        now,
      })

      // 1,000,000 VND + 100 USD x 25,000 — the 777,000 is still in the future.
      expect(position.totalBalance.toString()).toBe('3500000')
      const vnd = position.accounts.find((a) => a.id === s.vndAccountId)
      expect(vnd?.nativeBalance.toString()).toBe('1000000')
      expect(vnd?.displayBalance.toString()).toBe('1000000')
    })

    it('includes a transaction dated a minute ago', async () => {
      const s = await setup()
      const now = new Date()
      await prisma.transaction.create({
        data: {
          userId: s.userId,
          accountId: s.vndAccountId,
          type: 'CASH_IN',
          amount: new Prisma.Decimal('777000'),
          currency: 'VND',
          date: new Date(now.getTime() - 60 * 1000),
          vndPerUsdAtEntry: new Prisma.Decimal('25000'),
          fxRateFetchedAt: now,
          fxRateEffectiveAt: new Date('2026-03-15T00:00:00Z'),
          fxRateSource: 'fixture',
        },
      })
      const { provider } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', {
        providerOverride: provider,
        now,
      })

      // 1,777,000 VND + 100 USD x 25,000
      expect(position.totalBalance.toString()).toBe('4277000')
    })
  })

  /**
   * Net Worth = account assets + active receivables − active payables − active
   * outstanding loan principal (spec §5.4), every component converted at the
   * SAME single current rate.
   *
   * Each case here is about one term of that formula, so a sign error or a
   * missing exclusion shows up as one failing case rather than as a wrong total
   * nobody can attribute.
   */
  describe('Net Worth beyond the accounts', () => {
    /** The all-VND account side every case below starts from: one account
     *  holding 1,000,000 VND, so nothing on the account side needs a rate and
     *  any FX call the assertions see was provoked by a debt or a loan. */
    async function vndAccountsOnly() {
      const s = await setup()
      await prisma.financialAccount.delete({
        where: { userId_id: { userId: s.userId, id: s.usdAccountId } },
      })
      return s
    }

    it('adds an active receivable to the account total', async () => {
      const s = await vndAccountsOnly()
      await seedDebt(s.userId, {
        direction: 'RECEIVABLE',
        originalAmount: '2000000',
      })
      const { provider, callCount } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', { providerOverride: provider })

      expect(position.totalBalance.toString()).toBe('1000000')
      expect(position.receivables.toString()).toBe('2000000')
      expect(position.payables.toString()).toBe('0')
      expect(position.loanOutstanding.toString()).toBe('0')
      expect(position.netWorth.toString()).toBe('3000000')
      // A VND debt under a VND dashboard needs no rate at all.
      expect(position.fx).toBeNull()
      expect(callCount()).toBe(0)
    })

    it('subtracts an active payable, and counts only what is still owed on it', async () => {
      const s = await vndAccountsOnly()
      // 800,000 borrowed, 300,000 already repaid — 500,000 is the liability.
      await seedDebt(s.userId, {
        direction: 'PAYABLE',
        originalAmount: '800000',
        paid: '300000',
      })

      const position = await getCurrentPosition(s.userId, 'VND', {
        providerOverride: countingProvider().provider,
      })

      expect(position.payables.toString()).toBe('500000')
      expect(position.receivables.toString()).toBe('0')
      expect(position.netWorth.toString()).toBe('500000')
    })

    it('subtracts the loan principal still outstanding — interest paid changes nothing', async () => {
      const s = await vndAccountsOnly()
      await seedLoan(s.userId, {
        principal: '1000000',
        principalPaid: '300000',
        // Interest is the cost of borrowing, not a repayment of it: counting it
        // here would report 650,000 outstanding and a Net Worth 50,000 too high.
        interestPaid: '50000',
      })

      const position = await getCurrentPosition(s.userId, 'VND', {
        providerOverride: countingProvider().provider,
      })

      expect(position.loanOutstanding.toString()).toBe('700000')
      expect(position.netWorth.toString()).toBe('300000')
    })

    it('excludes a written-off debt and a closed loan — neither is a position any more', async () => {
      const s = await vndAccountsOnly()
      await seedDebt(s.userId, {
        direction: 'RECEIVABLE',
        originalAmount: '9000000',
        status: 'WRITTEN_OFF',
      })
      await seedDebt(s.userId, {
        direction: 'PAYABLE',
        originalAmount: '7000000',
        status: 'WRITTEN_OFF',
      })
      await seedLoan(s.userId, { principal: '5000000', status: 'CLOSED' })

      const position = await getCurrentPosition(s.userId, 'VND', {
        providerOverride: countingProvider().provider,
      })

      expect(position.receivables.toString()).toBe('0')
      expect(position.payables.toString()).toBe('0')
      expect(position.loanOutstanding.toString()).toBe('0')
      expect(position.netWorth.toString()).toBe(position.totalBalance.toString())
    })

    it('excludes a settled foreign debt by value, without going looking for a rate', async () => {
      const s = await vndAccountsOnly()
      // ACTIVE, in USD, and fully repaid: it contributes nothing, so no
      // conversion is required — the predicate that skips it is the same one
      // that decides whether a rate is needed at all.
      await seedDebt(s.userId, {
        direction: 'RECEIVABLE',
        originalAmount: '100',
        currency: 'USD',
        paid: '100',
      })
      const { provider, callCount } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', { providerOverride: provider })

      expect(position.receivables.toString()).toBe('0')
      expect(position.netWorth.toString()).toBe('1000000')
      expect(position.fx).toBeNull()
      expect(callCount()).toBe(0)
    })

    it('converts a foreign debt and loan at one rate even when every account is already in the display currency', async () => {
      const s = await vndAccountsOnly()
      await seedDebt(s.userId, {
        direction: 'RECEIVABLE',
        originalAmount: '100',
        currency: 'USD',
      })
      await seedLoan(s.userId, { principal: '200', currency: 'USD' })
      const { provider, callCount } = countingProvider(25_000)

      const position = await getCurrentPosition(s.userId, 'VND', { providerOverride: provider })

      // 100 USD x 25,000 and 200 USD x 25,000 — never 100 and 200 summed raw
      // beside a million dong.
      expect(position.receivables.toString()).toBe('2500000')
      expect(position.loanOutstanding.toString()).toBe('5000000')
      expect(position.totalBalance.toString()).toBe('1000000')
      // 1,000,000 + 2,500,000 − 5,000,000: a genuinely negative Net Worth,
      // reported rather than clamped.
      expect(position.netWorth.toString()).toBe('-1500000')
      // The account side needed nothing, so this rate exists *because* of the
      // debt and the loan — and it was resolved exactly once for both.
      expect(position.fx?.isFallback).toBe(false)
      expect(callCount()).toBe(1)
    })

    it('consults the current-rate policy exactly once for the accounts, the debts and the loans together', async () => {
      const s = await setup()
      await seedDebt(s.userId, {
        direction: 'RECEIVABLE',
        originalAmount: '100',
        currency: 'USD',
      })
      await seedDebt(s.userId, { direction: 'PAYABLE', originalAmount: '40', currency: 'USD' })
      await seedLoan(s.userId, { principal: '200', currency: 'USD' })
      const { provider, callCount } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', { providerOverride: provider })

      // 1,000,000 + 100 USD of accounts, then +100 USD −40 USD −200 USD of
      // agreements, all at 25,000: 3,500,000 + 2,500,000 − 1,000,000 − 5,000,000.
      expect(position.totalBalance.toString()).toBe('3500000')
      expect(position.netWorth.toString()).toBe('0')
      // Five foreign records, one rate: the position may never make a lookup
      // per row.
      expect(callCount()).toBe(1)
    })

    it('propagates FxUnavailableError when a debt is the only thing that needs converting', async () => {
      const s = await vndAccountsOnly()
      await seedDebt(s.userId, {
        direction: 'PAYABLE',
        originalAmount: '100',
        currency: 'USD',
      })

      // No honest figure exists, so the position refuses rather than reporting
      // a Net Worth that quietly ignores the payable.
      await expect(
        getCurrentPosition(s.userId, 'VND', { providerOverride: failingProvider }),
      ).rejects.toThrow(FxUnavailableError)
    })

    it('never touches FX when the accounts, debts and loans are all in the display currency', async () => {
      const s = await vndAccountsOnly()
      await seedDebt(s.userId, { direction: 'RECEIVABLE', originalAmount: '2000000' })
      await seedDebt(s.userId, { direction: 'PAYABLE', originalAmount: '500000' })
      await seedLoan(s.userId, { principal: '1000000' })
      const { provider, callCount } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', { providerOverride: provider })

      // 1,000,000 + 2,000,000 − 500,000 − 1,000,000
      expect(position.netWorth.toString()).toBe('1500000')
      expect(position.fx).toBeNull()
      expect(callCount()).toBe(0)
    })

    it("never counts another user's debts or loans", async () => {
      const mine = await vndAccountsOnly()
      const theirs = await setupWithoutAccounts()
      await seedDebt(theirs.userId, {
        direction: 'RECEIVABLE',
        originalAmount: '9000000',
      })
      await seedLoan(theirs.userId, { principal: '9000000' })

      const position = await getCurrentPosition(mine.userId, 'VND', {
        providerOverride: countingProvider().provider,
      })

      expect(position.receivables.toString()).toBe('0')
      expect(position.loanOutstanding.toString()).toBe('0')
      expect(position.netWorth.toString()).toBe('1000000')
    })
  })

  describe('getNetWorth', () => {
    it('equals the total account balance when there is nothing owed either way', async () => {
      const s = await setup()

      const netWorth = await getNetWorth(s.userId, 'VND', {
        providerOverride: countingProvider().provider,
      })
      const total = await getTotalAccountBalance(s.userId, 'VND', {
        providerOverride: countingProvider().provider,
      })

      expect(netWorth.toString()).toBe('3500000')
      expect(netWorth.toString()).toBe(total.toString())
    })

    it("returns exactly the position's netWorth once debts and loans exist", async () => {
      const s = await setup()
      await prisma.financialAccount.delete({
        where: { userId_id: { userId: s.userId, id: s.usdAccountId } },
      })
      await seedDebt(s.userId, { direction: 'RECEIVABLE', originalAmount: '2000000' })
      await seedDebt(s.userId, { direction: 'PAYABLE', originalAmount: '500000' })
      await seedLoan(s.userId, { principal: '1000000' })

      const netWorth = await getNetWorth(s.userId, 'VND', {
        providerOverride: countingProvider().provider,
      })
      const position = await getCurrentPosition(s.userId, 'VND', {
        providerOverride: countingProvider().provider,
      })

      // The wrapper is a projection, not a second definition: it may never
      // compute a figure of its own.
      expect(netWorth.toString()).toBe(position.netWorth.toString())
      expect(netWorth.toString()).toBe('1500000')
    })
  })

  describe('getAccountDistribution', () => {
    it('returns per-account Decimals converted into the display currency', async () => {
      const s = await setup()

      const distribution = await getAccountDistribution(s.userId, 'VND', {
        providerOverride: countingProvider().provider,
      })

      const vnd = distribution.find((d) => d.name === 'VND')
      const usd = distribution.find((d) => d.name === 'USD')
      expect(vnd?.displayBalance.toString()).toBe('1000000')
      // The regression the plan describes: 100, not 2,500,000, would be the
      // number a native-comparison bug charted here.
      expect(usd?.displayBalance.toString()).toBe('2500000')
      expect(usd?.nativeBalance.toString()).toBe('100')
      expect(usd?.currency).toBe('USD')
      for (const entry of distribution) {
        expect(entry.displayBalance).toBeInstanceOf(Prisma.Decimal)
        expect(entry.nativeBalance).toBeInstanceOf(Prisma.Decimal)
      }
    })
  })
})
