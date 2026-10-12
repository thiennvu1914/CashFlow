import { describe, expect, it, vi } from 'vitest'
import type { TransactionLink } from '@/lib/server/services/transaction-links'
import { transactionRowActions, type TransactionRowActionHandlers } from './transaction-row-actions'

/**
 * The row menu's contents (money-source linking spec 2026-10-12 §2 Q4, §6.5),
 * as a pure function: a closed Base UI menu renders no items into static
 * markup, and this repo has no DOM environment, so the rule itself is pinned
 * here and the open menu is covered by `e2e/phase7-transactions.spec.ts`.
 */

const LABELS = {
  edit: 'Sửa giao dịch',
  delete: 'Xóa giao dịch',
  openDebt: 'Mở khoản nợ',
  openLoan: 'Mở khoản vay',
}

const DEBT: TransactionLink = { kind: 'debt', debtId: 'debt_1', person: 'Minh' }
const LOAN: TransactionLink = { kind: 'loan', loanId: 'loan_1', lender: 'Vietcombank' }

function handlers(): TransactionRowActionHandlers<{ id: string; link: TransactionLink | null }> {
  return { onEdit: vi.fn(), onDelete: vi.fn(), onOpenSource: vi.fn() }
}

describe('transactionRowActions', () => {
  it('offers Edit, then a negative-toned Delete, on an ordinary row', () => {
    const row = { id: 'tx_1', link: null }
    const h = handlers()

    const actions = transactionRowActions(row, { labels: LABELS, deleteDisabled: false, ...h })

    expect(actions.map(({ id, label, tone, disabled }) => ({ id, label, tone, disabled }))).toEqual(
      [
        { id: 'edit', label: 'Sửa giao dịch', tone: undefined, disabled: undefined },
        { id: 'delete', label: 'Xóa giao dịch', tone: 'negative', disabled: false },
      ],
    )
    actions[0].onSelect()
    expect(h.onEdit).toHaveBeenCalledWith(row)
    actions[1].onSelect()
    expect(h.onDelete).toHaveBeenCalledWith(row)
    expect(h.onOpenSource).not.toHaveBeenCalled()
  })

  it('disables only Delete while another delete is in flight — Edit stays available', () => {
    const actions = transactionRowActions(
      { id: 'tx_1', link: null },
      { labels: LABELS, deleteDisabled: true, ...handlers() },
    )

    expect(actions.find((action) => action.id === 'delete')?.disabled).toBe(true)
    expect(actions.find((action) => action.id === 'edit')?.disabled).toBeUndefined()
  })

  it.each([
    ['debt', DEBT, 'open-debt', 'Mở khoản nợ'],
    ['loan', LOAN, 'open-loan', 'Mở khoản vay'],
  ] as const)(
    'offers only "open the %s" on a row it owns — never Edit or Delete',
    (_kind, link, id, label) => {
      const row = { id: 'tx_1', link }
      const h = handlers()

      for (const deleteDisabled of [false, true]) {
        const actions = transactionRowActions(row, { labels: LABELS, deleteDisabled, ...h })
        expect(actions.map((action) => [action.id, action.label])).toEqual([[id, label]])
      }

      transactionRowActions(row, { labels: LABELS, deleteDisabled: false, ...h })[0].onSelect()
      expect(h.onOpenSource).toHaveBeenCalledWith(link)
      expect(h.onEdit).not.toHaveBeenCalled()
      expect(h.onDelete).not.toHaveBeenCalled()
    },
  )
})
