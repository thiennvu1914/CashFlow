import type { RowAction } from '@/components/common/row-actions-menu'
import type { TransactionLink } from '@/lib/server/services/transaction-links'

/**
 * What a ledger row's `…` menu offers (money-source linking spec 2026-10-12
 * §2 Q4, §6.5) — the pure half of `TransactionListRow`, kept out of the
 * component so the rule can be unit-tested in a repo with no DOM environment
 * (a closed menu renders no items into static markup).
 *
 * An ordinary row: Edit, then Delete. A row a debt or loan owns: only "open
 * the debt/loan". Its edit or delete would have to change the agreement it
 * records too, so it happens there, where both sides change in one database
 * transaction; offering it here — even disabled — would only invite the
 * `LINKED_TRANSACTION` refusal the services answer with.
 *
 * Only Delete follows `deleteDisabled` (another row's delete is in flight —
 * `LedgerView.deleteInFlight`): the list runs one delete at a time, while an
 * edit is a separate sheet with its own submit lock.
 */
export interface TransactionRowActionHandlers<Row> {
  onEdit: (row: Row) => void
  onDelete: (row: Row) => void
  onOpenSource: (link: TransactionLink) => void
}

export interface TransactionRowActionLabels {
  edit: string
  delete: string
  openDebt: string
  openLoan: string
}

export function transactionRowActions<Row extends { link: TransactionLink | null }>(
  row: Row,
  {
    labels,
    deleteDisabled,
    onEdit,
    onDelete,
    onOpenSource,
  }: TransactionRowActionHandlers<Row> & {
    labels: TransactionRowActionLabels
    deleteDisabled: boolean
  },
): RowAction[] {
  const { link } = row
  if (link) {
    return [
      link.kind === 'debt'
        ? { id: 'open-debt', label: labels.openDebt, onSelect: () => onOpenSource(link) }
        : { id: 'open-loan', label: labels.openLoan, onSelect: () => onOpenSource(link) },
    ]
  }
  return [
    { id: 'edit', label: labels.edit, onSelect: () => onEdit(row) },
    {
      id: 'delete',
      label: labels.delete,
      tone: 'negative',
      onSelect: () => onDelete(row),
      disabled: deleteDisabled,
    },
  ]
}
