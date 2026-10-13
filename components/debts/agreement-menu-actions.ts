import type { RowAction } from '@/components/common/row-actions-menu'

/**
 * What a debt's or a loan's `…` menu offers — the pure half of `DebtRowMenu`
 * and `LoanRowMenu`, which build the same menu over their own copy and
 * actions. Kept out of the components so the rule can be unit-tested (a closed
 * Base UI menu renders no items into static markup), and shared, like
 * `DebtAccountField`, because the two menus differ only in their words.
 *
 * - **Edit** and the **finishing action** (write off / close loan) only on a
 *   live agreement: a finished one refuses every write to its terms or its
 *   history.
 * - Exactly one of **Record in an account** (spec 2026-10-12 §6.4) and **Remove
 *   from account** (its undo, final review F1), whatever the status: which
 *   account the money moved through is a correction a finished agreement still
 *   accepts, and recording it in the wrong one must stay reversible. So the
 *   menu is never empty.
 *
 * Remove from account deletes transactions, so it reads as destructive, like
 * the finishing action.
 */
export function agreementMenuActions(
  { active, linked }: { active: boolean; linked: boolean },
  items: { edit: RowAction; link: RowAction; unlink: RowAction; finish: RowAction },
): RowAction[] {
  return [
    ...(active ? [items.edit] : []),
    linked ? { ...items.unlink, tone: 'negative' as const } : items.link,
    ...(active ? [items.finish] : []),
  ]
}
