'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

/**
 * The error boundary for every signed-in page.
 *
 * Next renders this in place of the page when a server component throws — an
 * FX fault the dashboard deliberately did *not* swallow, a database blip, a
 * genuine bug. It replaces a blank screen or a stack trace with a sentence and
 * a way forward.
 *
 * **`retry`, not `reset`** (Next 16 — see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`).
 * The boundary is handed both, and they are not interchangeable: `reset` only
 * clears the boundary's error state, so the same already-failed server payload
 * re-renders and fails again — a Retry button that visibly does nothing.
 * `retry` wraps `router.refresh()` and the reset in a transition, which
 * re-fetches the segment from the server. Everything here fails on the server,
 * so refetching is the only thing that can recover.
 *
 * Nothing about `error` is rendered or logged. Its `message` is English written
 * for developers, and on this application's pages it can carry account names,
 * balances or provider details — none of which belongs on a user's screen or in
 * a log line. (Next already withholds it in production, replacing it with a
 * `digest`; this component does not rely on that.) The fixed string below is
 * all that is recorded, and the server-side log carries the real error.
 */
export default function AppError({ retry }: { error: unknown; retry: () => void }) {
  // In an effect, not the render body: rendering must stay free of side
  // effects, and a double render would otherwise log twice.
  useEffect(() => {
    console.error('An app route failed to render')
  }, [])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Something went wrong loading this page.</h1>
        <p className="text-sm text-muted-foreground">
          Your data has not been changed. Try again in a moment.
        </p>
      </div>
      <Button type="button" onClick={() => retry()}>
        Retry
      </Button>
    </div>
  )
}
