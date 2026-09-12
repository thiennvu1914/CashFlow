import { beforeEach, expect, it, vi } from 'vitest'
import { FxUnavailableError } from '@/lib/currency/current-rate-policy'
import { getDashboardData } from './dashboard'

const reads = vi.hoisted(() => ({
  state: vi.fn(),
  history: vi.fn(),
  position: vi.fn(),
  monthly: vi.fn(),
  trend: vi.fn(),
  budgets: vi.fn(),
  goals: vi.fn(),
  occurrences: vi.fn(),
  recent: vi.fn(),
}))
vi.mock('./account-balance-history', () => ({
  loadBalanceHistory: reads.state,
  getAccountBalanceOverTime: reads.history,
}))
vi.mock('./position', () => ({ getCurrentPosition: reads.position }))
vi.mock('./activity', () => ({ getActivitySummary: reads.monthly, getCashFlowTrend: reads.trend }))
vi.mock('./budget', () => ({ getBudgetProgressForMonth: reads.budgets }))
vi.mock('./savings-goal', () => ({ listSavingsGoals: reads.goals }))
vi.mock('./reminder', () => ({ listDashboardOccurrences: reads.occurrences }))
vi.mock('./transaction', () => ({ listTransactions: reads.recent }))

beforeEach(() => vi.resetAllMocks())

it.each([false, true])(
  'orders history after current FX finishes (outage: %s), without blocking unrelated widgets',
  async (outage) => {
    const now = new Date('2026-09-12T12:00:00Z')
    const balances = new Map()
    const state = {
      userId: 'owner',
      accounts: [],
      cutoffs: [now],
      timeline: { balances: [balances] },
    }
    reads.state.mockResolvedValue(state)
    reads.history.mockResolvedValue([])
    let finish!: () => void
    reads.position.mockReturnValue(
      new Promise((resolve, reject) => {
        finish = () =>
          outage ? reject(new FxUnavailableError()) : resolve({ fx: 'resolved-current-rate' })
      }),
    )
    const result = getDashboardData('owner', 'Asia/Ho_Chi_Minh', 'VND', now, {
      months: 1,
      transactions: 8,
      occurrences: { overdue: 2, upcoming: 5 },
    })
    await vi.waitFor(() => expect(reads.position).toHaveBeenCalledTimes(1))
    for (const read of [
      reads.monthly,
      reads.trend,
      reads.budgets,
      reads.goals,
      reads.occurrences,
      reads.recent,
    ]) {
      expect(read).toHaveBeenCalledTimes(1)
    }
    expect(reads.history).not.toHaveBeenCalled()
    expect(reads.position).toHaveBeenCalledWith('owner', 'VND', {
      now,
      accountState: { userId: 'owner', asOf: now, accounts: state.accounts, balances },
    })
    finish()
    const resolved = await result
    expect(resolved.position).toEqual(outage ? null : { fx: 'resolved-current-rate' })
    expect(reads.history).toHaveBeenCalledWith(
      'owner',
      'Asia/Ho_Chi_Minh',
      'VND',
      1,
      undefined,
      now,
      state,
    )
  },
)
