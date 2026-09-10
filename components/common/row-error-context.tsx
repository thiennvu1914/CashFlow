'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import { InlineAlert } from './inline-alert'

/**
 * Shares one `PlanningRow`'s action-error message between whatever SETS it
 * (a row's `…` menu, on a failed delete/archive) and whatever DISPLAYS it
 * (`RowErrorAlert`, rendered under the row via `PlanningRow`'s `extra` slot) —
 * fix round 1, finding 6.
 *
 * The two live in different `PlanningRow` slots (`actions` vs `extra`), and
 * the row list itself (`BudgetProgressList`/`GoalList`) is a server component
 * sitting between them, so a plain per-component `useState` inside the menu
 * component cannot reach the alert. A Context works across that gap because
 * Context lookup follows the MOUNTED FIBRE TREE, not the client/server
 * authoring boundary: a Client Component may receive already-rendered
 * children (including further Server Components) and wrap them in a
 * Provider, and any Client Component descendant further down — wherever it
 * was authored — still resolves the nearest Provider correctly. This is the
 * standard Next.js "share state across a Server/Client boundary via a
 * Context Provider" pattern, not a workaround.
 *
 * Deliberately narrow: this is for the ONE case in this app where a
 * destructive confirmation closes on failure and must still explain why
 * (`ConfirmDialog`'s own doc comment gives the reasoning) — every other
 * form's error renders inside its own Dialog via a local `useState`, which
 * needs no sharing at all and is left exactly as it was.
 */

interface RowErrorContextValue {
  error: string | null
  setError: (message: string | null) => void
}

const RowErrorContext = createContext<RowErrorContextValue | null>(null)

export function RowErrorProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null)
  return <RowErrorContext.Provider value={{ error, setError }}>{children}</RowErrorContext.Provider>
}

export function useRowError(): RowErrorContextValue {
  const ctx = useContext(RowErrorContext)
  if (!ctx) {
    throw new Error('useRowError must be called from inside a RowErrorProvider')
  }
  return ctx
}

/** Pass as `PlanningRow`'s `extra` — renders the shared error, if any, full
 *  width under the row rather than squeezed inside the actions cell. */
export function RowErrorAlert() {
  const { error } = useRowError()
  if (!error) return null
  return (
    <InlineAlert tone="negative" className="mt-1">
      {error}
    </InlineAlert>
  )
}
