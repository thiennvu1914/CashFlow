import { requireUserOrRedirect } from '@/lib/auth/require-user'

/**
 * Placeholder between the shell landing and the real dashboard: the Phase 1
 * link list has served its purpose now that the shell navigates, and the KPIs,
 * FX status and widgets arrive in the next commit.
 */
export default async function DashboardPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own.
  await requireUserOrRedirect()

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
    </div>
  )
}
