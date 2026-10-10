/**
 * What the ledger shows while a delete is in flight — the pure half of
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
 *  - the optimistic hide (`hideDeletedRow`, the `useOptimistic` reducer): the
 *    user has confirmed and the server has not answered yet. It is TRANSIENT —
 *    React drops it when the transition ends, which is exactly what restores
 *    the row when the action is refused or throws.
 */
export interface LedgerView<T> {
  rows: T[]
  /**
   * A delete is in flight, so every row's delete item is disabled. The list
   * runs one delete at a time (`submit.run` refuses a second while one is
   * pending), and its dialog closes the moment the user confirms — so without
   * this, a second delete confirmed meanwhile would be refused without a word.
   * Set by the same optimistic update that hides the row, so the two can never
   * disagree and both revert together when the transition ends.
   */
  deleteInFlight: boolean
}

/** The ledger with nothing in flight: the server's rows minus accepted deletes. */
export function settledLedger<T extends { id: string }>(
  rows: readonly T[],
  acceptedIds: ReadonlySet<string>,
): LedgerView<T> {
  return { rows: rows.filter((row) => !acceptedIds.has(row.id)), deleteInFlight: false }
}

/** The `useOptimistic` reducer: the confirmed row disappears and every delete locks. */
export function hideDeletedRow<T extends { id: string }>(
  ledger: LedgerView<T>,
  hiddenId: string,
): LedgerView<T> {
  return { rows: ledger.rows.filter((row) => row.id !== hiddenId), deleteInFlight: true }
}
