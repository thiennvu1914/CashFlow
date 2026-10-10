import { describe, expect, it, vi } from 'vitest'
import { createSubmitRunner } from '@/lib/ui/use-submit-state'
import { runActionSubmit, type ActionResult } from '@/lib/ui/use-action-submit'
import { withoutAccepted, withoutRow } from './transaction-delete-visibility'

const ROWS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

/**
 * Drives the same sequence `TransactionList.confirmDelete` does — hide the row
 * inside the action, then settle — with the real `runActionSubmit` and the real
 * re-entry runner, and models React's `useOptimistic` by reverting the hide
 * when the "transition" (the awaited run) ends.
 */
async function deleteRow(
  id: string,
  result: ActionResult<string>,
  { locked = false, accepted = new Set<string>() } = {},
) {
  let hidden: string | null = null
  const duringFlight: string[][] = []
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
      hidden = id // `hideRow(id)`
      duringFlight.push(ids(withoutRow(withoutAccepted(ROWS, accepted), hidden)))
      return result
    },
  })
  hidden = null // the transition ended: the optimistic value reverts
  return { duringFlight, after: ids(withoutAccepted(ROWS, accepted)), onSuccess }
}

describe('optimistic delete visibility', () => {
  it('hides the row as soon as the delete is in flight', async () => {
    const { duringFlight } = await deleteRow('b', { ok: true })
    expect(duringFlight).toEqual([['a', 'c']])
  })

  it('keeps an accepted delete hidden after the optimistic value has reverted', async () => {
    const { after, onSuccess } = await deleteRow('b', { ok: true })
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(after).toEqual(['a', 'c'])
  })

  it('shows the row again when the action is refused', async () => {
    const { duringFlight, after, onSuccess } = await deleteRow('b', { ok: false, error: 'x' })
    expect(duringFlight).toEqual([['a', 'c']])
    expect(onSuccess).not.toHaveBeenCalled()
    expect(after).toEqual(['a', 'b', 'c'])
  })

  it('never hides a row whose delete was refused by the busy lock', async () => {
    // A second delete started while the first is in flight: `run` refuses it
    // before the action runs, so the row must never have been hidden.
    const { duringFlight, after } = await deleteRow('b', { ok: true }, { locked: true })
    expect(duringFlight).toEqual([])
    expect(after).toEqual(['a', 'b', 'c'])
  })
})
