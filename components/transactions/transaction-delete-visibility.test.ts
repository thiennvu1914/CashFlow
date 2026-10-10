import { describe, expect, it, vi } from 'vitest'
import { createSubmitRunner } from '@/lib/ui/use-submit-state'
import { runActionSubmit, type ActionResult } from '@/lib/ui/use-action-submit'
import { hideDeletedRow, settledLedger, type LedgerView } from './transaction-delete-visibility'

const ROWS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
const ids = (ledger: LedgerView<{ id: string }>) => ledger.rows.map((r) => r.id)

/**
 * Drives the same sequence `TransactionList.confirmDelete` does — hide the row
 * inside the action, then settle — with the real `runActionSubmit` and the real
 * re-entry runner, and models React's `useOptimistic` by dropping the
 * optimistic update when the "transition" (the awaited run) ends.
 */
async function deleteRow(
  id: string,
  result: ActionResult<string>,
  { locked = false, accepted = new Set<string>() } = {},
) {
  const duringFlight: LedgerView<{ id: string }>[] = []
  const run = createSubmitRunner(
    () => locked,
    () => {},
  )
  const onSuccess = vi.fn(() => accepted.add(id))
  await runActionSubmit(run, (k) => k, {
    tag: 'test',
    onError: () => {},
    onSuccess,
    action: async () => {
      // `hideRow(id)`: the optimistic update, applied to the settled ledger.
      duringFlight.push(hideDeletedRow(settledLedger(ROWS, accepted), id))
      return result
    },
  })
  // The transition ended: the optimistic value reverts to the settled ledger.
  return { duringFlight, after: settledLedger(ROWS, accepted), onSuccess }
}

describe('optimistic delete visibility', () => {
  it('hides the row as soon as the delete is in flight', async () => {
    const { duringFlight } = await deleteRow('b', { ok: true })
    expect(duringFlight.map(ids)).toEqual([['a', 'c']])
  })

  it('keeps an accepted delete hidden after the optimistic value has reverted', async () => {
    const { after, onSuccess } = await deleteRow('b', { ok: true })
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(ids(after)).toEqual(['a', 'c'])
  })

  it('shows the row again when the action is refused', async () => {
    const { duringFlight, after, onSuccess } = await deleteRow('b', { ok: false, error: 'x' })
    expect(duringFlight.map(ids)).toEqual([['a', 'c']])
    expect(onSuccess).not.toHaveBeenCalled()
    expect(ids(after)).toEqual(['a', 'b', 'c'])
  })

  it('never hides a row whose delete was refused by the busy lock', async () => {
    // A second delete started while the first is in flight: `run` refuses it
    // before the action runs, so the row must never have been hidden.
    const { duringFlight, after } = await deleteRow('b', { ok: true }, { locked: true })
    expect(duringFlight).toEqual([])
    expect(ids(after)).toEqual(['a', 'b', 'c'])
  })
})

describe('one delete at a time', () => {
  // The dialog closes on confirm, so a second delete refused by the lock would
  // vanish without a word; every row's delete is disabled while one is in
  // flight instead — by the same optimistic update that hides the row, so the
  // two can never disagree and both revert when the transition ends.
  it.each([
    ['accepted', { ok: true } as const],
    ['refused', { ok: false, error: 'x' } as const],
  ])(
    'disables every delete while one is in flight, and enables them once it is %s',
    async (_, result) => {
      const { duringFlight, after } = await deleteRow('b', result)
      expect(duringFlight.map((ledger) => ledger.deleteInFlight)).toEqual([true])
      expect(after.deleteInFlight).toBe(false)
    },
  )

  it('a settled ledger never has a delete in flight', () => {
    expect(settledLedger(ROWS, new Set()).deleteInFlight).toBe(false)
    expect(settledLedger(ROWS, new Set(['a'])).deleteInFlight).toBe(false)
  })
})
