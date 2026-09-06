import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildDashboardViewModel, type DashboardInput } from './dashboard-view-model'

/**
 * Pure mapping — no database, no session, no renderer. Every input below is a
 * literal stand-in for what the services return, so these cases pin the two
 * things the page itself cannot easily be tested on: what the dashboard says
 * when FX is unavailable, and that nothing historical changes when it is.
 */

const HCMC = 'Asia/Ho_Chi_Minh'
const NOW = new Date('2026-09-15T10:00:00Z')

function decimal(value: string) {
  return new Prisma.Decimal(value)
}

/** September 2026 in Ho Chi Minh City: [31 Aug 17:00Z, 30 Sep 17:00Z). */
const SEPTEMBER = {
  startUtc: new Date('2026-08-31T17:00:00Z'),
  endUtc: new Date('2026-09-30T17:00:00Z'),
}
const AUGUST = {
  startUtc: new Date('2026-07-31T17:00:00Z'),
  endUtc: new Date('2026-08-31T17:00:00Z'),
}

function makeInput(overrides: Partial<DashboardInput> = {}): DashboardInput {
  return {
    displayCurrency: 'VND',
    timezone: HCMC,
    now: NOW,
    position: {
      totalBalance: decimal('12000000'),
      netWorth: decimal('12000000'),
      accounts: [
        {
          id: 'a1',
          name: 'Wallet',
          currency: 'VND',
          nativeBalance: decimal('2000000'),
          displayBalance: decimal('2000000'),
        },
        {
          id: 'a2',
          name: 'Dollars',
          currency: 'USD',
          nativeBalance: decimal('400'),
          displayBalance: decimal('10000000'),
        },
      ],
      fx: {
        rate: 25000,
        rateDecimal: decimal('25000.000000'),
        effectiveDate: new Date('2026-09-15T00:00:00Z'),
        fetchedAt: new Date('2026-09-15T03:30:00Z'),
        source: 'open-er-api',
        isFallback: false,
      },
    },
    monthly: {
      income: decimal('30000000'),
      expense: decimal('8000000'),
      netIncome: decimal('22000000'),
      ...SEPTEMBER,
      byCategory: [
        { categoryId: 'c1', name: 'Food', total: decimal('5000000') },
        { categoryId: null, name: 'Uncategorized', total: decimal('3000000') },
      ],
      byAccount: [
        {
          accountId: 'a1',
          name: 'Wallet',
          income: decimal('30000000'),
          expense: decimal('8000000'),
          netIncome: decimal('22000000'),
        },
      ],
    },
    cashFlowTrend: [
      {
        month: '2026-08',
        ...AUGUST,
        income: decimal('20000000'),
        expense: decimal('25000000'),
        netIncome: decimal('-5000000'),
      },
      {
        month: '2026-09',
        ...SEPTEMBER,
        income: decimal('30000000'),
        expense: decimal('8000000'),
        netIncome: decimal('22000000'),
      },
    ],
    balanceOverTime: [
      { month: '2026-08', asOf: new Date('2026-08-31T16:59:59.999Z'), balance: null },
      { month: '2026-09', asOf: NOW, balance: decimal('12000000') },
    ],
    recentTransactions: [
      {
        id: 't1',
        type: 'EXPENSE',
        amount: decimal('250000'),
        currency: 'VND',
        date: new Date('2026-09-14T02:15:00Z'),
        note: null,
        fxRateSource: 'open-er-api',
        account: { name: 'Wallet' },
        category: { name: 'Food' },
      },
      {
        id: 't2',
        type: 'INCOME',
        amount: decimal('1500.25'),
        currency: 'USD',
        date: new Date('2026-09-13T09:00:00Z'),
        note: null,
        fxRateSource: 'open-er-api',
        account: { name: 'Dollars' },
        category: null,
      },
    ],
    ...overrides,
  }
}

describe('buildDashboardViewModel', () => {
  it('labels the page with the current local month and the display currency', () => {
    const vm = buildDashboardViewModel(makeInput())

    expect(vm.monthLabel).toBe('September 2026')
    expect(vm.subtitle).toBe('September 2026 · VND')
  })

  it('reports all five KPIs, in order, with "Net Income" as the fifth label', () => {
    const vm = buildDashboardViewModel(makeInput())

    expect(vm.kpis.map((k) => [k.label, k.value])).toEqual([
      ['Total Account Balance', '12.000.000'],
      ['Net Worth', '12.000.000'],
      ['Monthly Income', '30.000.000'],
      ['Monthly Expense', '8.000.000'],
      ['Net Income', '22.000.000'],
    ])
    expect(vm.kpis.every((k) => k.negative === false)).toBe(true)
  })

  it('marks a negative Net Income, and never marks the expense magnitude', () => {
    const input = makeInput()
    const vm = buildDashboardViewModel({
      ...input,
      monthly: { ...input.monthly, netIncome: decimal('-4000000') },
    })

    const byLabel = new Map(vm.kpis.map((k) => [k.label, k]))
    expect(byLabel.get('Net Income')).toMatchObject({ value: '-4.000.000', negative: true })
    expect(byLabel.get('Monthly Expense')?.negative).toBe(false)
  })

  describe('when the current position is unavailable', () => {
    const vm = buildDashboardViewModel(makeInput({ position: null }))

    it('withholds the two converted KPIs and says why', () => {
      const byLabel = new Map(vm.kpis.map((k) => [k.label, k]))
      expect(byLabel.get('Total Account Balance')).toEqual({
        label: 'Total Account Balance',
        value: null,
        hint: 'FX unavailable',
        negative: false,
      })
      expect(byLabel.get('Net Worth')?.value).toBeNull()
    })

    it('reports the FX status as unavailable and hides the distribution', () => {
      expect(vm.fxStatus).toEqual({ kind: 'unavailable' })
      expect(vm.distribution).toBeNull()
    })

    it('leaves every historical figure exactly as it was — FX cannot reach them', () => {
      const withFx = buildDashboardViewModel(makeInput())
      expect(vm.kpis.slice(2)).toEqual(withFx.kpis.slice(2))
      expect(vm.cashFlowTrend).toEqual(withFx.cashFlowTrend)
      expect(vm.expenseByCategory).toEqual(withFx.expenseByCategory)
      expect(vm.balanceOverTime).toEqual(withFx.balanceOverTime)
      expect(vm.recentTransactions).toEqual(withFx.recentTransactions)
    })
  })

  it('reports a live rate with its effective day and our fetch time', () => {
    const vm = buildDashboardViewModel(makeInput())

    expect(vm.fxStatus).toEqual({
      kind: 'available',
      rate: '25.000',
      effectiveDate: '2026-09-15',
      // 03:30Z is 10:30 in Ho Chi Minh City — the user's clock, not the server's.
      updatedAt: '2026-09-15 10:30',
    })
  })

  it('flags a cached fallback rate as such, keeping the original rate’s own dates', () => {
    const input = makeInput()
    const position = input.position
    if (!position?.fx) throw new Error('fixture must carry an fx result')
    const vm = buildDashboardViewModel({
      ...input,
      position: { ...position, fx: { ...position.fx, isFallback: true } },
    })

    expect(vm.fxStatus).toMatchObject({ kind: 'fallback', rate: '25.000' })
  })

  it('says no conversion was needed when nothing had to be converted', () => {
    const input = makeInput()
    const position = input.position
    if (!position) throw new Error('fixture must carry a position')
    const vm = buildDashboardViewModel({ ...input, position: { ...position, fx: null } })

    expect(vm.fxStatus).toEqual({ kind: 'not-needed' })
  })

  it('keeps a missing balance point as a gap rather than a zero', () => {
    const vm = buildDashboardViewModel(makeInput())

    expect(vm.balanceOverTime).toEqual([
      { label: 'Aug', balance: null },
      { label: 'Sep', balance: 12000000 },
    ])
  })

  it('compares the previous month against this one, by name', () => {
    const vm = buildDashboardViewModel(makeInput())

    expect(vm.incomeVsExpense).toEqual([
      { period: 'Aug 2026', income: 20000000, expense: 25000000 },
      { period: 'Sep 2026', income: 30000000, expense: 8000000 },
    ])
  })

  it('derives the comparison from the trend’s last two points, never a separate scan', () => {
    const input = makeInput()
    const july = {
      month: '2026-07',
      startUtc: new Date('2026-06-30T17:00:00Z'),
      endUtc: new Date('2026-07-31T17:00:00Z'),
      income: decimal('1'),
      expense: decimal('2'),
      netIncome: decimal('-1'),
    }
    const vm = buildDashboardViewModel({
      ...input,
      cashFlowTrend: [july, ...input.cashFlowTrend],
    })

    // Three points in, two bars out — the *last* two, and July is not one of them.
    expect(vm.cashFlowTrend).toHaveLength(3)
    expect(vm.incomeVsExpense).toEqual([
      { period: 'Aug 2026', income: 20000000, expense: 25000000 },
      { period: 'Sep 2026', income: 30000000, expense: 8000000 },
    ])
    // The comparison's right-hand bar and the trend's final point are the same
    // window, so they cannot disagree.
    const last = vm.incomeVsExpense.at(-1)
    expect(last?.income).toBe(vm.cashFlowTrend.at(-1)?.income)
    expect(last?.expense).toBe(vm.cashFlowTrend.at(-1)?.expense)
  })

  it('shows a single bar when only one month of trend exists', () => {
    const input = makeInput()
    const vm = buildDashboardViewModel({ ...input, cashFlowTrend: input.cashFlowTrend.slice(-1) })

    // One point, one bar — never an invented zero month beside it.
    expect(vm.incomeVsExpense).toEqual([{ period: 'Sep 2026', income: 30000000, expense: 8000000 }])
  })

  it('takes Expense by Category from the same month aggregate as the KPIs', () => {
    const input = makeInput()
    const vm = buildDashboardViewModel({
      ...input,
      monthly: {
        ...input.monthly,
        expense: decimal('9000000'),
        byCategory: [
          { categoryId: 'c2', name: 'Rent', total: decimal('6000000') },
          { categoryId: 'c1', name: 'Food', total: decimal('3000000') },
        ],
      },
    })

    expect(vm.expenseByCategory).toEqual([
      { name: 'Rent', value: 6000000 },
      { name: 'Food', value: 3000000 },
    ])
    // One scan, so the slices add up to the card above them.
    const sliceTotal = vm.expenseByCategory.reduce((sum, slice) => sum + slice.value, 0)
    expect(sliceTotal).toBe(9000000)
  })

  it('orders the distribution largest first, using converted balances', () => {
    const vm = buildDashboardViewModel(makeInput())

    expect(vm.distribution).toEqual([
      { name: 'Dollars', value: 10000000 },
      { name: 'Wallet', value: 2000000 },
    ])
  })

  it('signs recent transactions from their type and shows each in its own currency', () => {
    const vm = buildDashboardViewModel(makeInput())

    expect(vm.recentTransactions).toEqual([
      {
        id: 't1',
        title: 'Food',
        accountName: 'Wallet',
        when: '2026-09-14 09:15',
        amount: '−250.000',
        currency: 'VND',
        positive: false,
      },
      {
        id: 't2',
        // No category on this row, so the type stands in for one.
        title: 'INCOME',
        accountName: 'Dollars',
        when: '2026-09-13 16:00',
        amount: '+1.500,25',
        currency: 'USD',
        positive: true,
      },
    ])
  })
})
