/**
 * Which ledger rows are visible while a delete is in flight — the pure half of
 * `TransactionList`'s optimistic delete, kept out of the component so the
 * success, failure and refused-while-busy cases can be unit-tested in a repo
 * with no DOM environment.
 *
 * Two independent reasons a row is hidden:
 *
 *  - `acceptedIds`: the server ACCEPTED the delete. Permanent for the list's
 *    lifetime (ids are never reused), because the optimistic value below
 *    reverts the moment the action's transition ends while the
 *    `revalidatePath`-driven props can commit a beat later; without this the
 *    row would flash back in that gap.
 *  - the optimistic hide (`withoutRow`, the `useOptimistic` reducer): the user
 *    has confirmed and the server has not answered yet. It is TRANSIENT — React
 *    drops it when the transition ends, which is exactly what restores the row
 *    when the action is refused or throws.
 */
export function withoutAccepted<T extends { id: string }>(
  rows: readonly T[],
  acceptedIds: ReadonlySet<string>,
): T[] {
  return rows.filter((row) => !acceptedIds.has(row.id))
}

export function withoutRow<T extends { id: string }>(rows: readonly T[], hiddenId: string): T[] {
  return rows.filter((row) => row.id !== hiddenId)
}
